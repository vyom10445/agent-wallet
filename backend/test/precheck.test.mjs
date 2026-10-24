// Unit tests for the pure pre-check decision: every boundary, in base units. No chain needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePrecheck, PRECHECK } from "../src/policy/precheck.js";

const USDC = "0xC91a11d7096c0685590267C083Fd67A518D65C3F";
// Default live policy (ConfigureAgent): maxPerTx 1 mUSDC, dailyLimit 5 mUSDC, allowance 10 mUSDC, balance 100 mUSDC.
const state = (over = {}, agentOver = {}) => ({
  credits: 1,
  price: 10_000n,
  usdc: USDC,
  merchantAllowance: 10_000_000n,
  walletBalance: 100_000_000n,
  ...over,
  agent: { active: true, validNow: true, token: USDC, maxPerTx: 1_000_000n, remainingDailyAllowance: 5_000_000n, canPurchase: true, merchantAllowed: true, ...agentOver },
});
const codes = (r) => r.reasons.map((x) => x.code);

test("price exactly maxPerTx -> AGENT_OK", () => {
  const r = evaluatePrecheck(state({ price: 1_000_000n }));
  assert.equal(r.result, PRECHECK.AGENT_OK);
  assert.deepEqual(r.reasons, []);
});

test("price maxPerTx + 1 base unit -> NEEDS_OWNER", () => {
  const r = evaluatePrecheck(state({ price: 1_000_001n }));
  assert.equal(r.result, PRECHECK.NEEDS_OWNER);
  assert.deepEqual(codes(r), ["EXCEEDS_PER_TX"]);
});

test("price exactly the remaining daily allowance -> AGENT_OK; +1 base unit -> NEEDS_OWNER", () => {
  assert.equal(evaluatePrecheck(state({ price: 400_000n }, { remainingDailyAllowance: 400_000n })).result, PRECHECK.AGENT_OK);
  const r = evaluatePrecheck(state({ price: 400_001n }, { remainingDailyAllowance: 400_000n }));
  assert.equal(r.result, PRECHECK.NEEDS_OWNER);
  assert.deepEqual(codes(r), ["EXCEEDS_DAILY"]);
});

test("daily allowance used up -> NEEDS_OWNER for even 1 credit", () => {
  assert.equal(evaluatePrecheck(state({ price: 10_000n }, { remainingDailyAllowance: 0n })).result, PRECHECK.NEEDS_OWNER);
});

test("price exactly the merchant allowance -> AGENT_OK; +1 -> NEEDS_OWNER_TOPUP", () => {
  assert.equal(evaluatePrecheck(state({ price: 500_000n, merchantAllowance: 500_000n })).result, PRECHECK.AGENT_OK);
  const r = evaluatePrecheck(state({ price: 500_001n, merchantAllowance: 500_000n }));
  assert.equal(r.result, PRECHECK.NEEDS_OWNER_TOPUP);
  assert.deepEqual(codes(r), ["ALLOWANCE_TOO_LOW"]);
});

test("price exactly the wallet balance -> AGENT_OK; +1 -> NEEDS_OWNER_TOPUP", () => {
  assert.equal(evaluatePrecheck(state({ price: 300_000n, walletBalance: 300_000n })).result, PRECHECK.AGENT_OK);
  const r = evaluatePrecheck(state({ price: 300_001n, walletBalance: 300_000n }));
  assert.equal(r.result, PRECHECK.NEEDS_OWNER_TOPUP);
  assert.deepEqual(codes(r), ["BALANCE_TOO_LOW"]);
});

test("credits == 0 (or not an integer in range) -> BLOCKED", () => {
  for (const credits of [0, -1, 1.5, 10_001, "10", undefined]) {
    const r = evaluatePrecheck(state({ credits }));
    assert.equal(r.result, PRECHECK.BLOCKED, String(credits));
    assert.deepEqual(codes(r), ["INVALID_CREDITS"]);
  }
});

test("revoked, expired, call or recipient not allowed, wrong token -> BLOCKED", () => {
  const cases = [
    [{ active: false, validNow: false }, "AGENT_NOT_ACTIVE"],
    [{ validNow: false }, "AGENT_NOT_VALID"],
    [{ canPurchase: false }, "CALL_NOT_ALLOWED"],
    [{ merchantAllowed: false }, "RECIPIENT_NOT_ALLOWED"],
    [{ token: "0x0000000000000000000000000000000000000001" }, "WRONG_POLICY_TOKEN"],
  ];
  for (const [agentOver, code] of cases) {
    const r = evaluatePrecheck(state({}, agentOver));
    assert.equal(r.result, PRECHECK.BLOCKED, code);
    assert.deepEqual(codes(r), [code]);
  }
});

test("BLOCKED beats NEEDS_OWNER, NEEDS_OWNER beats NEEDS_OWNER_TOPUP, all reasons are listed", () => {
  assert.equal(evaluatePrecheck(state({ price: 2_000_000n }, { active: false })).result, PRECHECK.BLOCKED);
  const r = evaluatePrecheck(state({ price: 2_000_000n, merchantAllowance: 0n }));
  assert.equal(r.result, PRECHECK.NEEDS_OWNER);
  assert.deepEqual(codes(r), ["EXCEEDS_PER_TX", "ALLOWANCE_TOO_LOW"]);
});

test("messages show mUSDC amounts", () => {
  const r = evaluatePrecheck(state({ price: 1_010_000n }));
  assert.equal(r.reasons[0].message, "Price 1.01 mUSDC is above maxPerTx 1 mUSDC.");
});
