// Phase 9 on Anvil: owner approval through the HTTP API, verified on chain. In-memory DB, evm_snapshot / evm_revert.
// The owner tx is sent here with Anvil key #0, standing in for the owner's own wallet; the backend never holds that key.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createWalletClient, http, parseEther, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig, abi } from "../src/config.js";
import { createReads } from "../src/chain/reads.js";
import { createPurchaser } from "../src/chain/userop.js";
import { openDb, createStore } from "../src/db/index.js";
import { buildAgent, createTools } from "../src/agent/index.js";
import { createApp } from "../src/server.js";
import { createProofs } from "../src/approvals/index.js";
import { ANVIL_KEYS, anvilEnv, anvilSkipReason } from "./helpers/anvil.mjs";

const skip = await anvilSkipReason();
let s, server, base, snapshotId;

before(async () => {
  if (skip) return;
  const config = loadConfig(anvilEnv);
  const reads = createReads(config);
  const client = (key) => createWalletClient({ account: privateKeyToAccount(key), chain: config.chain, transport: http(config.rpcUrl) });
  const submitter = createWalletClient({ account: config.submitter, chain: config.chain, transport: http(config.rpcUrl) });
  snapshotId = await reads.client.request({ method: "evm_snapshot" });
  await reads.client.waitForTransactionReceipt({ hash: await submitter.writeContract({ address: config.addresses.wallet, abi: abi.wallet, functionName: "addDeposit", value: parseEther("0.05") }) });
  // createdAt must be on the chain's clock: Anvil's time drifts from the PC's after evm_revert.
  const offset = Number((await reads.client.getBlock()).timestamp) - Math.floor(Date.now() / 1000);
  const clockSkew = { extra: 0 };
  const db = openDb(":memory:");
  const store = createStore(db, { secrets: [], clock: () => Math.floor(Date.now() / 1000) + offset + clockSkew.extra });
  const purchaser = createPurchaser(config, reads, { walletClient: submitter });
  const proofs = createProofs({ config, reads });
  const agent = buildAgent({ config, reads, store, purchaser, proofs, llm: null, env: {}, log: () => {} });
  s = { config, reads, store, db, purchaser, clockSkew, owner: client(ANVIL_KEYS[0]), stranger: client(ANVIL_KEYS[3]) };
  server = createServer(createApp({ config, reads, store, agent, env: {}, proofs }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (skip) return;
  await new Promise((r) => server.close(r));
  s.store.close();
  await s.reads.client.request({ method: "evm_revert", params: [snapshotId] });
});

const req = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const mined = (hash) => s.reads.client.waitForTransactionReceipt({ hash });

/** Over-limit request through the agent: must come back needs_owner_approval with nothing sent. */
async function overLimitRequest(credits) {
  const c = await req("POST", "/agent/chat", { message: `buy ${credits} credits` });
  const r = await req("GET", `/requests/${c.body.requestIds[0]}`);
  assert.equal(r.body.status, "needs_owner_approval");
  return r.body;
}

/** The owner signs exactly what GET /requests/:id returned: wallet.executeBatch(dest, value, func). */
async function ownerPays(ownerApproval) {
  const { dest, value, func } = ownerApproval.args;
  const hash = await s.owner.writeContract({ address: s.config.addresses.wallet, abi: abi.wallet, functionName: "executeBatch", args: [dest, value, func] });
  assert.equal((await mined(hash)).status, "success");
  return hash;
}

/** A batch for other credits than the request's, built the same way (fresh quote and allowance). */
async function ownerBuys(credits) {
  const a = s.config.addresses;
  const [price, standing] = await Promise.all([s.reads.quote(credits), s.reads.merchantAllowance()]);
  return ownerPays({
    args: {
      dest: [a.usdc, a.merchant],
      value: [],
      func: [
        encodeFunctionData({ abi: abi.usdc, functionName: "approve", args: [a.merchant, standing + price] }),
        encodeFunctionData({ abi: abi.merchant, functionName: "purchase", args: [BigInt(credits), price] }),
      ],
    },
  });
}

const verify = (id, txHash) => req("POST", `/approvals/${id}/verify`, { txHash });
const statusOf = (id) => s.store.getRequest(id).status;

test("over-limit request: fulfilled only after the owner's tx is verified; agent policy and spentToday untouched", { skip }, async () => {
  const r = await overLimitRequest(150);
  assert.equal(r.txHash, null);
  const oa = r.ownerApproval;
  assert.deepEqual(oa.price, { base: "1500000", mUSDC: "1.5" }); // quote(150) read now, not the agent's proposal
  assert.equal(BigInt(oa.calls[0].args.value.base), BigInt(oa.standingAllowance.base) + 1_500_000n);

  const before = { agent: await s.reads.getAgent(), remaining: await s.reads.remainingDailyAllowance(), nonce: await s.reads.agentNonce(), credits: await s.reads.creditsOf() };
  const tx = await ownerPays(oa);
  // Paid on chain but not verified yet: still needs_owner_approval.
  assert.equal(statusOf(r.id), "needs_owner_approval");

  const v = await verify(r.id, tx);
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.request.status, "fulfilled_by_owner");
  assert.equal(v.body.request.path, "owner");
  assert.equal(v.body.request.txHash, tx);
  assert.deepEqual(v.body.request.amountPaid, { base: "1500000", mUSDC: "1.5" });
  assert.equal(v.body.request.userOpHash, null);
  assert.deepEqual(v.body.checks.map((c) => c.name), ["request_status", "tx_unused", "receipt_success", "owner_authorized", "credits_purchased", "after_request"]);
  assert.ok(v.body.checks.every((c) => c.ok));

  const after = { agent: await s.reads.getAgent(), remaining: await s.reads.remainingDailyAllowance(), nonce: await s.reads.agentNonce(), credits: await s.reads.creditsOf() };
  assert.deepEqual(after.agent, before.agent, "agent policy and spentToday unchanged by the owner purchase");
  assert.equal(after.remaining, before.remaining);
  assert.equal(after.nonce, before.nonce, "no agent UserOp");
  assert.equal(after.credits - before.credits, 150n);

  const g = await req("GET", `/requests/${r.id}`);
  assert.equal(g.body.proofVerified, true);
  assert.equal(g.body.ownerApproval, undefined);
  assert.equal((await verify(r.id, tx)).body.error.code, "WRONG_STATUS");

  // The same tx cannot fulfil a second request for the same credits.
  const r2 = await overLimitRequest(150);
  const again = await verify(r2.id, tx);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "TX_ALREADY_USED");
  assert.equal(statusOf(r2.id), "needs_owner_approval");
  s.r2 = r2;
});

test("fake tx hash -> 422 TX_NOT_FOUND, status unchanged", { skip }, async () => {
  const id = s.r2.id;
  const v = await verify(id, "0x" + "ab".repeat(32));
  assert.equal(v.status, 422);
  assert.equal(v.body.error.code, "TX_NOT_FOUND");
  assert.deepEqual(v.body.error.details.checks.slice(0, 3).map((c) => [c.name, c.ok]), [["request_status", true], ["tx_unused", true], ["receipt_success", false]]);
  assert.equal(statusOf(id), "needs_owner_approval");
  assert.equal((await verify(id, "not-a-hash")).body.error.code, "INVALID_INPUT");
});

test("tx not from the owner -> NOT_OWNER_TX / TX_REVERTED, status unchanged", { skip }, async () => {
  // A request for 10 credits that is waiting for the owner, and the agent's own UserOp buying exactly 10 credits.
  const row = s.store.createRequest({ credits: 10, agentAddress: s.config.agent.address });
  s.store.transition(row.id, "needs_owner_approval", { path: "owner", precheck: "NEEDS_OWNER", price: 100_000n, expiresAt: Math.floor(Date.now() / 1000) + 86_400 * 365 });
  const agentBuy = await s.purchaser.purchaseCredits({ credits: 10 });
  assert.equal(agentBuy.outcome, "succeeded");
  const v = await verify(row.id, agentBuy.txHash);
  assert.equal(v.status, 422);
  assert.equal(v.body.error.code, "NOT_OWNER_TX", "an agent UserOp (nonce key = agent) is not owner authorization");
  assert.equal(v.body.error.details.checks.find((c) => c.name === "credits_purchased").ok, true, "the purchase itself is real; only the authorization is wrong");
  assert.equal(statusOf(row.id), "needs_owner_approval");

  // A stranger (#3) calling wallet.executeBatch with the owner's calldata: the wallet reverts it.
  const oa = (await req("GET", `/requests/${row.id}`)).body.ownerApproval;
  const hash = await s.stranger.writeContract({ address: s.config.addresses.wallet, abi: abi.wallet, functionName: "executeBatch", args: [oa.args.dest, oa.args.value, oa.args.func], gas: 300_000n });
  assert.equal((await mined(hash)).status, "reverted");
  const w = await verify(row.id, hash);
  assert.equal(w.body.error.code, "TX_REVERTED");
  assert.equal(w.body.error.details.checks.find((c) => c.name === "owner_authorized").ok, false);
  assert.equal(statusOf(row.id), "needs_owner_approval");

  // A plain ETH transfer from the stranger to the wallet: not executeBatch, not the owner.
  const t = await s.stranger.sendTransaction({ to: s.config.addresses.wallet, value: 1n });
  await mined(t);
  assert.equal((await verify(row.id, t)).body.error.code, "NOT_OWNER_TX");
  s.small = row;
});

test("owner tx for different credits -> CREDITS_MISMATCH; a tx older than the request -> TX_TOO_OLD", { skip }, async () => {
  const tx120 = await ownerBuys(120);
  const v = await verify(s.r2.id, tx120); // r2 asks for 150
  assert.equal(v.status, 422);
  assert.equal(v.body.error.code, "CREDITS_MISMATCH");
  assert.equal(statusOf(s.r2.id), "needs_owner_approval");

  // An owner tx with nothing bought: approve only.
  const a = s.config.addresses;
  const approveOnly = await s.owner.writeContract({ address: a.wallet, abi: abi.wallet, functionName: "executeBatch", args: [[a.usdc], [], [encodeFunctionData({ abi: abi.usdc, functionName: "approve", args: [a.merchant, await s.reads.merchantAllowance()] })]] });
  await mined(approveOnly);
  assert.equal((await verify(s.r2.id, approveOnly)).body.error.code, "NO_PURCHASE_EVENT");

  // A request for 120 credits created an hour after that purchase cannot use it.
  s.clockSkew.extra = 3600;
  const late = s.store.createRequest({ credits: 120, agentAddress: s.config.agent.address });
  s.clockSkew.extra = 0;
  s.store.transition(late.id, "needs_owner_approval", { path: "owner", precheck: "NEEDS_OWNER", price: 1_200_000n });
  assert.equal((await verify(late.id, tx120)).body.error.code, "TX_TOO_OLD");
  assert.equal(statusOf(late.id), "needs_owner_approval");
});

test("a manually edited SQLite row never counts as fulfilled", { skip }, async () => {
  const id = s.small.id;
  // 1. Status only: the schema CHECKs refuse a paid status without the on-chain proof columns.
  assert.throws(() => s.db.prepare("UPDATE purchase_requests SET status = 'fulfilled_by_owner' WHERE id = ?").run(id), /CHECK constraint failed/);
  assert.equal(statusOf(id), "needs_owner_approval");

  // 2. A forged row with every column filled in: stored, but the API re-checks it on chain and says unverified.
  const fake = "0x" + "cd".repeat(32);
  s.db.prepare("UPDATE purchase_requests SET status = 'fulfilled_by_owner', tx_hash = ?, purchase_id = '999', amount_paid_base = '100000' WHERE id = ?").run(fake, id);
  const g = await req("GET", `/requests/${id}`);
  assert.equal(g.body.status, "fulfilled_by_owner"); // what the row claims
  assert.equal(g.body.proofVerified, false); // what the chain says
  const list = await req("GET", "/requests?status=fulfilled_by_owner");
  assert.equal(list.body.requests.find((x) => x.id === id).proofVerified, false);
  assert.equal(list.body.requests.find((x) => x.id !== id).proofVerified, true, "the genuinely verified request still passes");

  // 3. A forged row pointing at a real purchase tx that the owner did not authorize (the agent's UserOp above).
  const buy = await s.purchaser.purchaseCredits({ credits: 10 });
  s.db.prepare("UPDATE purchase_requests SET tx_hash = ? WHERE id = ?").run(buy.txHash, id);
  assert.equal((await req("GET", `/requests/${id}`)).body.proofVerified, false);

  // 4. The agent's list_requests tool reports the same, so the model never calls a forged row paid.
  const tools = createTools({ config: s.config, reads: s.reads, store: s.store, purchaser: s.purchaser, proofs: createProofs({ config: s.config, reads: s.reads }) });
  const listed = (await tools.run("list_requests", { status: "fulfilled_by_owner" })).result.requests;
  assert.equal(listed.find((x) => x.requestId === id).proofVerified, false);
  assert.equal(listed.find((x) => x.requestId !== id).proofVerified, true);

  // 5. The start-up audit flags it.
  assert.ok((await createProofs({ config: s.config, reads: s.reads }).audit(s.store)).includes(id));
});

test("expiry: needs_owner_approval expires after the TTL; the owner's tx can still fulfil it; rejected cannot", { skip }, async () => {
  assert.equal(s.config.approvalTtlSeconds, 86_400);
  const r = await overLimitRequest(110);
  const row = s.store.getRequest(r.id);
  assert.ok(row.expiresAt >= row.createdAt + 86_400 - 5);
  assert.deepEqual(s.store.expireDue(row.expiresAt - 1), []);
  assert.ok(s.store.expireDue(row.expiresAt).includes(r.id));
  const e = await req("GET", `/requests/${r.id}`);
  assert.equal(e.body.status, "expired");
  assert.ok(e.body.ownerApproval, "still shows what to sign (the chain wins)");
  const tx = await ownerPays(e.body.ownerApproval);
  const v = await verify(r.id, tx);
  assert.equal(v.body.request.status, "fulfilled_by_owner");

  const rej = await overLimitRequest(130);
  await req("POST", `/approvals/${rej.id}/reject`, { note: "no" });
  const tx2 = await ownerPays(rej.ownerApproval);
  assert.equal((await verify(rej.id, tx2)).body.error.code, "WRONG_STATUS");
  assert.equal(statusOf(rej.id), "rejected");
});
