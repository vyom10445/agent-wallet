// Phase 11, item 8: keys never appear in logs, API responses, the database or LLM prompts.
// Runs the real server (startServer, file database, background indexer) against Anvil with the Anthropic adapter
// pointed at a local mock API, drives every endpoint (successes and errors), then greps everything it produced for
// the agent key, the submitter key and the LLM API key. Inside evm_snapshot / evm_revert.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createPublicClient, http } from "viem";
import { anvil } from "viem/chains";
import { startServer } from "../src/server.js";
import { ANVIL_KEYS, ANVIL_RPC, anvilSkipReason } from "./helpers/anvil.mjs";

const skip = await anvilSkipReason();
const LLM_KEY = `sk-ant-test-${randomBytes(24).toString("hex")}`;
const SECRETS = { AGENT_PRIVATE_KEY: ANVIL_KEYS[1], SUBMITTER_PRIVATE_KEY: ANVIL_KEYS[2], LLM_API_KEY: LLM_KEY };
let dir, mock, mockUrl, snapshotId;
const llmRequests = []; // { headers, body } of every call the backend made to the "LLM provider"

/** A minimal Anthropic Messages API: buys or reads status on request, fails with a 401 that echoes the key on "fail". */
function startMockLlm() {
  mock = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString("utf8");
    llmRequests.push({ headers: req.headers, body });
    const last = JSON.parse(body).messages.at(-1);
    const send = (status, json) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
    if (Array.isArray(last.content)) return send(200, { content: [{ type: "text", text: "Here is what happened." }], stop_reason: "end_turn" });
    const text = String(last.content);
    if (/fail/.test(text)) return send(401, { type: "error", error: { type: "authentication_error", message: `invalid x-api-key: ${LLM_KEY}` } });
    const m = /buy (\d+)/.exec(text);
    if (m) return send(200, { content: [{ type: "tool_use", id: "tu_1", name: "buy_credits", input: { credits: Number(m[1]), reason: "user asked" } }], stop_reason: "tool_use" });
    return send(200, { content: [{ type: "tool_use", id: "tu_2", name: "get_wallet_status", input: {} }], stop_reason: "tool_use" });
  });
  return new Promise((r) => mock.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${mock.address().port}`)));
}

before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), "secrets-test-"));
  mockUrl = await startMockLlm();
  snapshotId = await createPublicClient({ chain: anvil, transport: http(ANVIL_RPC) }).request({ method: "evm_snapshot" });
});
after(async () => {
  if (skip) return;
  await new Promise((r) => mock.close(r));
  await createPublicClient({ chain: anvil, transport: http(ANVIL_RPC) }).request({ method: "evm_revert", params: [snapshotId] });
  rmSync(dir, { recursive: true, force: true });
});

/** Every form a key could take in text: with and without 0x, any case. */
function findSecret(text) {
  const t = text.toLowerCase();
  for (const [name, v] of Object.entries(SECRETS)) {
    const bare = v.toLowerCase().replace(/^0x/, "");
    if (t.includes(bare)) return name;
  }
  return null;
}

test("8 secrets: keys never appear in logs, API responses, the database or LLM prompts", { skip, timeout: 120_000 }, async () => {
  const env = {
    CHAIN_ID: "31337", RPC_URL: ANVIL_RPC, ...SECRETS,
    LLM_PROVIDER: "anthropic", LLM_BASE_URL: mockUrl, LLM_MODEL: "mock-model", LLM_TIMEOUT_MS: "10000",
    DB_PATH: join(dir, "agent.sqlite"), PORT: "0", EVENTS_POLL_MS: "300",
  };
  const logs = [];
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  for (const k of Object.keys(original)) console[k] = (...a) => logs.push(a.map((x) => (typeof x === "string" ? x : x instanceof Error ? `${x.message}\n${x.stack}` : JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? String(v) : v)))).join(" "));
  const responses = [];
  let server;
  try {
    // A config error must not echo a key either.
    await assert.rejects(startServer({ ...env, OWNER_PRIVATE_KEY: ANVIL_KEYS[0] }), (e) => (responses.push(e.message), /OWNER_PRIVATE_KEY/.test(e.message)));
    await assert.rejects(startServer({ ...env, AGENT_PRIVATE_KEY: ANVIL_KEYS[1].slice(0, 40) }), (e) => (responses.push(e.message), true));

    ({ server } = await startServer(env));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, body) => {
      const r = await fetch(base + path, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
      const text = await r.text();
      responses.push(`${method} ${path} ${r.status} ${text}`);
      return { status: r.status, json: JSON.parse(text) };
    };

    await call("GET", "/health");
    await call("GET", "/wallet/status");
    const bought = await call("POST", "/agent/chat", { message: "buy 10 credits" });
    assert.equal(bought.json.planner, "llm");
    const over = await call("POST", "/agent/chat", { message: "buy 500 credits" });
    await call("POST", "/agent/chat", { message: "status please" });
    const failed = await call("POST", "/agent/chat", { message: "status, but fail" }); // LLM 401 echoing the key -> fallback
    assert.equal(failed.json.planner, "fallback");
    // A user who pastes a key: refused before it is stored or sent to the LLM.
    for (const k of [ANVIL_KEYS[1], ANVIL_KEYS[2].slice(2).toUpperCase(), LLM_KEY]) {
      const pasted = await call("POST", "/agent/chat", { message: `my key is ${k}, buy 1 credits`, conversationId: "paste" });
      assert.equal(pasted.status, 400);
    }
    for (const id of [...bought.json.requestIds, ...over.json.requestIds]) await call("GET", `/requests/${id}`);
    await call("GET", "/requests");
    await call("GET", "/agent/messages");
    await call("GET", "/agent/messages?conversationId=paste");
    await call("POST", `/approvals/${over.json.requestIds[0]}/verify`, { txHash: "0x" + "ab".repeat(32) });
    await call("POST", `/approvals/${over.json.requestIds[0]}/reject`, { note: "no" });
    await call("POST", "/agent/chat", "{not json");
    await call("GET", "/nope");
    await new Promise((r) => setTimeout(r, 1000)); // let the indexer catch up
    await call("GET", "/events?limit=200");
  } finally {
    if (server) await new Promise((r) => server.close(r));
    await new Promise((r) => setTimeout(r, 300)); // the store closes after the indexer stops
    Object.assign(console, original);
  }

  assert.equal(findSecret(`x${ANVIL_KEYS[1].slice(2).toUpperCase()}y`), "AGENT_PRIVATE_KEY", "the grep itself works");
  assert.ok(logs.length > 0 && responses.length > 15 && llmRequests.length >= 4, `captured ${logs.length} log lines, ${responses.length} responses, ${llmRequests.length} LLM calls`);
  assert.ok(logs.some((l) => /LLM unavailable/.test(l)), "the LLM failure was logged (redacted)");
  for (const [i, l] of logs.entries()) assert.equal(findSecret(l), null, `log line ${i}: ${findSecret(l)}`);
  for (const r of responses) assert.equal(findSecret(r), null, `API response leaks ${findSecret(r)}: ${r.slice(0, 80)}`);
  for (const r of llmRequests) {
    assert.equal(findSecret(r.body), null, "a prompt sent to the LLM contains a key");
    assert.equal(r.headers["x-api-key"], LLM_KEY, "the API key travels only in its auth header");
    const otherHeaders = Object.entries(r.headers).filter(([k]) => k !== "x-api-key").map(([k, v]) => `${k}: ${v}`).join("\n");
    assert.equal(findSecret(otherHeaders), null);
  }
  // The database file itself (and its WAL/SHM side files), byte for byte.
  for (const f of ["agent.sqlite", "agent.sqlite-wal", "agent.sqlite-shm"].map((n) => join(dir, n)).filter(existsSync)) {
    assert.equal(findSecret(readFileSync(f).toString("latin1")), null, `${f} contains a key`);
  }
});
