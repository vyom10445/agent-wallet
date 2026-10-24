// Re-checks a paid row (succeeded / fulfilled_by_owner) against the chain when it is read, so a row written by hand
// in SQLite is never shown as paid. The database row is a claim; the receipt is the proof.
//   fulfilled_by_owner: the same checks as verify (owner tx, CreditsPurchased for these credits, not older than the
//                       request) and the stored purchaseId / amountPaid equal the event's.
//   succeeded:          tx to the EntryPoint, UserOperationEvent.success for the stored userOpHash with sender = wallet
//                       and nonce key = the agent, and the CreditsPurchased event equals the stored purchase.
// verified is true, false, or null when the chain could not be read (RPC error: unknown, never "verified").
import { parseEventLogs, TransactionNotFoundError, TransactionReceiptNotFoundError } from "viem";
import { abi } from "../config.js";
import { inspectOwnerTx } from "./verify.js";

const PAID = ["succeeded", "fulfilled_by_owner"];
const same = (x, y) => typeof x === "string" && typeof y === "string" && x.toLowerCase() === y.toLowerCase();

export function createProofs({ config, reads }) {
  const a = config.addresses;
  const verifiedKeys = new Set(); // positive results only; a mined, successful receipt does not change
  const keyOf = (r) => [r.id, r.status, r.txHash, r.userOpHash, r.credits, r.purchaseId, r.amountPaid, r.agent, r.createdAt].join("|");

  async function checkAgentRow(r) {
    if (!r.txHash || !r.userOpHash) return [{ name: "agent_userop", ok: false, detail: "no txHash or userOpHash stored" }];
    const [receipt, tx] = await Promise.all([reads.client.getTransactionReceipt({ hash: r.txHash }), reads.client.getTransaction({ hash: r.txHash })]);
    const op = parseEventLogs({ abi: abi.entryPoint, eventName: "UserOperationEvent", logs: receipt.logs }).find((l) => same(l.address, a.entryPoint) && same(l.args.userOpHash, r.userOpHash));
    const bought = parseEventLogs({ abi: abi.merchant, eventName: "CreditsPurchased", logs: receipt.logs }).find(
      (l) => same(l.address, a.merchant) && same(l.args.buyer, a.wallet) && l.args.purchaseId === r.purchaseId,
    );
    return [
      { name: "receipt_success", ok: receipt.status === "success" },
      { name: "agent_userop", ok: same(tx.to, a.entryPoint) && op?.args.success === true && same(op.args.sender, a.wallet) && Boolean(r.agent) && op.args.nonce >> 64n === BigInt(r.agent) },
      { name: "credits_purchased", ok: Boolean(bought) && bought.args.credits === BigInt(r.credits) && bought.args.amountPaid === r.amountPaid },
    ];
  }

  async function checkOwnerRow(r) {
    if (!r.txHash) return [{ name: "owner_authorized", ok: false, detail: "no txHash stored" }];
    const out = await inspectOwnerTx({ config, reads }, { txHash: r.txHash, credits: r.credits, notBefore: r.createdAt });
    const p = out.purchase;
    return [...out.checks, { name: "stored_purchase_matches", ok: Boolean(p) && p.purchaseId === r.purchaseId && p.amountPaid === r.amountPaid }];
  }

  return {
    needsProof: (r) => PAID.includes(r.status),

    /** @returns {{ verified: boolean | null, checks: { name, ok, detail? }[] }} */
    async check(r) {
      if (!PAID.includes(r.status)) return { verified: null, checks: [] };
      const key = keyOf(r);
      if (verifiedKeys.has(key)) return { verified: true, checks: [], cached: true };
      let checks;
      try {
        checks = r.status === "succeeded" ? await checkAgentRow(r) : await checkOwnerRow(r);
      } catch (e) {
        if (e instanceof TransactionReceiptNotFoundError || e instanceof TransactionNotFoundError) return { verified: false, checks: [{ name: "receipt_success", ok: false, detail: "transaction not found on chain" }] };
        return { verified: null, checks: [{ name: "chain_read", ok: false, detail: "chain read failed, proof unknown" }] };
      }
      const verified = checks.every((c) => c.ok);
      if (verified) verifiedKeys.add(key);
      return { verified, checks };
    },

    /** Start-up audit: every paid row whose proof does not hold. */
    async audit(store, { limit = 200 } = {}) {
      const bad = [];
      for (const status of PAID) {
        for (const r of store.listRequests({ status, limit })) {
          const p = await this.check(r);
          if (p.verified === false) bad.push(r.id);
        }
      }
      return bad;
    },
  };
}
