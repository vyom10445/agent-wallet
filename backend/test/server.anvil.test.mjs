// HTTP API on Anvil: the routes from BACKEND_API.md §4 that exist so far. In-memory DB, evm_snapshot / evm_revert.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createWalletClient, http, parseEther } from "viem";
import { loadConfig, abi } from "../src/config.js";
import { createReads } from "../src/chain/reads.js";
import { createPurchaser } from "../src/chain/userop.js";
import { openDb, createStore } from "../src/db/index.js";
import { buildAgent } from "../src/agent/index.js";
import { createApp } from "../src/server.js";
import { anvilEnv, anvilSkipReason } from "./helpers/anvil.mjs";

const skip = await anvilSkipReason();
let s, server, base, snapshotId;

before(async () => {
  if (skip) return;
  const config = loadConfig(anvilEnv);
  const reads = createReads(config);
  const submitter = createWalletClient({ account: config.submitter, chain: config.chain, transport: http(config.rpcUrl) });
  snapshotId = await reads.client.request({ method: "evm_snapshot" });
  const hash = await submitter.writeContract({ address: config.addresses.wallet, abi: abi.wallet, functionName: "addDeposit", value: parseEther("0.05") });
  await reads.client.waitForTransactionReceipt({ hash });
  const store = createStore(openDb(":memory:"), { secrets: [] });
  const agent = buildAgent({ config, reads, store, purchaser: createPurchaser(config, reads, { walletClient: submitter }), llm: null, env: {}, log: () => {} });
  s = { config, reads, store };
  server = createServer(createApp({ config, reads, store, agent, env: {} }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (skip) return;
  await new Promise((r) => server.close(r));
  s.store.close();
  await s.reads.client.request({ method: "evm_revert", params: [snapshotId] });
});

const req = async (method, path, body, headers = { "content-type": "application/json" }) => {
  const r = await fetch(base + path, { method, headers: body !== undefined ? headers : {}, body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined });
  return { status: r.status, body: await r.json() };
};

test("GET /health and /wallet/status (amounts as { base, mUSDC } strings)", { skip }, async () => {
  const h = await req("GET", "/health");
  assert.equal(h.status, 200);
  assert.deepEqual({ ok: h.body.ok, apiVersion: h.body.apiVersion, chainId: h.body.chainId, llm: h.body.llm }, { ok: true, apiVersion: "1", chainId: 31337, llm: "fallback" });
  assert.ok(!JSON.stringify(h.body).match(/[0-9a-f]{64}/i), "no key-like strings");
  const w = await req("GET", "/wallet/status");
  assert.equal(w.status, 200);
  assert.deepEqual(w.body.agent.maxPerTx, { base: "1000000", mUSDC: "1" });
  assert.equal(w.body.agent.validNow, true);
  assert.equal(typeof w.body.wallet.entryPointDeposit, "string");
  assert.equal(w.body.submitter.address, s.config.submitter.address);
});

test("POST /agent/chat buys, GET /requests/:id shows the proof", { skip }, async () => {
  const c = await req("POST", "/agent/chat", { message: "buy 7 credits" });
  assert.equal(c.status, 200);
  assert.equal(c.body.planner, "fallback");
  const r = await req("GET", `/requests/${c.body.requestIds[0]}`);
  assert.equal(r.body.status, "succeeded");
  assert.deepEqual(r.body.amountPaid, { base: "70000", mUSDC: "0.07" });
  assert.match(r.body.userOpHash, /^0x[0-9a-f]{64}$/);
  assert.match(r.body.txHash, /^0x[0-9a-f]{64}$/);
  assert.equal(r.body.explorerUrl, null); // Anvil has no explorer
  const list = await req("GET", "/requests?status=succeeded&limit=5");
  assert.ok(list.body.requests.some((x) => x.id === r.body.id));
  const msgs = await req("GET", "/agent/messages");
  assert.deepEqual(msgs.body.messages.map((x) => x.role).slice(-2), ["user", "assistant"]);
});

test("over-limit request carries ownerApproval rebuilt from chain; reject works once", { skip }, async () => {
  const c = await req("POST", "/agent/chat", { message: "buy 500 credits" });
  const r = await req("GET", `/requests/${c.body.requestIds[0]}`);
  assert.equal(r.body.status, "needs_owner_approval");
  assert.equal(r.body.txHash, null);
  const oa = r.body.ownerApproval;
  assert.equal(oa.function, "executeBatch");
  assert.deepEqual(oa.price, { base: "5000000", mUSDC: "5" });
  assert.deepEqual(oa.args.dest, [s.config.addresses.usdc, s.config.addresses.merchant]);
  assert.equal(oa.args.func[1].slice(0, 10), "0x70876c98");
  const rej = await req("POST", `/approvals/${r.body.id}/reject`, { note: "too much" });
  assert.equal(rej.body.request.status, "rejected");
  const again = await req("POST", `/approvals/${r.body.id}/reject`, {});
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "WRONG_STATUS");
});

test("errors follow the ErrorBody shape", { skip }, async () => {
  assert.equal((await req("GET", "/nope")).body.error.code, "NOT_FOUND");
  assert.equal((await req("GET", "/requests/req_0000000000000000")).status, 404);
  assert.equal((await req("POST", "/agent/chat", { message: "" })).body.error.code, "INVALID_INPUT");
  assert.equal((await req("POST", "/agent/chat", "{bad json")).status, 400);
  assert.equal((await req("POST", "/agent/chat", { message: "hi" }, { "content-type": "text/plain" })).status, 400);
  assert.equal((await req("POST", "/agent/chat", { message: "x".repeat(20_000) })).status, 400);
  assert.equal((await req("GET", "/requests?status=paid")).status, 400);
  assert.equal((await req("GET", "/events")).status, 200);
  assert.equal((await req("GET", "/events?type=Nope")).body.error.code, "INVALID_INPUT");
  assert.equal((await req("POST", "/approvals/req_0000000000000000/verify", { txHash: "0x" + "0".repeat(64) })).status, 404);
  assert.equal((await req("POST", "/approvals/req_0000000000000000/verify", { txHash: "0x12" })).body.error.code, "INVALID_INPUT");
});
