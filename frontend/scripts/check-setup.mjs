// P-3 Phase 1 setup check: Node version, viem pin, address book, ABIs, and the running backend (health, wallet status,
// CORS for the dev server origin). Read-only: no keys, no wallet, no transactions.
// Run from frontend/ with the backend running:   node scripts/check-setup.mjs
// Env (optional): API_URL (default http://127.0.0.1:8787), ORIGIN (default http://localhost:5173).
import { existsSync, readFileSync } from "node:fs";

const API_URL = (process.env.API_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const ORIGIN = process.env.ORIGIN ?? "http://localhost:5173";
const ABIS = ["AgentWallet", "MockUSDC", "MockMerchant", "EntryPoint.v0.7.0"];

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const same = (x, y) => typeof x === "string" && typeof y === "string" && x.toLowerCase() === y.toLowerCase();
const results = [];
const check = async (name, fn) => {
  try {
    results.push([true, name, await fn()]);
  } catch (e) {
    results.push([false, name, e.message]);
  }
};
const get = async (path, headers = {}) => {
  let res;
  try {
    res = await fetch(`${API_URL}${path}`, { headers, signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new Error(`backend not reachable at ${API_URL} (${e.cause?.code ?? e.message}): run npm start in backend/`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path} returned ${res.status} ${body?.error?.code ?? ""} ${body?.error?.message ?? ""}`.trim());
  return { res, body };
};

await check("Node >= 22.13", () => {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error(`found ${process.version}, install Node 22 LTS (22.13 or later)`);
  return process.version;
});

await check("viem pinned exactly, same as backend/ and integration/", () => {
  const backend = json("../../backend/package.json").dependencies.viem;
  const integration = json("../../integration/package.json").dependencies.viem;
  const wanted = json("../package.json").dependencies?.viem;
  if (!wanted) throw new Error("viem is not a dependency: run npm install viem@" + integration + " --save-exact");
  if (!/^\d+\.\d+\.\d+$/.test(wanted)) throw new Error(`package.json asks for "${wanted}", expected exactly "${integration}" (no ^ or ~)`);
  if (wanted !== integration || backend !== integration) throw new Error(`frontend ${wanted}, backend ${backend}, integration ${integration}`);
  const path = new URL("../node_modules/viem/package.json", import.meta.url);
  if (!existsSync(path)) throw new Error("viem not installed: run npm install");
  const installed = JSON.parse(readFileSync(path, "utf8")).version;
  if (installed !== wanted) throw new Error(`installed ${installed}, expected ${wanted}: run npm install`);
  return installed;
});

await check("ABIs in ../abi", () => {
  for (const name of ABIS) {
    const abi = json(`../../abi/${name}.json`);
    if (!Array.isArray(abi) || !abi.length) throw new Error(`abi/${name}.json is not an ABI array`);
  }
  const fns = json("../../abi/AgentWallet.json").filter((x) => x.type === "function").map((x) => x.name);
  for (const fn of ["executeBatch", "owner", "getAgent", "isAgentValid", "remainingDailyAllowance"]) {
    if (!fns.includes(fn)) throw new Error(`AgentWallet ABI has no ${fn}`);
  }
  return ABIS.join(", ");
});

let health;
await check(`GET ${API_URL}/health`, async () => {
  ({ body: health } = await get("/health"));
  if (health.ok !== true) throw new Error(`ok is ${health.ok}`);
  if (health.apiVersion !== "1") throw new Error(`apiVersion ${health.apiVersion}, the frontend is built for v1`);
  if (health.chainId !== 84532 && health.chainId !== 31337) throw new Error(`chainId ${health.chainId}, expected 84532 or 31337`);
  const events = health.events ? `, events indexed to ${health.events.indexedToBlock}${health.events.lastError ? ` (lastError: ${health.events.lastError})` : ""}` : "";
  return `chain ${health.chainId}, llm ${health.llm}${events}`;
});

let book;
await check("Address book matches the backend", () => {
  if (!health) throw new Error("skipped: /health failed");
  const file = new URL(`../../contracts/deployments/${health.chainId}.json`, import.meta.url);
  if (!existsSync(file)) throw new Error(`contracts/deployments/${health.chainId}.json not found`);
  book = JSON.parse(readFileSync(file, "utf8"));
  if (book.chainId !== health.chainId) throw new Error(`file says chainId ${book.chainId}`);
  if (!same(book.wallet, health.wallet)) throw new Error(`backend wallet ${health.wallet}, file ${book.wallet}`);
  return `wallet ${book.wallet}`;
});

await check("GET /wallet/status", async () => {
  if (!book) throw new Error("skipped: address book not loaded");
  const { body: s } = await get("/wallet/status");
  for (const key of ["wallet", "owner", "entryPoint", "usdc", "merchant"]) {
    if (!same(s.addresses[key], book[key])) throw new Error(`addresses.${key} is ${s.addresses[key]}, file has ${book[key]}`);
  }
  if (!same(s.addresses.agent, health.agent)) throw new Error(`addresses.agent ${s.addresses.agent} differs from /health agent ${health.agent}`);
  if (s.agent.validNow !== true) throw new Error(`agent validNow is ${s.agent.validNow} (validUntil ${s.agent.validUntilIso}): rerun ConfigureAgent (docs/PHASE12_FINAL.md §8)`);
  const warn = s.warnings?.length ? `, warnings: ${s.warnings.join(" ")}` : "";
  return `owner ${s.addresses.owner}, validNow true until ${s.agent.validUntilIso}, maxPerTx ${s.agent.maxPerTx.mUSDC}, spentToday ${s.agent.spentToday.mUSDC} mUSDC${warn}`;
});

await check(`CORS allows ${ORIGIN}`, async () => {
  if (!health) throw new Error("skipped: /health failed");
  const pre = await fetch(`${API_URL}/approvals/req_0000000000000000/verify`, {
    method: "OPTIONS",
    headers: { origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
  });
  const { res } = await get("/health", { origin: ORIGIN });
  const allowed = res.headers.get("access-control-allow-origin");
  if (pre.status !== 204) throw new Error(`preflight returned ${pre.status}`);
  if (allowed !== ORIGIN) throw new Error(`backend allows "${allowed}", not "${ORIGIN}": open the app at ${allowed} or set FRONTEND_ORIGIN in backend/.env`);
  if (!/content-type/i.test(pre.headers.get("access-control-allow-headers") ?? "")) throw new Error("preflight does not allow content-type");
  return allowed;
});

let failed = 0;
for (const [ok, name, info] of results) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? `: ${info}` : ""}`);
}
console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed. Now check the browser wallet (frontend/docs/P3_PHASE1_INSPECTION.md, Step 4).");
process.exitCode = failed ? 1 : 0;
