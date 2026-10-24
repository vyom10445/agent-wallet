// Phase 10 on Anvil: the event indexer and GET /events. File-backed DB (to restart it), evm_snapshot / evm_revert.
// Owner actions use Anvil key #0, standing in for the owner's own wallet; the backend never holds that key.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWalletClient, http, parseEther, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig, abi } from "../src/config.js";
import { createReads } from "../src/chain/reads.js";
import { createPurchaser, buildUserOp, signUserOp, submitUserOp } from "../src/chain/userop.js";
import { openDb, createStore } from "../src/db/index.js";
import { buildAgent } from "../src/agent/index.js";
import { createApp } from "../src/server.js";
import { createIndexer, splitNonce } from "../src/events/index.js";
import { ANVIL_KEYS, anvilEnv, anvilSkipReason } from "./helpers/anvil.mjs";

const skip = await anvilSkipReason();
let s, snapshotId, dir;

/** Opens the file DB and an HTTP server on it, like `npm start` would. */
async function boot(dbPath) {
  const store = createStore(openDb(dbPath), { secrets: [], clock: () => Math.floor(Date.now() / 1000) + s.offset });
  const agent = buildAgent({ config: s.config, reads: s.reads, store, purchaser: s.purchaser, llm: null, env: {}, log: () => {} });
  const server = createServer(createApp({ config: s.config, reads: s.reads, store, agent, env: {} }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { store, server, base: `http://127.0.0.1:${server.address().port}` };
}
async function shutdown(app) {
  await new Promise((r) => app.server.close(r));
  app.store.close();
}

before(async () => {
  if (skip) return;
  const config = loadConfig(anvilEnv);
  const reads = createReads(config);
  const submitter = createWalletClient({ account: config.submitter, chain: config.chain, transport: http(config.rpcUrl) });
  snapshotId = await reads.client.request({ method: "evm_snapshot" });
  await reads.client.waitForTransactionReceipt({ hash: await submitter.writeContract({ address: config.addresses.wallet, abi: abi.wallet, functionName: "addDeposit", value: parseEther("0.05") }) });
  const offset = Number((await reads.client.getBlock()).timestamp) - Math.floor(Date.now() / 1000);
  const ownerAccount = privateKeyToAccount(ANVIL_KEYS[0]);
  s = {
    config, reads, offset, submitter, ownerAccount,
    owner: createWalletClient({ account: ownerAccount, chain: config.chain, transport: http(config.rpcUrl) }),
    purchaser: createPurchaser(config, reads, { walletClient: submitter }),
    ctx: { client: reads.client, addresses: config.addresses },
    startBlock: Number(await reads.client.getBlockNumber({ cacheTime: 0 })) + 1,
  };
  dir = mkdtempSync(join(tmpdir(), "events-test-"));
  s.dbPath = join(dir, "agent.sqlite");
});
after(async () => {
  if (skip) return;
  rmSync(dir, { recursive: true, force: true });
  await s.reads.client.request({ method: "evm_revert", params: [snapshotId] });
});

const get = async (base, path) => (await fetch(base + path)).json();
const post = async (base, path, body) => (await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
const mined = (hash) => s.reads.client.waitForTransactionReceipt({ hash });
const indexerFor = (store, opts = {}) => createIndexer({ config: s.config, reads: s.reads, db: store.db, log: () => {} }, { startBlock: s.startBlock, chunkSize: 2, confirmations: 0, ...opts });
const keysOf = (db) => db.prepare("SELECT tx_hash || ':' || log_index AS k FROM chain_events ORDER BY block_number, log_index").all().map((r) => r.k);

async function ownerBatch(credits) {
  const a = s.config.addresses;
  const [price, standing] = await Promise.all([s.reads.quote(credits), s.reads.merchantAllowance()]);
  return [
    [a.usdc, a.merchant],
    [],
    [
      encodeFunctionData({ abi: abi.usdc, functionName: "approve", args: [a.merchant, standing + price] }),
      encodeFunctionData({ abi: abi.merchant, functionName: "purchase", args: [BigInt(credits), price] }),
    ],
  ];
}

test("Phase 8 and 9 purchases appear in /events with the right label and request", { skip }, async () => {
  const app = await boot(s.dbPath);
  // Phase 8: the agent buys within its limits (ERC-4337, agent nonce key).
  const chat = await post(app.base, "/agent/chat", { message: "buy 10 credits" });
  const agentReq = app.store.getRequest(chat.requestIds[0]);
  assert.equal(agentReq.status, "succeeded");
  // Phase 9: over the limit, the owner pays directly with executeBatch, then verify.
  const over = await post(app.base, "/agent/chat", { message: "buy 150 credits" });
  const ownerReqId = over.requestIds[0];
  const oa = (await get(app.base, `/requests/${ownerReqId}`)).ownerApproval;
  const ownerTx = await s.owner.writeContract({ address: s.config.addresses.wallet, abi: abi.wallet, functionName: "executeBatch", args: [oa.args.dest, oa.args.value, oa.args.func] });
  await mined(ownerTx);

  // Index before verify: the owner purchase is already labelled owner; its requestId appears once verify stores the tx.
  const ix = indexerFor(app.store, { chunkSize: 1 });
  const r1 = await ix.sync();
  assert.ok(r1.chunks >= 2, `chunked: ${JSON.stringify(r1)}`);
  let feed = await get(app.base, "/events?type=CreditsPurchased");
  const ownerEv = feed.events.find((e) => e.txHash === ownerTx);
  assert.equal(ownerEv.label, "owner");
  assert.equal(ownerEv.requestId, null);
  assert.equal((await post(app.base, `/approvals/${ownerReqId}/verify`, { txHash: ownerTx })).request.status, "fulfilled_by_owner");

  feed = await get(app.base, "/events");
  const byTx = (tx, type) => feed.events.find((e) => e.txHash === tx.toLowerCase() && e.type === type);
  const agentBuy = byTx(agentReq.txHash, "CreditsPurchased");
  assert.equal(agentBuy.label, "agent");
  assert.equal(agentBuy.requestId, agentReq.id);
  assert.deepEqual(agentBuy.args.amountPaid, { base: "100000", mUSDC: "0.1" });
  assert.equal(agentBuy.args.credits, "10");
  const op = byTx(agentReq.txHash, "UserOperationEvent");
  assert.equal(op.label, "agent");
  assert.equal(op.requestId, agentReq.id);
  assert.equal(op.args.userOpHash, agentReq.userOpHash);
  assert.equal(op.args.nonceKey, s.config.agent.address.toLowerCase());
  assert.equal(op.args.success, true);
  assert.equal(byTx(agentReq.txHash, "AgentSpent").label, "agent");
  assert.deepEqual(byTx(agentReq.txHash, "AgentSpent").args.amount, { base: "100000", mUSDC: "0.1" });
  assert.equal(byTx(agentReq.txHash, "AgentExecuted").label, "agent");
  const ownerBuy = byTx(ownerTx, "CreditsPurchased");
  assert.equal(ownerBuy.label, "owner");
  assert.equal(ownerBuy.requestId, ownerReqId, "matched at read time after verify");
  assert.equal(ownerBuy.args.credits, "150");
  assert.equal(feed.events.filter((e) => e.txHash === ownerTx.toLowerCase()).some((e) => e.type === "AgentSpent"), false, "the owner purchase is not an agent spend");
  // newest first
  assert.ok(feed.events.every((e, i, all) => i === 0 || all[i - 1].blockNumber > e.blockNumber || (all[i - 1].blockNumber === e.blockNumber && all[i - 1].logIndex > e.logIndex)));
  assert.equal(feed.indexedToBlock, r1.indexedToBlock);
  s.agentReq = agentReq;
  s.ownerTx = ownerTx;
  await shutdown(app);
});

test("owner UserOp (nonce key 0), failed agent op and owner policy change are labelled", { skip }, async () => {
  const app = await boot(s.dbPath);
  // Owner purchase through the EntryPoint on nonce key 0, signed by the owner.
  const key0 = await s.reads.client.readContract({ address: s.config.addresses.entryPoint, abi: abi.entryPoint, functionName: "getNonce", args: [s.config.addresses.wallet, 0n] });
  const callData = encodeFunctionData({ abi: abi.wallet, functionName: "executeBatch", args: await ownerBatch(120) });
  const op = await signUserOp(s.ctx, await buildUserOp(s.ctx, { nonce: key0, callData }), s.ownerAccount);
  const sent = await submitUserOp(s.ctx, op, s.submitter);
  assert.equal(sent.success, true);
  // Agent op that is mined but fails (over maxPerTx): UserOperationRevertReason.
  const failed = await s.purchaser.purchaseCredits({ credits: 101 });
  assert.equal(failed.outcome, "failed_onchain");
  // Owner re-sets the agent's policy to the same values: PolicySet.
  const ag = await s.reads.getAgent();
  const p = await s.owner.writeContract({ address: s.config.addresses.wallet, abi: abi.wallet, functionName: "setPolicy", args: [s.config.agent.address, ag.token ?? ag[0]?.token ?? s.config.addresses.usdc, ag.maxPerTx, ag.dailyLimit] });
  await mined(p);

  const ix = indexerFor(app.store);
  await ix.sync();
  const feed = await get(app.base, "/events?limit=200");
  const ev = (tx, type) => feed.events.find((e) => e.txHash === tx.toLowerCase() && e.type === type);
  assert.equal(ev(sent.hash, "UserOperationEvent").label, "owner");
  assert.equal(ev(sent.hash, "UserOperationEvent").args.nonceKey, "0x0");
  assert.equal(ev(sent.hash, "CreditsPurchased").label, "owner", "a purchase inside an owner UserOp is the owner's");
  const rev = ev(failed.txHash, "UserOperationRevertReason");
  assert.equal(rev.label, "agent");
  assert.match(rev.args.reason, /^ExceedsPerTxLimit/);
  assert.equal(ev(failed.txHash, "UserOperationEvent").args.success, false);
  assert.equal(ev(p, "PolicySet").label, "owner");
  assert.deepEqual(ev(p, "PolicySet").args.maxPerTx, { base: "1000000", mUSDC: "1" });

  // Filters and paging.
  const only = await get(app.base, "/events?type=PolicySet,AgentRevoked");
  assert.ok(only.events.length >= 1 && only.events.every((e) => ["PolicySet", "AgentRevoked"].includes(e.type)));
  const page1 = await get(app.base, "/events?limit=2");
  const page2 = await get(app.base, `/events?limit=200&before=${page1.events[1].blockNumber}`);
  assert.ok(page2.events.every((e) => e.blockNumber < page1.events[1].blockNumber));
  assert.equal((await fetch(app.base + "/events?type=Transfer")).status, 400);
  assert.equal((await fetch(app.base + "/events?limit=0")).status, 400);
  await shutdown(app);
});

test("restart resumes from last_block: no duplicates, no gaps (also after a crash mid-sync)", { skip }, async () => {
  // 1. A restart with nothing new: nothing inserted.
  let app = await boot(s.dbPath);
  const before = keysOf(app.store.db);
  const again = await indexerFor(app.store).sync();
  assert.equal(again.inserted, 0);
  assert.deepEqual(keysOf(app.store.db), before);
  await shutdown(app);

  // 2. New purchase while "down", then a sync that crashes on its second chunk.
  const p1 = await s.purchaser.purchaseCredits({ credits: 3 });
  const p2 = await s.purchaser.purchaseCredits({ credits: 4 });
  assert.equal(p2.outcome, "succeeded");
  app = await boot(s.dbPath);
  const lastBefore = app.store.db.prepare("SELECT last_block FROM indexer_state").get().last_block;
  let calls = 0;
  const flaky = {
    ...s.reads.client,
    getBlockNumber: (a) => s.reads.client.getBlockNumber(a),
    getBlock: (a) => s.reads.client.getBlock(a),
    getTransaction: (a) => s.reads.client.getTransaction(a),
    getLogs: (a) => (++calls > 4 ? Promise.reject(new Error("connection reset")) : s.reads.client.getLogs(a)), // chunk 2 fails
  };
  await assert.rejects(indexerFor(app.store, { chunkSize: 1, client: flaky }).sync(), /connection reset/);
  const mid = app.store.db.prepare("SELECT last_block FROM indexer_state").get().last_block;
  assert.equal(mid, lastBefore + 1, "the first chunk was committed with its events, the failed one was not");
  await shutdown(app);

  // 3. Restart: resumes at mid + 1 and finishes.
  app = await boot(s.dbPath);
  const done = await indexerFor(app.store).sync();
  assert.equal(done.from, mid + 1);
  const resumed = keysOf(app.store.db);
  assert.equal(new Set(resumed).size, resumed.length, "no duplicate (tx, logIndex)");

  // 4. Compare with a clean index of the same range from scratch (separate DB): identical.
  const fresh = createStore(openDb(":memory:"), { secrets: [] });
  await indexerFor(fresh, { chunkSize: 5000 }).sync();
  assert.deepEqual(resumed, keysOf(fresh.db));
  for (const t of [p1.txHash, p2.txHash]) assert.ok(resumed.some((k) => k.startsWith(t.toLowerCase())), "purchases made while down are indexed");
  fresh.close();
  await shutdown(app);
});

test("an RPC block-range limit halves the chunk and still indexes everything", { skip }, async () => {
  const limited = {
    getBlockNumber: (a) => s.reads.client.getBlockNumber(a),
    getBlock: (a) => s.reads.client.getBlock(a),
    getTransaction: (a) => s.reads.client.getTransaction(a),
    getLogs: (a) => (a.toBlock - a.fromBlock + 1n > 3n ? Promise.reject(new Error("query exceeds max block range 3")) : s.reads.client.getLogs(a)),
  };
  const st = createStore(openDb(":memory:"), { secrets: [] });
  const ix = indexerFor(st, { chunkSize: 5000, client: limited });
  await ix.sync();
  assert.ok(ix.chunkSize <= 3);
  const app = await boot(s.dbPath);
  assert.deepEqual(keysOf(st.db), keysOf(app.store.db));
  st.close();
  await shutdown(app);
});

test("a database indexed on another chain is refused; nonce split", { skip }, async () => {
  const st = createStore(openDb(":memory:"), { secrets: [] });
  st.db.prepare("INSERT INTO indexer_state (id, chain_id, last_block) VALUES (1, 84532, 5)").run();
  assert.throws(() => indexerFor(st).state(), /indexed on chain 84532/);
  st.close();
  const n = splitNonce((BigInt(s.config.agent.address) << 64n) | 7n);
  assert.deepEqual([n.label, n.sequence, n.keyHex], ["agent", 7n, s.config.agent.address.toLowerCase()]);
  assert.deepEqual([splitNonce(3n).label, splitNonce(3n).sequence], ["owner", 3n]);
});
