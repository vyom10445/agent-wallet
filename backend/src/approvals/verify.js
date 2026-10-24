// POST /approvals/:id/verify (BACKEND_API.md §4.6). The only way a request becomes `fulfilled_by_owner`.
// The caller supplies a tx hash; everything else is read from the chain. All six checks must pass:
//   1 request_status     the request is needs_owner_approval or expired             404 NOT_FOUND / 409 WRONG_STATUS
//   2 tx_unused          no request already stores this tx hash                      409 TX_ALREADY_USED
//   3 receipt_success    the receipt exists and status == success                    422 TX_NOT_FOUND / TX_REVERTED
//   4 owner_authorized   direct: to == wallet, from == wallet.owner(), executeBatch  422 NOT_OWNER_TX
//                        or UserOp: to == EntryPoint, every UserOperationEvent for the wallet has
//                        nonce key 0 (owner key) and success == true
//   5 credits_purchased  CreditsPurchased emitted by the merchant, buyer == wallet,  422 NO_PURCHASE_EVENT /
//                        credits == request.credits                                  CREDITS_MISMATCH
//   6 after_request      block timestamp >= request createdAt - 120 s (clock skew)   422 TX_TOO_OLD
// On any failure nothing is written. The backend never signs or sends anything here.
import { decodeFunctionData, getAddress, parseEventLogs, TransactionNotFoundError, TransactionReceiptNotFoundError } from "viem";
import { abi, allAbi } from "../config.js";

export const CHECK_NAMES = ["request_status", "tx_unused", "receipt_success", "owner_authorized", "credits_purchased", "after_request"];
const HASH = /^0x[0-9a-f]{64}$/;
const VERIFIABLE = ["needs_owner_approval", "expired"];
// createdAt comes from this PC's clock, the block time from the chain's. Allow a small difference between the two.
export const CLOCK_SKEW_SECONDS = 120;

export class VerifyError extends Error {
  /** status/code as in §4.6; checks = [{ name, ok, detail? }] for details.checks */
  constructor(status, code, message, checks) {
    super(message);
    this.name = "VerifyError";
    Object.assign(this, { status, code, checks });
  }
}

const same = (x, y) => typeof x === "string" && typeof y === "string" && x.toLowerCase() === y.toLowerCase();

/**
 * Checks 3 to 6 for one tx, read from the chain. Pure read: no keys, no writes.
 * @returns {{ checks, failure: null | { status, code, message }, purchase?, blockNumber?, route? }}
 *   purchase = { purchaseId, credits, amountPaid } (bigints) from the matching CreditsPurchased event.
 */
export async function inspectOwnerTx({ config, reads }, { txHash, credits, notBefore }) {
  const a = config.addresses;
  const checks = [];
  let failure = null;
  const record = (name, ok, detail, fail) => {
    checks.push({ name, ok, ...(detail ? { detail } : {}) });
    if (!ok && !failure) failure = fail;
  };
  const skipRest = (from) => {
    for (const name of CHECK_NAMES.slice(CHECK_NAMES.indexOf(from))) checks.push({ name, ok: false, detail: "not checked" });
  };

  // 3. receipt
  let receipt, tx;
  try {
    [receipt, tx] = await Promise.all([reads.client.getTransactionReceipt({ hash: txHash }), reads.client.getTransaction({ hash: txHash })]);
  } catch (e) {
    if (!(e instanceof TransactionReceiptNotFoundError || e instanceof TransactionNotFoundError)) throw e;
    record("receipt_success", false, `no mined transaction ${txHash} on chain ${config.chainId}`, { status: 422, code: "TX_NOT_FOUND", message: "Transaction not found on this chain (wrong hash, wrong network, or not mined yet)" });
    skipRest("owner_authorized");
    return { checks, failure };
  }
  record("receipt_success", receipt.status === "success", `block ${receipt.blockNumber}, status ${receipt.status}`, { status: 422, code: "TX_REVERTED", message: "The transaction reverted" });

  // 4. owner authorization
  const owner = await reads.owner();
  let route = null;
  let ownerDetail;
  if (same(tx.to, a.wallet)) {
    let fn;
    try {
      fn = decodeFunctionData({ abi: abi.wallet, data: tx.input }).functionName;
    } catch {}
    route = "direct";
    const ok = same(tx.from, owner) && fn === "executeBatch";
    ownerDetail = ok ? `direct executeBatch from owner ${getAddress(tx.from)}` : `direct call ${fn ?? "unknown"} from ${getAddress(tx.from)}, owner is ${owner}`;
    record("owner_authorized", ok, ownerDetail, { status: 422, code: "NOT_OWNER_TX", message: "The transaction was not the wallet owner calling executeBatch" });
  } else if (same(tx.to, a.entryPoint)) {
    route = "userop";
    const ops = parseEventLogs({ abi: abi.entryPoint, eventName: "UserOperationEvent", logs: receipt.logs }).filter((l) => same(l.address, a.entryPoint) && same(l.args.sender, a.wallet));
    // Every op from this wallet in the bundle must be an owner op (nonce key 0) that succeeded, so a purchase made by
    // the agent's own op (nonce key = agent address) can never be passed off as the owner's.
    const ok = ops.length > 0 && ops.every((l) => l.args.nonce >> 64n === 0n && l.args.success === true);
    ownerDetail = ops.length
      ? ops.map((l) => `UserOp nonce key 0x${(l.args.nonce >> 64n).toString(16)} success ${l.args.success}`).join("; ")
      : "no UserOperationEvent for the wallet";
    record("owner_authorized", ok, ownerDetail, { status: 422, code: "NOT_OWNER_TX", message: "The UserOperation was not an owner operation (nonce key 0) that succeeded" });
  } else {
    record("owner_authorized", false, `tx went to ${tx.to ? getAddress(tx.to) : "contract creation"}, not the wallet or the EntryPoint`, { status: 422, code: "NOT_OWNER_TX", message: "The transaction did not go to the wallet" });
  }

  // 5. CreditsPurchased from the merchant for this wallet and these credits
  const bought = parseEventLogs({ abi: abi.merchant, eventName: "CreditsPurchased", logs: receipt.logs }).filter((l) => same(l.address, a.merchant) && same(l.args.buyer, a.wallet));
  const match = bought.find((l) => l.args.credits === BigInt(credits));
  if (!bought.length) {
    record("credits_purchased", false, "no CreditsPurchased event from the merchant with buyer = wallet", { status: 422, code: "NO_PURCHASE_EVENT", message: "No CreditsPurchased event for the wallet in this transaction" });
  } else {
    record(
      "credits_purchased",
      Boolean(match),
      match ? `purchase #${match.args.purchaseId}: ${match.args.credits} credits for ${match.args.amountPaid} base units` : `bought ${bought.map((l) => l.args.credits).join(", ")} credits, request is for ${credits}`,
      { status: 422, code: "CREDITS_MISMATCH", message: `The transaction bought different credits than the request's ${credits}` },
    );
  }

  // 6. not older than the request
  const block = await reads.client.getBlock({ blockNumber: receipt.blockNumber });
  record("after_request", Number(block.timestamp) >= notBefore - CLOCK_SKEW_SECONDS, `block time ${block.timestamp}, request created ${notBefore}`, { status: 422, code: "TX_TOO_OLD", message: "The transaction is older than the request, so it cannot fulfil it" });

  return {
    checks,
    failure,
    route,
    blockNumber: Number(receipt.blockNumber),
    purchase: match ? { purchaseId: match.args.purchaseId, credits: match.args.credits, amountPaid: match.args.amountPaid } : undefined,
  };
}

/**
 * Verifies the owner's tx and, only if all six checks pass, transitions the request to fulfilled_by_owner.
 * @returns {{ request, checks }} the updated store row and the check list. Throws VerifyError otherwise.
 */
export async function verifyOwnerApproval({ config, reads, store }, { requestId, txHash }) {
  if (typeof txHash !== "string" || !HASH.test(txHash.toLowerCase())) throw new VerifyError(400, "INVALID_INPUT", "txHash must be a 32-byte hex string (0x + 64 hex characters)");
  const hash = txHash.toLowerCase();
  const request = store.getRequest(requestId);
  if (!request) throw new VerifyError(404, "NOT_FOUND", "Unknown request id");

  const checks = [];
  if (!VERIFIABLE.includes(request.status)) {
    checks.push({ name: "request_status", ok: false, detail: `status is ${request.status}` });
    throw new VerifyError(409, "WRONG_STATUS", `Only needs_owner_approval or expired requests can be verified; this one is ${request.status}`, checks);
  }
  checks.push({ name: "request_status", ok: true, detail: request.status });

  const usedBy = store.getRequestByTxHash(hash);
  if (usedBy) {
    checks.push({ name: "tx_unused", ok: false, detail: `already stored on ${usedBy.id}` });
    throw new VerifyError(409, "TX_ALREADY_USED", "That transaction already proved another request", checks);
  }
  checks.push({ name: "tx_unused", ok: true });

  const r = await inspectOwnerTx({ config, reads }, { txHash: hash, credits: request.credits, notBefore: request.createdAt });
  checks.push(...r.checks);
  if (r.failure) throw new VerifyError(r.failure.status, r.failure.code, r.failure.message, checks);

  let updated;
  try {
    updated = store.transition(requestId, "fulfilled_by_owner", { txHash: hash, blockNumber: r.blockNumber, purchase: r.purchase });
  } catch (e) {
    // A concurrent verify of the same tx for another request loses on the UNIQUE(tx_hash) constraint.
    if (/UNIQUE/i.test(e?.message ?? "")) throw new VerifyError(409, "TX_ALREADY_USED", "That transaction already proved another request", checks);
    throw e;
  }
  return { request: updated, checks: checks.map(({ name, ok }) => ({ name, ok })), route: r.route };
}
