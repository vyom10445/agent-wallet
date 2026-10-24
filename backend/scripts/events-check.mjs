// Phase 10 acceptance check against the RUNNING backend (npm start first): npm run events:check
//   1. Every paid request (succeeded = Phase 8 agent purchase, fulfilled_by_owner = Phase 9 owner purchase) has its
//      CreditsPurchased event in GET /events, linked by requestId, labelled agent or owner respectively.
//   2. No (txHash, logIndex) appears twice.
//   3. Restart check: each run saves the event keys to data/events-check.json; the next run (after restarting the
//      backend) fails if any saved event is missing or duplicated.
// Read-only: no keys, no chain writes. Env: PORT or BACKEND_URL.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const BASE = process.env.BACKEND_URL || `http://127.0.0.1:${process.env.PORT || 8787}`;
const SNAPSHOT = new URL("../data/events-check.json", import.meta.url);

async function api(path) {
  let res;
  try {
    res = await fetch(BASE + path);
  } catch (e) {
    throw new Error(`Backend not reachable at ${BASE} (${e.cause?.code ?? e.message}). Start it with: npm start`);
  }
  const json = await res.json();
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status} ${json.error?.code}: ${json.error?.message}`);
  return json;
}

/** All indexed events, newest first, paging by block. */
async function allEvents(type) {
  const out = [];
  let before;
  for (;;) {
    const page = await api(`/events?limit=200${type ? `&type=${type}` : ""}${before !== undefined ? `&before=${before}` : ""}`);
    if (page.events.length < 200) return { events: [...out, ...page.events], indexedToBlock: page.indexedToBlock };
    const oldest = page.events[page.events.length - 1].blockNumber;
    out.push(...page.events.filter((e) => e.blockNumber > oldest)); // the oldest block is re-read whole on the next page
    before = oldest + 1;
    if (page.events.every((e) => e.blockNumber === oldest)) throw new Error(`more than 200 events in block ${oldest}`);
  }
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
};

const health = await api("/health");
console.log(`Events check on chain ${health.chainId} via ${BASE}; indexer ${JSON.stringify(health.events)}`);
if (health.events?.lastError) console.log(`   indexer error: ${health.events.lastError}`);

const { events, indexedToBlock } = await allEvents();
const keys = events.map((e) => `${e.txHash}:${e.logIndex}`);
console.log(`\n[1] ${events.length} events indexed up to block ${indexedToBlock}`);
const counts = Object.entries(Object.groupBy(events, (e) => `${e.type}/${e.label}`)).map(([k, v]) => `${k} ${v.length}`);
console.log(`   ${counts.join(", ") || "none"}`);
check("no duplicate (txHash, logIndex)", new Set(keys).size === keys.length);

console.log("\n[2] Paid requests have their purchase event");
const paid = (await api("/requests?status=succeeded,fulfilled_by_owner&limit=200")).requests;
const purchases = events.filter((e) => e.type === "CreditsPurchased");
for (const r of paid) {
  const want = r.status === "succeeded" ? "agent" : "owner";
  const ev = purchases.find((e) => e.requestId === r.id);
  const tooNew = r.blockNumber !== null && r.blockNumber > indexedToBlock;
  check(
    `${r.id} ${r.status} (${r.credits} credits) -> CreditsPurchased label ${want}`,
    tooNew || (ev && ev.label === want && ev.txHash === r.txHash?.toLowerCase() && ev.args.credits === String(r.credits)),
    tooNew ? `block ${r.blockNumber} not indexed yet (rerun in a few seconds)` : ev ? `${ev.label}, tx ${ev.txHash}, block ${ev.blockNumber}` : "event missing",
  );
}
if (!paid.length) console.log("   (no paid requests in this database yet)");

console.log("\n[3] Restart check (data/events-check.json)");
let previous = null;
try {
  previous = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
} catch {}
if (previous && previous.chainId === health.chainId) {
  const now = new Set(keys);
  const missing = previous.keys.filter((k) => !now.has(k));
  check(`all ${previous.keys.length} events from the previous run (up to block ${previous.indexedToBlock}) still present`, missing.length === 0, missing.slice(0, 3).join(", "));
  check("nothing below the previous indexed block was added twice or skipped", events.filter((e) => e.blockNumber <= previous.indexedToBlock).length === previous.keys.length);
} else {
  console.log("   first run: saved. Restart the backend (Ctrl+C, npm start) and run this again.");
}
mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
writeFileSync(SNAPSHOT, JSON.stringify({ chainId: health.chainId, indexedToBlock, keys }, null, 1));

const failed = results.filter((ok) => !ok).length;
console.log(`\n${failed ? "EVENTS: FAIL" : "EVENTS: OK"}  (${results.length - failed}/${results.length} checks passed)`);
if (failed) process.exitCode = 1;
