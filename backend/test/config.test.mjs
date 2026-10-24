// Offline tests for src/config.js. Uses only Anvil's published dev keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, loadDeployment, ConfigError } from "../src/config.js";

// Anvil dev accounts #1 (agent) and #2 (submitter). Public test keys, never use them on a real network.
const AGENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SUBMITTER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const base = { CHAIN_ID: "84532", RPC_URL: "https://sepolia.base.org", AGENT_PRIVATE_KEY: AGENT_KEY, SUBMITTER_PRIVATE_KEY: SUBMITTER_KEY };

const failsWith = (env, pattern) => {
  let err;
  try {
    loadConfig(env);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof ConfigError, `expected ConfigError, got ${err}`);
  assert.match(err.message, pattern);
  for (const key of [AGENT_KEY, SUBMITTER_KEY]) {
    assert.ok(!err.message.includes(key.slice(2)), "error message must never contain a key");
  }
  return err;
};

test("loads Base Sepolia addresses from contracts/deployments/84532.json", () => {
  const c = loadConfig(base);
  assert.equal(c.chainId, 84532);
  assert.equal(c.addresses.entryPoint, "0x0000000071727De22E5E9d8BAf0edAc6f37da032");
  assert.equal(c.addresses.wallet, loadDeployment(84532).wallet);
  assert.equal(c.agent.address, AGENT);
});

test("config holds no key strings", () => {
  const c = loadConfig(base);
  const dump = JSON.stringify(c) + JSON.stringify(Object.entries(c));
  for (const key of [AGENT_KEY, SUBMITTER_KEY]) assert.ok(!dump.toLowerCase().includes(key.slice(2)));
  assert.ok(Object.isFrozen(c));
});

test("CHAIN_ID defaults to 84532 and rejects other chains", () => {
  assert.equal(loadConfig({ ...base, CHAIN_ID: "" }).chainId, 84532);
  failsWith({ ...base, CHAIN_ID: "1" }, /CHAIN_ID must be 84532 .* or 31337/);
});

for (const name of ["RPC_URL", "AGENT_PRIVATE_KEY", "SUBMITTER_PRIVATE_KEY"]) {
  test(`missing ${name} fails clearly`, () => failsWith({ ...base, [name]: undefined }, new RegExp(`${name} is missing`)));
}

test("malformed keys fail without echoing them", () => {
  failsWith({ ...base, AGENT_PRIVATE_KEY: AGENT_KEY.slice(0, 40) }, /AGENT_PRIVATE_KEY is not a 0x-prefixed 32-byte hex/);
  failsWith({ ...base, SUBMITTER_PRIVATE_KEY: "0x" + "0".repeat(64) }, /SUBMITTER_PRIVATE_KEY is not a valid secp256k1/);
});

test("AGENT_ADDRESS must match the agent key", () => {
  assert.equal(loadConfig({ ...base, AGENT_ADDRESS: AGENT.toLowerCase() }).agent.address, AGENT);
  failsWith({ ...base, AGENT_ADDRESS: "0xC74Ba823524Cbd1d889b5FD38785b9d293C6D8aD" }, /Wrong agent key/);
});

test("refuses the owner key and a shared agent/submitter key", () => {
  failsWith({ ...base, OWNER_PRIVATE_KEY: "0x1" }, /must never hold the owner key/);
  failsWith({ ...base, SUBMITTER_PRIVATE_KEY: AGENT_KEY }, /must be different keys/);
});

test("APPROVAL_TTL_SECONDS: default one day, validated range", () => {
  assert.equal(loadConfig(base).approvalTtlSeconds, 86_400);
  assert.equal(loadConfig({ ...base, APPROVAL_TTL_SECONDS: "3600" }).approvalTtlSeconds, 3600);
  for (const bad of ["abc", "10", "1.5", "9999999"]) failsWith({ ...base, APPROVAL_TTL_SECONDS: bad }, /APPROVAL_TTL_SECONDS/);
});

test("EVENTS_* settings: defaults per chain, validated", () => {
  assert.deepEqual({ ...loadConfig(base).events }, { startBlock: null, chunkSize: 5000, pollMs: 4000, confirmations: 2 });
  assert.equal(loadConfig({ ...base, CHAIN_ID: "31337", RPC_URL: "http://127.0.0.1:8545" }).events.confirmations, 0);
  assert.equal(loadConfig({ ...base, EVENTS_START_BLOCK: "123", EVENTS_CHUNK_SIZE: "2000" }).events.startBlock, 123);
  for (const [k, v] of [["EVENTS_CHUNK_SIZE", "0"], ["EVENTS_START_BLOCK", "-1"], ["EVENTS_POLL_MS", "fast"], ["EVENTS_CONFIRMATIONS", "1.5"]]) failsWith({ ...base, [k]: v }, new RegExp(k));
});
