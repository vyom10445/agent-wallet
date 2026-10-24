// The four LLM tools from docs/BACKEND_API.md §6, their argument validation and their execution.
// The model only ever supplies `credits`, `reason`, `limit` and `status`. Every address, selector, calldata, nonce and
// gas value is built by the backend. Tool results contain no addresses or calldata (only a tx hash and explorer link).
import { MAX_CREDITS_PER_REQUEST } from "../chain/userop.js";
import { formatUsdc } from "../chain/reads.js";
import { precheck as runPrecheck } from "../policy/precheck.js";
import { STATUSES } from "../db/store.js";

export const TOOL_DEFS = Object.freeze([
  {
    name: "get_wallet_status",
    description: "Read the live wallet and agent status: whether the agent is active and valid, per-transaction and daily limits, spent today, remaining today, wallet mUSDC balance, merchant allowance and credits owned. Read-only.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "quote_credits",
    description: "Get the price of a number of API credits from the merchant, in mUSDC. Read-only, buys nothing.",
    input_schema: {
      type: "object",
      properties: { credits: { type: "integer", minimum: 1, maximum: MAX_CREDITS_PER_REQUEST, description: "Number of API credits" } },
      required: ["credits"],
      additionalProperties: false,
    },
  },
  {
    name: "buy_credits",
    description: "Buy API credits for the user. The backend checks the on-chain policy. Within policy it buys through the wallet and returns the on-chain result. Above the limits it creates a request that the wallet owner must sign; it never bypasses limits.",
    input_schema: {
      type: "object",
      properties: {
        credits: { type: "integer", minimum: 1, maximum: MAX_CREDITS_PER_REQUEST, description: "Number of API credits to buy" },
        reason: { type: "string", minLength: 1, maxLength: 200, description: "Short reason, shown to the owner" },
      },
      required: ["credits", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "list_requests",
    description: "List recent purchase requests and their status. Read-only.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
        status: { type: "string", enum: [...STATUSES] },
      },
      additionalProperties: false,
    },
  },
]);
export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);

export class ToolInputError extends Error {
  name = "ToolInputError";
}

/** Validates against the tool's schema (types, ranges, enums, no extra keys). Returns a clean copy or throws. */
export function validateToolInput(name, input) {
  const def = TOOL_DEFS.find((t) => t.name === name);
  if (!def) throw new ToolInputError(`Unknown tool "${String(name).slice(0, 40)}". Available: ${TOOL_NAMES.join(", ")}.`);
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new ToolInputError("Arguments must be a JSON object.");
  const { properties, required = [] } = def.input_schema;
  const extra = Object.keys(input).filter((k) => !(k in properties));
  if (extra.length) throw new ToolInputError(`Unexpected argument(s): ${extra.join(", ")}. ${name} accepts only: ${Object.keys(properties).join(", ") || "nothing"}.`);
  for (const k of required) if (input[k] === undefined) throw new ToolInputError(`Missing argument: ${k}.`);
  const out = {};
  for (const [k, p] of Object.entries(properties)) {
    let v = input[k];
    if (v === undefined) {
      if (p.default !== undefined) out[k] = p.default;
      continue;
    }
    if (p.type === "integer") {
      if (!Number.isSafeInteger(v)) throw new ToolInputError(`${k} must be an integer.`);
      if (v < p.minimum || v > p.maximum) throw new ToolInputError(`${k} must be from ${p.minimum} to ${p.maximum}.`);
    } else if (p.type === "string") {
      if (typeof v !== "string") throw new ToolInputError(`${k} must be a string.`);
      v = v.trim();
      if (p.minLength && v.length < p.minLength) throw new ToolInputError(`${k} must not be empty.`);
      if (p.maxLength && v.length > p.maxLength) throw new ToolInputError(`${k} must be at most ${p.maxLength} characters.`);
      if (p.enum && !p.enum.includes(v)) throw new ToolInputError(`${k} must be one of: ${p.enum.join(", ")}.`);
    }
    out[k] = v;
  }
  return out;
}

const m = (v) => `${formatUsdc(v)} mUSDC`;
const EXPLORERS = { 84532: "https://sepolia.basescan.org/tx/" };

/**
 * Tool execution. Returns plain JSON-safe objects (no bigint, no addresses) for the model.
 * deps: { config, reads, store, purchaser, precheck?, approvalTtlSeconds?, proofs? (approvals/proof.js) }
 */
export function createTools({ config, reads, store, purchaser, precheck = runPrecheck, approvalTtlSeconds = 86_400, proofs = null }) {
  const explorerUrl = (txHash) => (txHash && EXPLORERS[config.chainId] ? EXPLORERS[config.chainId] + txHash : null);

  const requestView = (r) => ({
    requestId: r.id,
    status: r.status,
    credits: r.credits,
    price: r.price !== null ? m(r.price) : null,
    txHash: r.txHash,
    error: r.errorCode ? { code: r.errorCode, message: r.errorText } : null,
    createdAt: new Date(r.createdAt * 1000).toISOString(),
  });

  async function get_wallet_status() {
    const s = await reads.snapshot();
    const warnings = [];
    if (!s.agent.validNow) warnings.push("AGENT_NOT_VALID");
    if (s.agent.validNow && Number(s.agent.validUntil) - Date.now() / 1000 < 86_400) warnings.push("AGENT_EXPIRES_SOON");
    if (s.wallet.merchantAllowance < s.agent.maxPerTx) warnings.push("ALLOWANCE_LOW");
    if (s.wallet.balance < s.agent.maxPerTx) warnings.push("BALANCE_LOW");
    return {
      agentActive: s.agent.active,
      agentValidNow: s.agent.validNow,
      validUntilIso: new Date(Number(s.agent.validUntil) * 1000).toISOString(),
      maxPerTx: m(s.agent.maxPerTx),
      dailyLimit: m(s.agent.dailyLimit),
      spentToday: m(s.agent.spentToday),
      remainingToday: m(s.agent.remainingDailyAllowance),
      walletBalance: m(s.wallet.balance),
      merchantAllowance: m(s.wallet.merchantAllowance),
      credits: Number(s.wallet.credits),
      pricePerCredit: m(s.merchant.pricePerCredit),
      warnings,
    };
  }

  async function quote_credits({ credits }) {
    const [price, info, remaining] = await Promise.all([reads.quote(credits), reads.getAgent(), reads.remainingDailyAllowance()]);
    return { credits, price: m(price), withinPerTxLimit: price <= info.maxPerTx, withinRemainingToday: price <= remaining };
  }

  async function buy_credits({ credits, reason }, { conversationId }) {
    const req = store.createRequest({ conversationId, credits, reason, agentAddress: config.agent.address });
    const pc = await precheck(reads, { credits });
    const reasons = pc.reasons.map((r) => r.message);
    const base = { requestId: req.id, precheck: pc.result, price: pc.price !== null ? m(pc.price) : null, ownerMustSign: false, txHash: null, explorerUrl: null, error: null };

    if (pc.result === "BLOCKED") {
      store.transition(req.id, "precheck_failed", { precheck: pc.result, price: pc.price ?? undefined, errorCode: "PRECHECK_BLOCKED", errorText: reasons.join(" ") });
      return { ...base, status: "precheck_failed", error: { code: "PRECHECK_BLOCKED", message: reasons.join(" ") }, nothingSent: true };
    }
    if (pc.result === "NEEDS_OWNER" || pc.result === "NEEDS_OWNER_TOPUP") {
      store.transition(req.id, "needs_owner_approval", { path: "owner", precheck: pc.result, price: pc.price, expiresAt: Math.floor(Date.now() / 1000) + approvalTtlSeconds });
      return { ...base, status: "needs_owner_approval", ownerMustSign: true, reasons, nothingSent: true, note: "Nothing was bought. The wallet owner must approve and sign this purchase with their own wallet." };
    }

    const r = await purchaser.purchaseCredits({ credits });
    if (r.outcome === "not_sent") {
      store.transition(req.id, "precheck_failed", { path: "agent", precheck: pc.result, price: pc.price, errorCode: r.code, errorText: r.message });
      return { ...base, status: "precheck_failed", error: { code: r.code, message: r.message }, nothingSent: true };
    }
    store.transition(req.id, "submitted", { path: "agent", precheck: pc.result, price: r.price, nonce: r.nonce, userOpHash: r.userOpHash, txHash: r.txHash });
    const mined = { txHash: r.txHash, explorerUrl: explorerUrl(r.txHash) };
    if (r.outcome === "succeeded") {
      store.transition(req.id, "succeeded", { blockNumber: r.blockNumber, actualGasCost: r.actualGasCost ?? undefined, purchase: r.purchase });
      return { ...base, ...mined, status: "succeeded", amountPaid: m(r.purchase.amountPaid), creditsReceived: Number(r.purchase.credits) };
    }
    if (r.outcome === "failed_onchain") {
      store.transition(req.id, "failed_onchain", { blockNumber: r.blockNumber, actualGasCost: r.actualGasCost ?? undefined, errorCode: r.code, errorText: r.message });
      return { ...base, ...mined, status: "failed_onchain", error: { code: r.code, message: r.message } };
    }
    return { ...base, ...mined, status: "submitted", note: "Sent, waiting for the receipt. Check list_requests later." };
  }

  async function list_requests({ limit = 10, status }) {
    const rows = store.listRequests({ status, limit });
    // A paid status in the database is only a claim: re-check it on chain so the model never reports a forged row as paid.
    const views = await Promise.all(rows.map(async (r) => (proofs && proofs.needsProof(r) ? { ...requestView(r), proofVerified: (await proofs.check(r)).verified } : requestView(r))));
    return { requests: views };
  }

  const impl = { get_wallet_status, quote_credits, buy_credits, list_requests };

  return {
    defs: TOOL_DEFS,
    /** Validates, then runs. Never throws: errors come back as { error } so the model can explain them. */
    async run(name, rawInput, ctx = {}) {
      let input;
      try {
        input = validateToolInput(name, rawInput);
      } catch (e) {
        return { ok: false, input: null, result: { error: "INVALID_INPUT", message: e.message } };
      }
      try {
        return { ok: true, input, result: await impl[name](input, ctx) };
      } catch (e) {
        return { ok: false, input, result: { error: "TOOL_FAILED", message: e.message } };
      }
    },
  };
}
