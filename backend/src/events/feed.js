// GET /events (BACKEND_API.md §4.9): served from chain_events, never from live log queries.
// Newest first. uint256 args as decimal strings, token amounts as { base, mUSDC }. requestId is the one stored at index
// time or, when the request got its tx hash later (e.g. an owner purchase verified after it was indexed), matched now.
import { formatUnits } from "viem";
import { USDC_DECIMALS } from "../config.js";
import { INDEXED_TYPES, splitNonce, explainRevert } from "./format.js";

const AMOUNT_ARGS = new Set(["amount", "spentToday", "amountPaid", "maxPerTx", "dailyLimit"]);
const amount = (v) => ({ base: String(v), mUSDC: formatUnits(BigInt(v), USDC_DECIMALS) });

export function formatArgs(type, args) {
  const out = {};
  for (const [k, v] of Object.entries(args)) out[k] = AMOUNT_ARGS.has(k) && /^\d+$/.test(String(v)) ? amount(v) : v;
  if (type === "UserOperationEvent" || type === "UserOperationRevertReason") {
    const n = splitNonce(args.nonce);
    out.nonceKey = n.keyHex;
    out.nonceSequence = n.sequence.toString();
  }
  if (type === "UserOperationRevertReason") out.reason = explainRevert(args.revertReason);
  return out;
}

/** @returns {{ fromBlock, toBlock, indexedToBlock, events }} */
export function queryEvents(db, { types, limit = 50, before } = {}) {
  const where = [];
  const params = [];
  if (types?.length) {
    where.push(`e.type IN (${types.map(() => "?").join(", ")})`);
    params.push(...types);
  }
  if (before !== undefined) {
    where.push("e.block_number < ?");
    params.push(before);
  }
  const rows = db
    .prepare(
      `SELECT e.*, COALESCE(e.request_id,
                (SELECT id FROM purchase_requests p WHERE lower(p.user_op_hash) = lower(json_extract(e.args_json, '$.userOpHash'))),
                (SELECT id FROM purchase_requests p WHERE lower(p.tx_hash) = e.tx_hash)) AS rid
         FROM chain_events e ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY e.block_number DESC, e.log_index DESC LIMIT ?`,
    )
    .all(...params, limit);
  const state = db.prepare("SELECT last_block FROM indexer_state WHERE id = 1").get();
  const events = rows.map((r) => ({
    type: r.type,
    emitter: r.emitter,
    blockNumber: r.block_number,
    timestamp: r.timestamp,
    txHash: r.tx_hash,
    logIndex: r.log_index,
    label: r.label,
    requestId: r.rid ?? null,
    args: formatArgs(r.type, JSON.parse(r.args_json)),
  }));
  return {
    fromBlock: events.length ? events[events.length - 1].blockNumber : null,
    toBlock: events.length ? events[0].blockNumber : null,
    indexedToBlock: state ? state.last_block : null,
    events,
  };
}

export { INDEXED_TYPES };
