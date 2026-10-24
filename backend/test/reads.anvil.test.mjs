// Read tests against a local Anvil deployment (Deploy.s.sol + ConfigureAgent.s.sol with agent = Anvil account #1).
// Skipped when Anvil is not running on ANVIL_RPC_URL (default http://127.0.0.1:8545) or deployments/31337.json is missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { loadConfig, ConfigError } from "../src/config.js";
import { createReads, assertStartup, StartupError, amount, formatUsdc } from "../src/chain/reads.js";

// Anvil's published dev keys: #0 = owner/deployer, #1 = agent, #2 = submitter, #3 = not an agent.
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
];
const RPC = process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:8545";
const env = { CHAIN_ID: "31337", RPC_URL: RPC, AGENT_PRIVATE_KEY: KEYS[1], SUBMITTER_PRIVATE_KEY: KEYS[2] };

async function anvilReady() {
  if (!existsSync(new URL("../../contracts/deployments/31337.json", import.meta.url))) return "contracts/deployments/31337.json missing (run Deploy.s.sol on Anvil)";
  try {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }) });
    const { result } = await r.json();
    return Number(result) === 31337 ? false : `RPC at ${RPC} is chain ${Number(result)}, not 31337`;
  } catch {
    return `Anvil not running at ${RPC}`;
  }
}
const skip = await anvilReady();

test("startup passes with the configured agent", { skip }, async () => {
  const config = loadConfig(env);
  const r = await assertStartup(config, createReads(config));
  assert.equal(r.rpcChainId, 31337);
  assert.equal(r.agentValidNow, true);
});

test("snapshot matches the ConfigureAgent policy and the individual reads", { skip }, async () => {
  const config = loadConfig(env);
  const reads = createReads(config);
  const s = await reads.snapshot();
  assert.deepEqual(s.checks, { entryPointIsV07: true, walletEntryPointOk: true, factoryWalletOk: true, walletOwnerOk: true, merchantTokenOk: true });
  assert.equal(s.agent.active, true);
  assert.equal(s.agent.validNow, true);
  assert.equal(s.agent.token, config.addresses.usdc);
  assert.equal(s.agent.canPurchase, true);
  assert.equal(s.agent.merchantAllowed, true);
  assert.equal(typeof s.agent.maxPerTx, "bigint");
  assert.ok(s.agent.remainingDailyAllowance <= s.agent.dailyLimit);
  assert.equal(s.agent.remainingDailyAllowance, s.agent.dailyLimit - s.agent.spentToday);
  // Agent nonce: key = agent address in the top 192 bits.
  assert.equal(s.agent.nextNonce >> 64n, BigInt(config.agent.address));
  assert.equal(s.agent.nextNonce, await reads.agentNonce());
  assert.equal(s.wallet.balance, await reads.walletBalance());
  assert.equal(s.wallet.entryPointDeposit, await reads.getDeposit());
  assert.equal(s.wallet.credits, await reads.creditsOf());
  assert.equal(s.wallet.merchantAllowance, await reads.merchantAllowance());
});

test("quote and formatting keep base units as bigint", { skip }, async () => {
  const reads = createReads(loadConfig(env));
  const price = await reads.quote(100);
  assert.equal(price, 100n * (await reads.pricePerCredit()));
  assert.equal(price, 1_000_000n); // 100 credits = 1 mUSDC at 0.01 mUSDC per credit
  assert.equal(formatUsdc(price), "1");
  assert.deepEqual(amount(1_500_000n), { base: "1500000", mUSDC: "1.5" });
});

test("startup fails clearly with an unregistered agent key", { skip }, async () => {
  const config = loadConfig({ ...env, AGENT_PRIVATE_KEY: KEYS[3] });
  await assert.rejects(assertStartup(config, createReads(config)), (e) => e instanceof StartupError && /Wrong agent key/.test(e.message));
});

test("startup fails clearly with the wrong chain", { skip }, async () => {
  // Base Sepolia config pointed at the Anvil RPC.
  const config = loadConfig({ ...env, CHAIN_ID: "84532" });
  await assert.rejects(assertStartup(config, createReads(config)), (e) => e instanceof StartupError && /Wrong chain: RPC_URL is chain 31337, but CHAIN_ID is 84532/.test(e.message));
});

test("refuses the owner key as submitter", { skip }, () => {
  assert.throws(() => loadConfig({ ...env, SUBMITTER_PRIVATE_KEY: KEYS[0] }), (e) => e instanceof ConfigError && /owner's key/.test(e.message));
});
