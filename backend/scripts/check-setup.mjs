// Phase 1 setup check: Node version, SQLite library, viem pin, deployment file and ABIs.
// Read-only and offline: no keys, no RPC calls. Run with `npm run check` from backend/.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const results = [];
const check = (name, fn) => {
  try {
    results.push([true, name, fn()]);
  } catch (e) {
    results.push([false, name, e.message]);
  }
};

check("Node >= 22.13", () => {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error(`found ${process.version}, install Node 22 LTS (22.13 or later)`);
  return process.version;
});

check("SQLite: node:sqlite", () => {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (amount TEXT NOT NULL)");
  db.prepare("INSERT INTO t (amount) VALUES (?)").run((2n ** 255n).toString()); // base units stay exact as TEXT
  const row = db.prepare("SELECT amount FROM t").get();
  db.close();
  if (BigInt(row.amount) !== 2n ** 255n) throw new Error("round trip failed");
  return `SQLite ${process.versions.sqlite}`;
});

check("viem matches integration/ pin", () => {
  const pinned = json("../../integration/package.json").dependencies.viem;
  const wanted = json("../package.json").dependencies.viem;
  const installed = json("../node_modules/viem/package.json").version; // backend's own copy, not integration/'s
  if (wanted !== pinned) throw new Error(`backend asks for ${wanted}, integration/ pins ${pinned}`);
  if (installed !== pinned) throw new Error(`installed ${installed}, expected ${pinned}: run npm install`);
  return installed;
});

const chainId = Number(process.env.CHAIN_ID ?? 84532);
check(`deployment file contracts/deployments/${chainId}.json`, () => {
  const d = json(`../../contracts/deployments/${chainId}.json`);
  for (const k of ["entryPoint", "wallet", "owner", "usdc", "merchant"]) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(d[k] ?? "")) throw new Error(`missing or bad "${k}"`);
  }
  return `wallet ${d.wallet}`;
});

check("ABIs in abi/", () => {
  const need = {
    "AgentWallet.json": ["executeAsAgent", "getAgent", "isAgentValid", "remainingDailyAllowance", "AgentSpent", "ExceedsPerTxLimit"],
    "EntryPoint.v0.7.0.json": ["handleOps", "getNonce", "getUserOpHash", "UserOperationEvent", "UserOperationRevertReason", "FailedOp"],
    "MockMerchant.json": ["purchase", "quote", "creditsOf", "CreditsPurchased"],
    "MockUSDC.json": ["balanceOf", "allowance", "ERC20InsufficientAllowance"],
  };
  for (const [file, names] of Object.entries(need)) {
    const have = new Set(json(`../../abi/${file}`).map((x) => x.name));
    const missing = names.filter((n) => !have.has(n));
    if (missing.length) throw new Error(`${file} lacks ${missing.join(", ")}`);
  }
  return `${Object.keys(need).length} files OK`;
});

check("no owner key in env", () => {
  if (process.env.OWNER_PRIVATE_KEY) throw new Error("remove OWNER_PRIVATE_KEY: the backend must never hold the owner key");
  return "OK";
});

for (const [ok, name, detail] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
const failed = results.filter(([ok]) => !ok).length;
console.log(failed ? `\n${failed} check(s) failed` : "\nSetup OK");
process.exitCode = failed ? 1 : 0;
