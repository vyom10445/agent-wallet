// Step 4.2: the UserOp pipeline against a local Anvil deployment (Deploy.s.sol + ConfigureAgent.s.sol, agent = Anvil #1).
// Spends a little of the agent's daily limit and the merchant allowance per run; rerun ConfigureAgent to top up.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createWalletClient, http, encodeFunctionData, parseEther } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { loadConfig, abi } from "../src/config.js";
import { createReads } from "../src/chain/reads.js";
import { createPurchaser, buildUserOp, signUserOp, submitUserOp, errorCode, explainError } from "../src/chain/userop.js";
import { ANVIL_KEYS, anvilEnv, anvilSkipReason } from "./helpers/anvil.mjs";

const skip = await anvilSkipReason();
const setup = () => {
  const config = loadConfig(anvilEnv);
  const reads = createReads(config);
  const ctx = { client: reads.client, addresses: config.addresses };
  const submitter = createWalletClient({ account: config.submitter, chain: config.chain, transport: http(config.rpcUrl) });
  return { config, reads, ctx, submitter, purchaser: createPurchaser(config, reads, { walletClient: submitter }) };
};
// Anvil charges about 1 gwei, so each op uses roughly 0.0003 ETH of the wallet's EntryPoint deposit and the
// ConfigureAgent default (0.005 ETH) runs out after about a dozen ops. Top it up for the tests (addDeposit is
// payable by anyone; the Anvil submitter pays). On Base Sepolia fees are about 1000x lower.
before(async () => {
  if (skip) return;
  const s = setup();
  if ((await s.reads.getDeposit()) < parseEther("0.02")) {
    const hash = await s.submitter.writeContract({ address: s.config.addresses.wallet, abi: abi.wallet, functionName: "addDeposit", value: parseEther("0.05") });
    await s.reads.client.waitForTransactionReceipt({ hash });
  }
});

/** Raw agent op for `credits`, for the failure tests that need to bend one rule. */
async function rawOp({ config, reads, ctx }, { credits = 1, nonce, signer = config.agent } = {}) {
  const price = await reads.quote(credits);
  const inner = encodeFunctionData({ abi: abi.merchant, functionName: "purchase", args: [BigInt(credits), price] });
  const callData = encodeFunctionData({ abi: abi.wallet, functionName: "executeAsAgent", args: [config.agent.address, config.addresses.merchant, 0n, inner] });
  return signUserOp(ctx, await buildUserOp(ctx, { nonce: nonce ?? (await reads.agentNonce()), callData }), signer);
}
async function rejects(promise) {
  try {
    await promise;
  } catch (e) {
    return { code: errorCode(e), message: explainError(e) };
  }
  assert.fail("expected a rejection");
}

test("a 10-credit purchase succeeds and creditsOf(wallet) grows by 10", { skip }, async () => {
  const s = setup();
  const before = await s.reads.creditsOf();
  const nonce = await s.reads.agentNonce();
  const r = await s.purchaser.purchaseCredits({ credits: 10 });
  assert.equal(r.outcome, "succeeded", r.message);
  assert.equal(r.code, null);
  assert.equal(await s.reads.creditsOf(), before + 10n);
  assert.equal(r.purchase.credits, 10n);
  assert.equal(r.purchase.amountPaid, 100_000n);
  assert.equal(r.nonce, nonce);
  assert.equal(r.nonce >> 64n, BigInt(s.config.agent.address)); // nonce key = agent address
  assert.match(r.txHash, /^0x[0-9a-f]{64}$/);
  assert.ok(r.events.some((e) => e.eventName === "AgentSpent"));
});

test("two back-to-back purchases both succeed (queue, no AA25)", { skip }, async () => {
  const s = setup();
  const before = await s.reads.creditsOf();
  const [a, b] = await Promise.all([s.purchaser.purchaseCredits({ credits: 2 }), s.purchaser.purchaseCredits({ credits: 3 })]);
  assert.equal(a.outcome, "succeeded", a.message);
  assert.equal(b.outcome, "succeeded", b.message);
  assert.equal(b.nonce, a.nonce + 1n);
  assert.equal(await s.reads.creditsOf(), before + 5n);
});

test("without the queue, reusing a nonce gives AA25", { skip }, async () => {
  const s = setup();
  const nonce = await s.reads.agentNonce();
  const first = await rawOp(s, { nonce });
  const second = await rawOp(s, { credits: 2, nonce });
  assert.equal((await submitUserOp(s.ctx, first, s.submitter)).success, true);
  const e = await rejects(submitUserOp(s.ctx, second, s.submitter));
  assert.equal(e.code, "AA25", e.message);
});

test("handleOps gas too low reproduces AA95; the default BUNDLE_GAS_LIMIT works", { skip }, async () => {
  const s = setup();
  const op = await rawOp(s);
  // Measured on Anvil: a 1-credit op hits AA95 at 600k handleOps gas and passes from about 700k, because the
  // EntryPoint only checks the call gas (500k) plus overhead at that point. 1.26M keeps the full declared margin.
  const e = await rejects(submitUserOp(s.ctx, op, s.submitter, { gas: 600_000n }));
  assert.equal(e.code, "AA95", e.message);
  const ok = await submitUserOp(s.ctx, op, s.submitter); // same op, default gas
  assert.equal(ok.success, true);
});

test("an op signed with the wrong key is rejected in simulation with AA24 and nothing is sent", { skip }, async () => {
  const s = setup();
  const sent = await s.reads.client.getTransactionCount({ address: s.config.submitter.address });
  const nonce = await s.reads.agentNonce();
  const op = await rawOp(s, { signer: privateKeyToAccount(ANVIL_KEYS[3]) });
  const e = await rejects(submitUserOp(s.ctx, op, s.submitter));
  assert.equal(e.code, "AA24", e.message);
  assert.equal(await s.reads.client.getTransactionCount({ address: s.config.submitter.address }), sent);
  assert.equal(await s.reads.agentNonce(), nonce);
});

test("an agent op on nonce key 0 is rejected with AA24", { skip }, async () => {
  const s = setup();
  const key0 = await s.reads.client.readContract({ address: s.config.addresses.entryPoint, abi: abi.entryPoint, functionName: "getNonce", args: [s.config.addresses.wallet, 0n] });
  const e = await rejects(submitUserOp(s.ctx, await rawOp(s, { nonce: key0 }), s.submitter));
  assert.equal(e.code, "AA24", e.message);
});

test("an over-limit purchase is mined but reported as failed_onchain with ExceedsPerTxLimit", { skip }, async () => {
  const s = setup();
  const before = await s.reads.creditsOf();
  const r = await s.purchaser.purchaseCredits({ credits: 101 }); // 1.01 mUSDC > maxPerTx 1 mUSDC
  assert.equal(r.outcome, "failed_onchain");
  assert.equal(r.code, "ExceedsPerTxLimit", r.message);
  assert.match(r.message, /^ExceedsPerTxLimit\(1010000, 1000000\)$/);
  assert.ok(r.txHash);
  assert.equal(await s.reads.creditsOf(), before);
});

test("a submitter without ETH is refused before sending (SUBMITTER_LOW)", { skip }, async () => {
  const s = setup();
  const broke = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: s.config.chain, transport: http(s.config.rpcUrl) });
  const nonce = await s.reads.agentNonce();
  const r = await createPurchaser(s.config, s.reads, { walletClient: broke }).purchaseCredits({ credits: 1 });
  assert.equal(r.outcome, "not_sent");
  assert.equal(r.code, "SUBMITTER_LOW");
  assert.equal(await s.reads.agentNonce(), nonce);
});

test("a deposit under the threshold warns DEPOSIT_LOW but still buys", { skip }, async () => {
  const s = setup();
  const r = await createPurchaser(s.config, s.reads, { walletClient: s.submitter, minDepositWei: 10n ** 30n }).purchaseCredits({ credits: 1 });
  assert.equal(r.outcome, "succeeded", r.message);
  assert.deepEqual(r.warnings, ["DEPOSIT_LOW"]);
});

test("a deposit below the op's prefund is refused before sending (AA21)", { skip }, async () => {
  const s = setup();
  const nonce = await s.reads.agentNonce();
  const emptyDeposit = { ...s.reads, getDeposit: async () => 0n };
  const r = await createPurchaser(s.config, emptyDeposit, { walletClient: s.submitter }).purchaseCredits({ credits: 1 });
  assert.equal(r.outcome, "not_sent");
  assert.equal(r.code, "AA21");
  assert.equal(await s.reads.agentNonce(), nonce);
});
