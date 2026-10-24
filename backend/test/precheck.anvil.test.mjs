// Phase 5 acceptance on Anvil. Every test runs inside an evm_snapshot and is reverted afterwards, so the agent's
// daily spend, the allowance and the agent list are left exactly as they were.
// Uses the Anvil owner key (#0) only to change state the way the real owner would (approve, transfer, add/revoke agent).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createWalletClient, http, encodeFunctionData, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig, abi } from "../src/config.js";
import { createReads } from "../src/chain/reads.js";
import { createPurchaser } from "../src/chain/userop.js";
import { precheck, PRECHECK } from "../src/policy/precheck.js";
import { ANVIL_KEYS, anvilEnv, anvilSkipReason } from "./helpers/anvil.mjs";

const skip = await anvilSkipReason();
const OTHER_AGENT = privateKeyToAccount(ANVIL_KEYS[4]).address; // Anvil #4, used only for the revoke test

let s, snapshotId;
beforeEach(async () => {
  if (skip) return;
  const config = loadConfig(anvilEnv);
  const reads = createReads(config);
  const owner = createWalletClient({ account: privateKeyToAccount(ANVIL_KEYS[0]), chain: config.chain, transport: http(config.rpcUrl) });
  const submitter = createWalletClient({ account: config.submitter, chain: config.chain, transport: http(config.rpcUrl) });
  s = { config, reads, owner, purchaser: createPurchaser(config, reads, { walletClient: submitter }) };
  snapshotId = await reads.client.request({ method: "evm_snapshot" });
  // Known starting point inside the snapshot: enough allowance, balance and gas deposit.
  await asOwner("execute", [config.addresses.usdc, 0n, encodeFunctionData({ abi: abi.usdc, functionName: "approve", args: [config.addresses.merchant, 100_000_000n] })]);
  await asOwner("addDeposit", [], parseEther("0.05"));
});
afterEach(async () => {
  if (skip) return;
  assert.equal(await s.reads.client.request({ method: "evm_revert", params: [snapshotId] }), true);
});

async function asOwner(functionName, args, value) {
  const hash = await s.owner.writeContract({ address: s.config.addresses.wallet, abi: abi.wallet, functionName, args, value });
  const receipt = await s.reads.client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", functionName);
}

test("100 credits (1 mUSDC) -> AGENT_OK; 101 credits -> NEEDS_OWNER (default policy)", { skip }, async () => {
  const info = await s.reads.getAgent();
  assert.equal(info.maxPerTx, 1_000_000n);
  assert.ok((await s.reads.remainingDailyAllowance()) >= 1_010_000n, "needs at least 1.01 mUSDC left today on Anvil");
  const ok = await precheck(s.reads, { credits: 100 });
  assert.equal(ok.result, PRECHECK.AGENT_OK);
  assert.equal(ok.price, 1_000_000n);
  assert.equal(ok.advisory, true);
  const over = await precheck(s.reads, { credits: 101 });
  assert.equal(over.result, PRECHECK.NEEDS_OWNER);
  assert.deepEqual(over.reasons.map((r) => r.code), ["EXCEEDS_PER_TX"]);
});

test("after 5 mUSDC of agent spend today -> NEEDS_OWNER (and exactly the remaining amount is AGENT_OK before that)", { skip }, async () => {
  // Spend in 1 mUSDC chunks until less than 1 mUSDC is left.
  while ((await s.reads.remainingDailyAllowance()) >= 1_000_000n) {
    const r = await s.purchaser.purchaseCredits({ credits: 100 });
    assert.equal(r.outcome, "succeeded", r.message);
  }
  const left = await s.reads.remainingDailyAllowance();
  if (left > 0n) {
    const exact = Number(left / 10_000n); // credits that cost exactly what is left (prices are multiples of 0.01)
    assert.equal((await precheck(s.reads, { credits: exact })).result, PRECHECK.AGENT_OK);
    assert.equal((await precheck(s.reads, { credits: exact + 1 })).result, PRECHECK.NEEDS_OWNER);
    assert.equal((await s.purchaser.purchaseCredits({ credits: exact })).outcome, "succeeded");
  }
  const info = await s.reads.getAgent();
  assert.equal(info.spentToday, info.dailyLimit); // 5 mUSDC spent
  const r = await precheck(s.reads, { credits: 1 });
  assert.equal(r.result, PRECHECK.NEEDS_OWNER);
  assert.deepEqual(r.reasons.map((x) => x.code), ["EXCEEDS_DAILY"]);
});

test("a revoked agent -> BLOCKED", { skip }, async () => {
  const now = BigInt(Math.floor(Date.now() / 1000));
  await asOwner("addAgent", [OTHER_AGENT, 0, Number(now + 86_400n)]);
  await asOwner("setPolicy", [OTHER_AGENT, s.config.addresses.usdc, 1_000_000n, 5_000_000n]);
  await asOwner("allowCall", [OTHER_AGENT, s.config.addresses.merchant, "0x70876c98", true]);
  await asOwner("allowRecipient", [OTHER_AGENT, s.config.addresses.merchant, true]);
  assert.equal((await precheck(s.reads, { credits: 10 }, { agent: OTHER_AGENT })).result, PRECHECK.AGENT_OK);
  await asOwner("revokeAgent", [OTHER_AGENT]);
  const r = await precheck(s.reads, { credits: 10 }, { agent: OTHER_AGENT });
  assert.equal(r.result, PRECHECK.BLOCKED);
  assert.ok(r.reasons.some((x) => x.code === "AGENT_NOT_ACTIVE"));
});

test("merchant allowance or wallet balance too low -> NEEDS_OWNER_TOPUP", { skip }, async () => {
  const { usdc, merchant } = s.config.addresses;
  await asOwner("execute", [usdc, 0n, encodeFunctionData({ abi: abi.usdc, functionName: "approve", args: [merchant, 50_000n] })]);
  const r = await precheck(s.reads, { credits: 10 }); // 0.1 mUSDC > 0.05 allowance
  assert.equal(r.result, PRECHECK.NEEDS_OWNER_TOPUP);
  assert.deepEqual(r.reasons.map((x) => x.code), ["ALLOWANCE_TOO_LOW"]);

  await asOwner("execute", [usdc, 0n, encodeFunctionData({ abi: abi.usdc, functionName: "approve", args: [merchant, 100_000_000n] })]);
  const balance = await s.reads.walletBalance();
  await asOwner("execute", [usdc, 0n, encodeFunctionData({ abi: abi.usdc, functionName: "transfer", args: [s.owner.account.address, balance] })]);
  const b = await precheck(s.reads, { credits: 1 });
  assert.equal(b.result, PRECHECK.NEEDS_OWNER_TOPUP);
  assert.deepEqual(b.reasons.map((x) => x.code), ["BALANCE_TOO_LOW"]);
});

test("credits == 0 -> BLOCKED without any read", { skip }, async () => {
  const r = await precheck(s.reads, { credits: 0 });
  assert.equal(r.result, PRECHECK.BLOCKED);
  assert.equal(r.price, null);
});

test("the pre-check reads fresh state every call (no cache)", { skip }, async () => {
  assert.equal((await precheck(s.reads, { credits: 10 })).result, PRECHECK.AGENT_OK);
  await asOwner("allowRecipient", [s.config.agent.address, s.config.addresses.merchant, false]);
  const r = await precheck(s.reads, { credits: 10 });
  assert.equal(r.result, PRECHECK.BLOCKED);
  assert.deepEqual(r.reasons.map((x) => x.code), ["RECIPIENT_NOT_ALLOWED"]);
});
