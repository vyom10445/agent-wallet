// Restart recovery on Anvil: rows left in `submitted` are resolved from the chain when the store starts again.
// Runs inside evm_snapshot / evm_revert, so the agent's daily spend is left as it was.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWalletClient, http, parseEther } from "viem";
import { loadConfig, abi } from "../src/config.js";
import { createReads } from "../src/chain/reads.js";
import { createPurchaser } from "../src/chain/userop.js";
import { openDb, createStore, startStore } from "../src/db/index.js";
import { anvilEnv, anvilSkipReason } from "./helpers/anvil.mjs";

const skip = await anvilSkipReason();
let s, snapshotId, dir;

before(async () => {
  if (skip) return;
  const config = loadConfig(anvilEnv);
  const reads = createReads(config);
  const submitter = createWalletClient({ account: config.submitter, chain: config.chain, transport: http(config.rpcUrl) });
  snapshotId = await reads.client.request({ method: "evm_snapshot" });
  const hash = await submitter.writeContract({ address: config.addresses.wallet, abi: abi.wallet, functionName: "addDeposit", value: parseEther("0.05") });
  await reads.client.waitForTransactionReceipt({ hash });
  dir = mkdtempSync(join(tmpdir(), "agent-db-"));
  s = { config, reads, purchaser: createPurchaser(config, reads, { walletClient: submitter }), dbPath: join(dir, "agent.sqlite") };
});
after(async () => {
  if (skip) return;
  await s.reads.client.request({ method: "evm_revert", params: [snapshotId] });
  rmSync(dir, { recursive: true, force: true });
});

/** Records a sent op as `submitted`, as if the server stopped before it read the receipt. */
function recordSubmitted(store, r, credits) {
  const row = store.createRequest({ credits, reason: "restart test", agentAddress: s.config.agent.address });
  return store.transition(row.id, "submitted", { path: "agent", precheck: "AGENT_OK", price: r.price, nonce: r.nonce, userOpHash: r.userOpHash, txHash: r.txHash });
}

test("restarting resolves submitted rows from the chain", { skip }, async () => {
  const ok = await s.purchaser.purchaseCredits({ credits: 4 });
  assert.equal(ok.outcome, "succeeded", ok.message);
  const bad = await s.purchaser.purchaseCredits({ credits: 101 }); // mined, op fails with ExceedsPerTxLimit
  assert.equal(bad.outcome, "failed_onchain");

  // First run: write the rows, then "crash" (close without resolving).
  const first = createStore(openDb(s.dbPath));
  const a = recordSubmitted(first, ok, 4);
  const b = recordSubmitted(first, bad, 101);
  const c = first.createRequest({ credits: 1, agentAddress: s.config.agent.address });
  first.transition(c.id, "submitted", { path: "agent", nonce: 1n, userOpHash: "0x" + "ab".repeat(32), txHash: "0x" + "cd".repeat(32) }); // never mined
  first.close();

  // Restart.
  const { store, recovered } = await startStore(s.config, s.reads, { dbPath: s.dbPath });
  assert.deepEqual(recovered, { succeeded: [a.id], failed: [b.id], pending: [c.id] });

  const ra = store.getRequest(a.id);
  assert.equal(ra.status, "succeeded");
  assert.equal(ra.purchaseId, ok.purchase.purchaseId);
  assert.equal(ra.amountPaid, 40_000n);
  assert.equal(ra.blockNumber, Number(ok.blockNumber));

  const rb = store.getRequest(b.id);
  assert.equal(rb.status, "failed_onchain");
  assert.equal(rb.errorCode, "ExceedsPerTxLimit");
  assert.equal(rb.errorText, "ExceedsPerTxLimit(1010000, 1000000)");

  assert.equal(store.getRequest(c.id).status, "submitted"); // retried on the next start
  store.close();

  // Restarting again is a no-op for resolved rows.
  const again = await startStore(s.config, s.reads, { dbPath: s.dbPath });
  assert.deepEqual(again.recovered, { succeeded: [], failed: [], pending: [c.id] });
  again.store.close();
});
