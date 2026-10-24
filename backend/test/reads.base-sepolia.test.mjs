// Read-only tests against the live Base Sepolia deployment. Sends nothing.
// Needs AGENT_PRIVATE_KEY and SUBMITTER_PRIVATE_KEY in backend/.env (run with `npm test` or `npm run test:sepolia`).
// RPC: BASE_SEPOLIA_RPC_URL, else RPC_URL when CHAIN_ID is 84532, else https://sepolia.base.org.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { createReads, assertStartup } from "../src/chain/reads.js";

const e = process.env;
const env = {
  ...e,
  CHAIN_ID: "84532",
  RPC_URL: e.BASE_SEPOLIA_RPC_URL || ((e.CHAIN_ID ?? "84532") === "84532" && e.RPC_URL) || "https://sepolia.base.org",
};
const skip = e.AGENT_PRIVATE_KEY && e.SUBMITTER_PRIVATE_KEY ? false : "AGENT_PRIVATE_KEY / SUBMITTER_PRIVATE_KEY not set in backend/.env";

test("Base Sepolia: startup checks pass", { skip, timeout: 60_000 }, async () => {
  const config = loadConfig(env);
  const r = await assertStartup(config, createReads(config));
  assert.equal(r.rpcChainId, 84532);
});

test("Base Sepolia: live state matches what Status.s.sol checks", { skip, timeout: 60_000 }, async () => {
  const config = loadConfig(env);
  const s = await createReads(config).snapshot();
  assert.equal(config.addresses.entryPoint, "0x0000000071727De22E5E9d8BAf0edAc6f37da032");
  assert.deepEqual(s.checks, { entryPointIsV07: true, walletEntryPointOk: true, factoryWalletOk: true, walletOwnerOk: true, merchantTokenOk: true });
  assert.equal(s.agent.active, true);
  assert.equal(s.agent.validNow, true, "agent expired: revoke and rerun ConfigureAgent (docs/PHASE12_FINAL.md §8)");
  assert.equal(s.agent.token, config.addresses.usdc);
  assert.equal(s.agent.canPurchase, true);
  assert.equal(s.agent.merchantAllowed, true);
  assert.equal(s.agent.remainingDailyAllowance, s.agent.dailyLimit - s.agent.spentToday);
  assert.equal(s.agent.nextNonce >> 64n, BigInt(config.agent.address));
  assert.equal(s.merchant.pricePerCredit, 10_000n);
});
