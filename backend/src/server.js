// HTTP API from docs/BACKEND_API.md §4 (v1), on node:http. Binds to 127.0.0.1 only.
// Implemented: GET /health, POST /agent/chat, GET /agent/messages, GET /requests, GET /requests/:id,
// POST /approvals/:id/verify, POST /approvals/:id/reject, GET /wallet/status, GET /events (from the indexer tables).
//
// Start: npm start   (uses backend/.env)
import { createServer as createHttpServer } from "node:http";
import { pathToFileURL } from "node:url";
import { formatUnits } from "viem";
import { loadConfig, ConfigError, USDC_DECIMALS } from "./config.js";
import { createReads, assertStartup, StartupError } from "./chain/reads.js";
import { startStore, STATUSES, TransitionError } from "./db/index.js";
import { buildAgent, BusyError, InputError, LlmError, createLlmFromEnv } from "./agent/index.js";
import { buildOwnerApproval, verifyOwnerApproval, createProofs, VerifyError } from "./approvals/index.js";
import { createIndexer, queryEvents, INDEXED_TYPES } from "./events/index.js";

const EXPLORERS = { 84532: "https://sepolia.basescan.org/tx/" };
const MAX_BODY = 16 * 1024;
const amount = (v) => (v === null || v === undefined ? null : { base: v.toString(), mUSDC: formatUnits(v, USDC_DECIMALS) });
const iso = (t) => new Date(Number(t) * 1000).toISOString().replace(".000Z", "Z");

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}

function send(res, status, body, headers = {}) {
  const json = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(json);
}

async function readJson(req) {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(400, "INVALID_INPUT", "Content-Type must be application/json");
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(400, "INVALID_INPUT", "Body is larger than 16 KB");
    chunks.push(c);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, "INVALID_INPUT", "Body must be a JSON object");
  }
}

const intParam = (v, { min, max, def }) => {
  if (v === null || v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new HttpError(400, "INVALID_INPUT", `must be an integer from ${min} to ${max}`);
  return n;
};

/** deps: { config, reads, store, agent, env, llmMode, proofs?, indexer? } */
export function createApp({ config, reads, store, agent, env = process.env, llmMode = "fallback", proofs = createProofs({ config, reads }), indexer = null }) {
  const a = config.addresses;
  const minDeposit = BigInt(env.MIN_DEPOSIT_WEI || "1000000000000000");
  const minSubmitter = BigInt(env.MIN_SUBMITTER_WEI || "1000000000000000");
  const explorerUrl = (tx) => (tx && EXPLORERS[config.chainId] ? EXPLORERS[config.chainId] + tx : null);

  function requestView(r) {
    return {
      id: r.id,
      status: r.status,
      path: r.path,
      precheck: r.precheck,
      credits: r.credits,
      reason: r.reason,
      price: amount(r.price),
      amountPaid: amount(r.amountPaid),
      purchaseId: r.purchaseId === null ? null : r.purchaseId.toString(),
      agent: r.agent,
      nonce: r.nonce === null ? null : r.nonce.toString(),
      userOpHash: r.userOpHash,
      txHash: r.txHash,
      blockNumber: r.blockNumber,
      actualGasCost: r.actualGasCost === null ? null : r.actualGasCost.toString(),
      error: r.errorCode ? { code: r.errorCode, message: r.errorText } : null,
      explorerUrl: explorerUrl(r.txHash),
      conversationId: r.conversationId,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  async function walletStatus() {
    const s = await reads.snapshot();
    const [block, submitterEth] = await Promise.all([reads.client.getBlock({ blockNumber: s.blockNumber }), reads.client.getBalance({ address: config.submitter.address })]);
    const now = Number(block.timestamp);
    const warnings = [];
    if (!s.agent.validNow) warnings.push("AGENT_NOT_VALID");
    if (s.agent.validNow && Number(s.agent.validUntil) - now < 86_400) warnings.push("AGENT_EXPIRES_SOON");
    if (s.wallet.entryPointDeposit < minDeposit) warnings.push("DEPOSIT_LOW");
    if (s.wallet.merchantAllowance < s.agent.maxPerTx) warnings.push("ALLOWANCE_LOW");
    if (s.wallet.balance < s.agent.maxPerTx) warnings.push("BALANCE_LOW");
    if (submitterEth < minSubmitter) warnings.push("SUBMITTER_LOW");
    return {
      chainId: config.chainId,
      blockNumber: Number(s.blockNumber),
      readAt: now,
      addresses: { wallet: a.wallet, owner: a.owner, entryPoint: a.entryPoint, usdc: a.usdc, merchant: a.merchant, agent: config.agent.address },
      agent: {
        active: s.agent.active,
        validNow: s.agent.validNow,
        validAfter: Number(s.agent.validAfter),
        validUntil: Number(s.agent.validUntil),
        validUntilIso: iso(s.agent.validUntil),
        token: s.agent.token,
        maxPerTx: amount(s.agent.maxPerTx),
        dailyLimit: amount(s.agent.dailyLimit),
        spentToday: amount(s.agent.spentToday),
        remainingDailyAllowance: amount(s.agent.remainingDailyAllowance),
        canPurchase: s.agent.canPurchase,
        merchantAllowed: s.agent.merchantAllowed,
        nonceKey: `0x${s.agent.nonceKey.toString(16).padStart(40, "0")}`,
        nextNonce: s.agent.nextNonce.toString(),
      },
      wallet: {
        balance: amount(s.wallet.balance),
        merchantAllowance: amount(s.wallet.merchantAllowance),
        entryPointDeposit: s.wallet.entryPointDeposit.toString(),
        credits: Number(s.wallet.credits),
      },
      merchant: { pricePerCredit: amount(s.merchant.pricePerCredit), purchaseCount: Number(s.merchant.purchaseCount) },
      submitter: { address: config.submitter.address, ethBalance: submitterEth.toString() },
      warnings,
    };
  }

  const routes = [
    ["GET", /^\/health$/, async () => [200, { ok: true, apiVersion: "1", chainId: config.chainId, wallet: a.wallet, agent: config.agent.address, llm: llmMode, dbPath: config.dbPath, events: indexer ? indexer.status() : null }]],
    ["POST", /^\/agent\/chat$/, async (req) => {
      const body = await readJson(req);
      const r = await agent.chat({ message: body.message, conversationId: body.conversationId ?? "default" });
      return [200, r];
    }],
    ["GET", /^\/agent\/messages$/, async (_req, _m, q) => {
      const conversationId = q.get("conversationId") || "default";
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(conversationId)) throw new HttpError(400, "INVALID_INPUT", "bad conversationId");
      const messages = store.listChatMessages({ conversationId, limit: intParam(q.get("limit"), { min: 1, max: 200, def: 50 }) });
      return [200, { conversationId, messages: messages.map(({ id, role, content, requestId, createdAt }) => ({ id, role, content, requestId, createdAt })) }];
    }],
    ["GET", /^\/requests$/, async (_req, _m, q) => {
      const status = q.get("status") || undefined;
      if (status && status.split(",").some((x) => !STATUSES.includes(x))) throw new HttpError(400, "INVALID_INPUT", `status must be one of ${STATUSES.join(", ")}`);
      const before = q.get("before") ? intParam(q.get("before"), { min: 0, max: 2 ** 40, def: undefined }) : undefined;
      const rows = store.listRequests({ status, before, limit: intParam(q.get("limit"), { min: 1, max: 200, def: 50 }) });
      // Paid rows carry proofVerified, re-checked on chain (a database row alone is never proof of payment).
      const requests = await Promise.all(rows.map(async (r) => (proofs.needsProof(r) ? { ...requestView(r), proofVerified: (await proofs.check(r)).verified } : requestView(r))));
      return [200, { requests }];
    }],
    ["GET", /^\/requests\/(req_[0-9a-f]{16})$/, async (_req, m) => {
      const r = store.getRequest(m[1]);
      if (!r) throw new HttpError(404, "NOT_FOUND", "Unknown request id");
      const view = requestView(r);
      if (r.status === "needs_owner_approval" || r.status === "expired") view.ownerApproval = await buildOwnerApproval({ config, reads }, r);
      if (proofs.needsProof(r)) {
        const p = await proofs.check(r);
        view.proofVerified = p.verified;
        if (!p.cached) view.proofChecks = p.checks;
      }
      return [200, view];
    }],
    ["POST", /^\/approvals\/(req_[0-9a-f]{16})\/reject$/, async (req, m) => {
      const body = await readJson(req);
      if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 200)) throw new HttpError(400, "INVALID_INPUT", "note must be a string of at most 200 characters");
      if (!store.getRequest(m[1])) throw new HttpError(404, "NOT_FOUND", "Unknown request id");
      return [200, { request: requestView(store.transition(m[1], "rejected", { ownerNote: body.note })) }];
    }],
    ["POST", /^\/approvals\/(req_[0-9a-f]{16})\/verify$/, async (req, m) => {
      const body = await readJson(req);
      const out = await verifyOwnerApproval({ config, reads, store }, { requestId: m[1], txHash: body.txHash });
      return [200, { request: { ...requestView(out.request), proofVerified: true }, checks: out.checks }];
    }],
    ["GET", /^\/wallet\/status$/, async () => [200, await walletStatus()]],
    ["GET", /^\/events$/, async (_req, _m, q) => {
      const types = q.get("type") ? q.get("type").split(",").map((t) => t.trim()) : undefined;
      if (types?.some((t) => !INDEXED_TYPES.includes(t))) throw new HttpError(400, "INVALID_INPUT", `type must be from ${INDEXED_TYPES.join(", ")}`);
      const before = q.get("before") ? intParam(q.get("before"), { min: 0, max: Number.MAX_SAFE_INTEGER, def: undefined }) : undefined;
      return [200, queryEvents(store.db, { types, before, limit: intParam(q.get("limit"), { min: 1, max: 200, def: 50 }) })];
    }],
  ];

  const corsOrigin = env.FRONTEND_ORIGIN || "http://localhost:5173";
  const cors = { "access-control-allow-origin": corsOrigin, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", vary: "origin" };

  return async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "OPTIONS") return send(res, 204, {}, cors);
    try {
      const match = routes.map(([method, re, fn]) => [method, url.pathname.match(re), fn]).filter(([, m]) => m);
      if (!match.length) throw new HttpError(404, "NOT_FOUND", "No such endpoint");
      const route = match.find(([method]) => method === req.method);
      if (!route) throw new HttpError(405, "INVALID_INPUT", `Use ${match.map(([m]) => m).join(" or ")}`);
      const [status, body] = await route[2](req, route[1], url.searchParams);
      send(res, status, body, cors);
    } catch (e) {
      let err = e;
      if (e instanceof VerifyError) err = new HttpError(e.status, e.code, e.message, e.checks ? { checks: e.checks } : undefined);
      else if (e instanceof InputError) err = new HttpError(400, "INVALID_INPUT", e.message);
      else if (e instanceof BusyError) err = new HttpError(409, "BUSY", e.message);
      else if (e instanceof TransitionError) err = new HttpError(409, "WRONG_STATUS", e.message);
      else if (e instanceof LlmError) err = new HttpError(502, "LLM_ERROR", e.message);
      else if (!(e instanceof HttpError)) {
        const rpc = e?.name?.includes("Http") || e?.name?.includes("Rpc") || e?.name?.includes("Contract");
        console.error(`${req.method} ${url.pathname} failed:`, e?.shortMessage ?? e?.message);
        err = rpc ? new HttpError(502, "RPC_ERROR", "Chain read failed") : new HttpError(500, "INTERNAL", "Internal error");
      }
      send(res, err.status, { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } }, cors);
    }
  };
}

/** Full start-up: config, chain checks, database recovery, agent, HTTP server on 127.0.0.1:PORT. */
export async function startServer(env = process.env) {
  const config = loadConfig(env);
  const reads = createReads(config);
  const startup = await assertStartup(config, reads);
  const { store, recovered, expired } = await startStore(config, reads);
  const llm = createLlmFromEnv(env);
  const proofs = createProofs({ config, reads });
  const agent = buildAgent({ config, reads, store, env, llm, proofs });
  const indexer = createIndexer({ config, reads, db: store.db });
  indexer.state(); // fails fast if this database was indexed on another chain
  const handler = createApp({ config, reads, store, agent, env, llmMode: llm ? "available" : "fallback", proofs, indexer });
  const server = createHttpServer(handler);
  const sweep = setInterval(() => store.expireDue(), 60_000);
  sweep.unref();
  indexer.start(); // catches up in the background, then polls every EVENTS_POLL_MS
  server.on("close", async () => {
    clearInterval(sweep);
    await indexer.stop();
    store.close();
  });
  await new Promise((resolve) => server.listen(config.port, "127.0.0.1", resolve));
  console.log(`Agent backend on http://127.0.0.1:${config.port}  ${JSON.stringify(config)}  llm=${llm ? `${llm.provider}:${llm.model}` : "none (fallback planner)"}`);
  if (!startup.agentValidNow) console.warn("WARNING: the agent is registered but not valid now (expired or not yet valid). Purchases will be BLOCKED.");
  if (recovered.succeeded.length + recovered.failed.length + recovered.pending.length) console.log("Recovered submitted requests:", JSON.stringify(recovered));
  if (expired.length) console.log("Expired owner approvals:", expired.join(", "));
  const unproven = await proofs.audit(store).catch(() => []);
  if (unproven.length) console.warn(`WARNING: ${unproven.length} paid request(s) have no valid on-chain proof (edited database?): ${unproven.join(", ")}. The API shows them with proofVerified: false.`);
  return { server, config, store };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startServer().catch((e) => {
    if (e instanceof ConfigError || e instanceof StartupError || e instanceof LlmError || e?.name === "IndexerError") {
      console.error(`${e.name}: ${e.message}`);
      process.exit(1);
    }
    throw e;
  });
}
