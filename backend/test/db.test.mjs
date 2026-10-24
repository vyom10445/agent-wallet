// Offline tests for src/db/: schema, every allowed and forbidden transition, proofs, amounts, secrets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, createStore, STATUSES, TRANSITIONS, TransitionError, SecretLeakError } from "../src/db/index.js";

const AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // Anvil #1, stands in for a secret
const h = (n) => "0x" + n.toString(16).padStart(64, "0");
let seq = 1;
const fresh = () => createStore(openDb(":memory:"), { secrets: [KEY.slice(2)] });
const proof = (credits = 10) => ({ purchaseId: 7n, credits: BigInt(credits), amountPaid: BigInt(credits) * 10_000n });

/** Fields that make each target valid, so the matrix test checks only the arrow itself. */
const validFields = (to) => {
  const tx = h(seq++);
  return {
    precheck_failed: { errorCode: "PRECHECK_BLOCKED" },
    submitted: { path: "agent", precheck: "AGENT_OK", price: 100_000n, nonce: 5n, userOpHash: h(seq++), txHash: tx },
    succeeded: { purchase: proof() },
    failed_onchain: { errorCode: "ExceedsPerTxLimit" },
    needs_owner_approval: { path: "owner", precheck: "NEEDS_OWNER", price: 1_500_000n },
    fulfilled_by_owner: { txHash: tx, purchase: proof() },
    rejected: { ownerNote: "no" },
    expired: {},
    received: {},
  }[to];
};
/** Drives a new request to `status` along allowed arrows. */
const PATH = {
  received: [], precheck_failed: ["precheck_failed"], submitted: ["submitted"], succeeded: ["submitted", "succeeded"],
  failed_onchain: ["submitted", "failed_onchain"], needs_owner_approval: ["needs_owner_approval"],
  fulfilled_by_owner: ["needs_owner_approval", "fulfilled_by_owner"], rejected: ["needs_owner_approval", "rejected"],
  expired: ["needs_owner_approval", "expired"],
};
function requestIn(store, status) {
  const r = store.createRequest({ credits: 10, reason: "test", agentAddress: AGENT });
  for (const to of PATH[status]) store.transition(r.id, to, validFields(to));
  return store.getRequest(r.id);
}

test("schema: tables exist, version 1, no column can hold a key", () => {
  const s = fresh();
  const tables = s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  for (const t of ["chain_events", "chat_messages", "indexer_state", "purchase_requests"]) assert.ok(tables.includes(t), t);
  assert.equal(s.db.prepare("PRAGMA user_version").get().user_version, 1);
  for (const t of ["purchase_requests", "chat_messages"]) {
    const cols = s.db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.ok(!cols.some((c) => /key|secret|mnemonic|seed/i.test(c)), `${t}: ${cols}`);
  }
});

test("allowed transitions: every arrow in the lifecycle works", () => {
  const s = fresh();
  for (const [from, tos] of Object.entries(TRANSITIONS)) {
    for (const to of tos) {
      const r = requestIn(s, from);
      assert.equal(s.transition(r.id, to, validFields(to)).status, to, `${from} -> ${to}`);
    }
  }
});

test("forbidden transitions: every other pair throws and leaves the row unchanged", () => {
  const s = fresh();
  let checked = 0;
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      if (TRANSITIONS[from].includes(to)) continue;
      const r = requestIn(s, from);
      assert.throws(() => s.transition(r.id, to, validFields(to)), TransitionError, `${from} -> ${to}`);
      assert.deepEqual(s.getRequest(r.id), r);
      checked++;
    }
  }
  assert.equal(checked, 81 - 9);
});

test("needs_owner_approval -> succeeded without a tx hash throws (acceptance)", () => {
  const s = fresh();
  const r = requestIn(s, "needs_owner_approval");
  assert.throws(() => s.transition(r.id, "succeeded"), /needs_owner_approval -> succeeded is not allowed/);
  assert.equal(s.getRequest(r.id).status, "needs_owner_approval");
});

test("succeeded / fulfilled_by_owner need the tx hash AND the decoded CreditsPurchased", () => {
  const s = fresh();
  const sub = requestIn(s, "submitted");
  assert.throws(() => s.transition(sub.id, "succeeded"), /CreditsPurchased event is required/);
  assert.throws(() => s.transition(sub.id, "succeeded", { purchase: proof(11) }), /does not match the request's 10/);
  const own = requestIn(s, "needs_owner_approval");
  assert.throws(() => s.transition(own.id, "fulfilled_by_owner", { purchase: proof() }), /txHash is required/);
  assert.throws(() => s.transition(own.id, "fulfilled_by_owner", { txHash: h(999) }), /CreditsPurchased event is required/);
  const done = s.transition(own.id, "fulfilled_by_owner", { txHash: h(999), purchase: proof() });
  assert.equal(done.amountPaid, 100_000n);
  assert.equal(done.purchaseId, 7n);
});

test("required fields per target", () => {
  const s = fresh();
  const r1 = s.createRequest({ credits: 10, agentAddress: AGENT });
  assert.throws(() => s.transition(r1.id, "submitted", { path: "agent", txHash: h(1) }), /userOpHash and nonce are required/);
  assert.throws(() => s.transition(r1.id, "needs_owner_approval", { path: "owner", precheck: "AGENT_OK" }), /precheck must be NEEDS_OWNER/);
  assert.throws(() => s.transition(r1.id, "precheck_failed"), /errorCode is required/);
  assert.throws(() => s.transition(r1.id, "submitted", { ...validFields("submitted"), txHash: "0x1234" }), /32-byte hex/);
});

test("a hand-edited row cannot become succeeded without proof (SQL CHECK backstop)", () => {
  const s = fresh();
  const r = requestIn(s, "needs_owner_approval");
  assert.throws(() => s.db.prepare("UPDATE purchase_requests SET status = 'fulfilled_by_owner' WHERE id = ?").run(r.id), /CHECK constraint failed/);
  assert.throws(() => s.db.prepare("UPDATE purchase_requests SET status = 'succeeded', tx_hash = ? WHERE id = ?").run(h(5), r.id), /CHECK constraint failed/);
});

test("one tx hash can prove only one request", () => {
  const s = fresh();
  const a = requestIn(s, "needs_owner_approval");
  const b = requestIn(s, "needs_owner_approval");
  s.transition(a.id, "fulfilled_by_owner", { txHash: h(42), purchase: proof() });
  assert.throws(() => s.transition(b.id, "fulfilled_by_owner", { txHash: h(42), purchase: proof() }), /UNIQUE constraint failed/);
  assert.equal(s.getRequest(b.id).status, "needs_owner_approval");
});

test("amounts are stored as base-unit strings, never floats", () => {
  const s = fresh();
  const r = s.createRequest({ credits: 10, agentAddress: AGENT });
  s.transition(r.id, "needs_owner_approval", { path: "owner", precheck: "NEEDS_OWNER", price: 1_500_000n });
  const raw = s.db.prepare("SELECT price_base, typeof(price_base) AS t FROM purchase_requests WHERE id = ?").get(r.id);
  assert.deepEqual({ ...raw }, { price_base: "1500000", t: "text" });
  assert.equal(s.getRequest(r.id).price, 1_500_000n);
  const r2 = s.createRequest({ credits: 10, agentAddress: AGENT });
  assert.throws(() => s.transition(r2.id, "needs_owner_approval", { path: "owner", precheck: "NEEDS_OWNER", price: 1.5 }), /bigint or base-unit string/);
});

test("secrets from the env are refused in every text field", () => {
  const s = fresh();
  assert.throws(() => s.createRequest({ credits: 1, agentAddress: AGENT, reason: `my key is ${KEY}` }), SecretLeakError);
  assert.throws(() => s.addChatMessage({ role: "user", content: `use ${KEY.slice(2).toUpperCase()}` }), SecretLeakError);
  const r = s.createRequest({ credits: 1, agentAddress: AGENT });
  assert.throws(() => s.transition(r.id, "precheck_failed", { errorCode: "X", errorText: KEY }), SecretLeakError);
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM chat_messages").get().n, 0);
});

test("expireDue moves overdue owner approvals to expired", () => {
  let t = 1000;
  const s = createStore(openDb(":memory:"), { secrets: [], clock: () => t });
  const r = s.createRequest({ credits: 500, agentAddress: AGENT, expiresAt: 2000 });
  s.transition(r.id, "needs_owner_approval", { path: "owner", precheck: "NEEDS_OWNER" });
  assert.deepEqual(s.expireDue(1999), []);
  assert.deepEqual(s.expireDue(2000), [r.id]);
  assert.equal(s.getRequest(r.id).status, "expired");
});

test("listRequests filters and chat messages keep order", () => {
  const s = fresh();
  requestIn(s, "succeeded");
  requestIn(s, "needs_owner_approval");
  assert.equal(s.listRequests({ status: "succeeded" }).length, 1);
  assert.equal(s.listRequests({ status: "succeeded,needs_owner_approval" }).length, 2);
  assert.throws(() => s.listRequests({ status: "paid" }), /unknown status/);
  s.addChatMessage({ role: "user", content: "buy 10 credits" });
  s.addChatMessage({ role: "tool", content: "{}", toolName: "buy_credits", toolCallId: "t1" });
  s.addChatMessage({ role: "assistant", content: "done" });
  assert.deepEqual(s.listChatMessages().map((m) => m.role), ["user", "assistant"]);
  assert.equal(s.listChatMessages({ includeTool: true }).length, 3);
});
