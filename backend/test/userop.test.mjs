// Offline tests for src/chain/userop.js: constants, error codes, intent validation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GAS, BUNDLE_GAS_LIMIT, errorCode, createPurchaser } from "../src/chain/userop.js";
import { loadConfig } from "../src/config.js";
import { createReads } from "../src/chain/reads.js";
import { ANVIL_KEYS } from "./helpers/anvil.mjs";

test("gas limits are the ones from integration/lib.mjs", () => {
  assert.deepEqual(GAS, { verification: 500_000n, call: 500_000n, preVerification: 60_000n });
  assert.equal(BUNDLE_GAS_LIMIT, 1_260_000n);
});

test("errorCode maps EntryPoint and custom errors", () => {
  assert.equal(errorCode("AA24 signature error"), "AA24");
  assert.equal(errorCode("AA23 reverted -> ECDSAInvalidSignatureLength(64)"), "AA23");
  assert.equal(errorCode("AA95 out of gas"), "AA95");
  assert.equal(errorCode("ExceedsPerTxLimit(1010000, 1000000)"), "ExceedsPerTxLimit");
  assert.equal(errorCode("ERC20InsufficientAllowance(0x8D94CcD748a00C27Cc339aaE3A14F2965E8b4FC1, 0, 10000)"), "ERC20InsufficientAllowance");
  assert.equal(errorCode("0xdeadbeef"), "UNKNOWN");
});

test("purchaseCredits accepts only { credits } with an integer in range", async () => {
  // No chain needed: invalid intents are refused before any read.
  const config = loadConfig({ CHAIN_ID: "84532", RPC_URL: "http://127.0.0.1:1", AGENT_PRIVATE_KEY: ANVIL_KEYS[1], SUBMITTER_PRIVATE_KEY: ANVIL_KEYS[2] });
  const p = createPurchaser(config, createReads(config));
  for (const bad of [{ credits: 0 }, { credits: 1.5 }, { credits: -1 }, { credits: 10_001 }, { credits: "10" }, { credits: 10, target: "0x0000000000000000000000000000000000000001" }, { credits: 10, callData: "0x" }, null, 10]) {
    const r = await p.purchaseCredits(bad);
    assert.equal(r.outcome, "not_sent", JSON.stringify(bad));
    assert.equal(r.code, "INVALID_INPUT");
  }
});
