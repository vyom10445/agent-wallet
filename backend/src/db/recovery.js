// Startup recovery: any request left in `submitted` (e.g. the server stopped before reading the receipt)
// is resolved from the chain by its tx hash. Same success rule as the live pipeline:
// UserOperationEvent.success for this userOpHash AND a CreditsPurchased event emitted by the merchant.
import { readOpResult, errorCode } from "../chain/userop.js";

/**
 * @returns {{ succeeded: string[], failed: string[], pending: string[] }} request ids by outcome.
 * Rows whose receipt is not available yet stay `submitted` (pending) and are retried on the next start.
 */
export async function resolveSubmitted(store, reads, { merchant = reads.addresses.merchant } = {}) {
  const out = { succeeded: [], failed: [], pending: [] };
  for (const req of store.listRequests({ status: "submitted", limit: 200 })) {
    let receipt;
    try {
      receipt = await reads.client.getTransactionReceipt({ hash: req.txHash });
    } catch {
      out.pending.push(req.id); // not mined yet, dropped, or the RPC does not know it
      continue;
    }
    const r = readOpResult(receipt, req.userOpHash);
    const bought = r.events.find((e) => e.eventName === "CreditsPurchased" && e.address.toLowerCase() === merchant.toLowerCase());
    const common = { blockNumber: receipt.blockNumber, actualGasCost: r.actualGasCost ?? undefined };
    if (r.success && bought) {
      store.transition(req.id, "succeeded", {
        ...common,
        purchase: { purchaseId: bought.args.purchaseId, credits: bought.args.credits, amountPaid: bought.args.amountPaid },
      });
      out.succeeded.push(req.id);
    } else {
      const errorText = r.revertReason ?? (r.success ? "Op succeeded but no CreditsPurchased event from the merchant" : receipt.status === "success" ? "UserOperationEvent.success is false" : "handleOps transaction reverted");
      const code = r.revertReason ? errorCode(r.revertReason) : r.success ? "NO_PURCHASE_EVENT" : "UNKNOWN";
      store.transition(req.id, "failed_onchain", { ...common, errorCode: code, errorText });
      out.failed.push(req.id);
    }
  }
  return out;
}
