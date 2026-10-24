// Phase 7 check: no private key handling in frontend/src or frontend/dist. Run after `npm run build`:
//   node scripts/scan-keys.mjs
// src must not use any key or mnemonic API, and eth_sign may appear only in the deny list in src/chain/wallet.ts.
// dist is the bundle: it must not contain key env names or wallet secrets. The bundled viem library still contains
// the names of signing methods (unused code, blocked at runtime by guardProvider) and "private key" inside its curve
// library's input-validation errors; those are listed as INFO, not failures.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const walk = (dir, out = []) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

let failed = 0;
const fail = (msg) => {
  failed++;
  console.log(`FAIL  ${msg}`);
};

const SRC_FORBIDDEN = /privateKeyToAccount|mnemonicToAccount|hdKeyToAccount|generatePrivateKey|generateMnemonic|viem\/accounts|PRIVATE_KEY|seed phrase|\bmnemonic\b/i;
const srcFiles = walk(join(root, "src")).filter((f) => /\.(ts|tsx|js|jsx|css|html)$/.test(f));
for (const f of srcFiles) {
  const text = readFileSync(f, "utf8");
  const m = text.match(SRC_FORBIDDEN);
  if (m) fail(`${relative(root, f)} contains "${m[0]}"`);
  if (!f.endsWith(join("chain", "wallet.ts")) && /['"`]eth_sign/.test(text)) fail(`${relative(root, f)} mentions an eth_sign method outside the deny list`);
}
console.log(`src: ${srcFiles.length} files checked`);

const dist = join(root, "dist");
if (!existsSync(dist)) {
  fail("dist/ not found: run npm run build first");
} else {
  const bundle = walk(dist).filter((f) => /\.(js|html|css)$/.test(f));
  const DIST_FORBIDDEN = /PRIVATE_KEY|seed phrase|\bmnemonic\b|OWNER_PRIVATE|AGENT_PRIVATE|SUBMITTER_PRIVATE|LLM_API_KEY/i;
  let info = { signingNames: 0, curveErrors: 0 };
  for (const f of bundle) {
    const text = readFileSync(f, "utf8");
    const m = text.match(DIST_FORBIDDEN);
    if (m) fail(`${relative(root, f)} contains "${m[0]}"`);
    info.signingNames += (text.match(/eth_sign|personal_sign/g) ?? []).length;
    info.curveErrors += (text.match(/private key/gi) ?? []).length;
  }
  console.log(`dist: ${bundle.length} files checked`);
  console.log(`INFO  library code in the bundle: ${info.signingNames} signing-method names (blocked at runtime), ${info.curveErrors} "private key" validation messages from the curve library`);
}

console.log(failed ? `\n${failed} problem(s) found.` : "\nPASS  no private key handling in src or dist.");
process.exitCode = failed ? 1 : 0;
