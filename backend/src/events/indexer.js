// Event indexer (Phase 10): integration/events.mjs as a restart-safe poller writing to chain_events / indexer_state.
// Indexed, for our wallet only:
//   wallet      AgentSpent, AgentExecuted, AgentRevoked, PolicySet          (emitted by the wallet address)
//   merchant    CreditsPurchased with buyer == wallet
//   EntryPoint  UserOperationEvent, UserOperationRevertReason with sender == wallet
// Rules:
// - Block ranges in chunks (EVENTS_CHUNK_SIZE, default 5000); a "range too large" RPC error halves the chunk and retries.
// - Each chunk's events and the new last_block are written in ONE SQLite transaction, and (tx_hash, log_index) is the
//   primary key, so a crash or restart neither duplicates nor skips anything: the next run resumes at last_block + 1.
// - Only blocks at least EVENTS_CONFIRMATIONS deep are indexed (Base Sepolia default 2, Anvil 0).
// - Labels: UserOp nonce key (nonce >> 64) 0 = owner, an address = agent. AgentSpent/AgentExecuted = agent,
//   PolicySet/AgentRevoked = owner (onlyOwner functions). CreditsPurchased takes the label of the UserOp it ran in,
//   or, for a direct tx, "owner" when tx.from == wallet.owner(), else "other".
// - requestId: purchase_requests matched by userOpHash, else by tx hash (also re-resolved at read time, see feed.js).
// Read-only on the chain: no keys.
import { readFileSync } from "node:fs";
import { getAbiItem } from "viem";
import { abi } from "../config.js";
import { splitNonce } from "./format.js";

const WALLET_EVENTS = ["AgentSpent", "AgentExecuted", "AgentRevoked", "PolicySet"];
const DEFAULT_LOOKBACK = 100_000n; // when nothing says where to start: about 2.3 days of Base Sepolia blocks

export class IndexerError extends Error {
  constructor(message) {
    super(message);
    this.name = "IndexerError";
  }
}

const isRangeError = (e) => /range|too many|limit exceeded|10000 results|response size|query returned more than|block range/i.test(`${e?.shortMessage ?? ""} ${e?.details ?? ""} ${e?.message ?? ""}`);
const jsonArgs = (args) => JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
const same = (x, y) => typeof x === "string" && typeof y === "string" && x.toLowerCase() === y.toLowerCase();

/** First block of the deployment from contracts/broadcast/Deploy.s.sol/<chainId>/run-latest.json, or null. */
export function deployBlockFromBroadcast(chainId, url = new URL(`../../../contracts/broadcast/Deploy.s.sol/${chainId}/run-latest.json`, import.meta.url)) {
  try {
    const run = JSON.parse(readFileSync(url, "utf8"));
    const blocks = (run.receipts ?? []).map((r) => Number(BigInt(r.blockNumber))).filter((n) => Number.isSafeInteger(n));
    return blocks.length ? Math.min(...blocks) : null;
  } catch {
    return null;
  }
}

/**
 * deps: { config, reads, db (node:sqlite DatabaseSync, the store's), log? }
 * opts: overrides for config.events ({ startBlock, chunkSize, pollMs, confirmations }), client? (tests).
 */
export function createIndexer({ config, reads, db, log = console.warn }, opts = {}) {
  const a = config.addresses;
  const o = { ...config.events, ...opts };
  const client = opts.client ?? reads.client;
  let chunkSize = BigInt(o.chunkSize ?? 5000);
  let timer = null;
  let running = null;
  let lastError = null;

  const walletEvents = WALLET_EVENTS.map((name) => getAbiItem({ abi: abi.wallet, name }));
  const purchased = getAbiItem({ abi: abi.merchant, name: "CreditsPurchased" });
  const opEvent = getAbiItem({ abi: abi.entryPoint, name: "UserOperationEvent" });
  const opRevert = getAbiItem({ abi: abi.entryPoint, name: "UserOperationRevertReason" });

  const getState = db.prepare("SELECT chain_id, last_block FROM indexer_state WHERE id = 1");
  const putState = db.prepare("INSERT INTO indexer_state (id, chain_id, last_block) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET chain_id = excluded.chain_id, last_block = excluded.last_block");
  const insert = db.prepare(
    "INSERT OR IGNORE INTO chain_events (tx_hash, log_index, block_number, timestamp, emitter, type, label, args_json, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const byOpHash = db.prepare("SELECT id FROM purchase_requests WHERE lower(user_op_hash) = lower(?)");
  const byTxHash = db.prepare("SELECT id FROM purchase_requests WHERE lower(tx_hash) = lower(?)");

  function state() {
    const row = getState.get();
    if (row && row.chain_id !== config.chainId) {
      throw new IndexerError(`The database was indexed on chain ${row.chain_id}, but CHAIN_ID is ${config.chainId}. Use a separate DB_PATH per chain.`);
    }
    return row ? { lastBlock: BigInt(row.last_block) } : null;
  }

  async function startBlock(head) {
    if (o.startBlock !== null && o.startBlock !== undefined) return BigInt(o.startBlock);
    const deployed = deployBlockFromBroadcast(config.chainId);
    if (deployed !== null) return BigInt(deployed);
    return head > DEFAULT_LOOKBACK ? head - DEFAULT_LOOKBACK : 0n;
  }

  async function logsFor(from, to) {
    const range = { fromBlock: from, toBlock: to };
    const [w, m, ops, reverts] = await Promise.all([
      client.getLogs({ address: a.wallet, events: walletEvents, ...range, strict: true }),
      client.getLogs({ address: a.merchant, event: purchased, args: { buyer: a.wallet }, ...range, strict: true }),
      client.getLogs({ address: a.entryPoint, event: opEvent, args: { sender: a.wallet }, ...range, strict: true }),
      client.getLogs({ address: a.entryPoint, event: opRevert, args: { sender: a.wallet }, ...range, strict: true }),
    ]);
    return [...w.map((l) => ({ ...l, emitter: "wallet" })), ...m.map((l) => ({ ...l, emitter: "merchant" })), ...ops.map((l) => ({ ...l, emitter: "entryPoint" })), ...reverts.map((l) => ({ ...l, emitter: "entryPoint" }))]
      // the address filter already applies; this guards against an RPC that ignores it
      .filter((l) => (l.emitter === "wallet" ? same(l.address, a.wallet) : l.emitter === "merchant" ? same(l.address, a.merchant) : same(l.address, a.entryPoint)))
      .sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
  }

  /** Turns raw logs of one chunk into rows: label, requestId, timestamp. */
  async function toRows(logs) {
    const blocks = new Map();
    const txs = new Map();
    let owner;
    const timestamp = async (n) => {
      if (!blocks.has(n)) blocks.set(n, client.getBlock({ blockNumber: n }).then((b) => Number(b.timestamp)));
      return blocks.get(n);
    };
    const rows = [];
    for (const l of logs) {
      let label = "other";
      let opHash = null;
      if (l.eventName === "UserOperationEvent" || l.eventName === "UserOperationRevertReason") {
        label = splitNonce(l.args.nonce).label;
        opHash = l.args.userOpHash;
      } else if (l.eventName === "AgentSpent" || l.eventName === "AgentExecuted") {
        label = "agent";
      } else if (l.eventName === "PolicySet" || l.eventName === "AgentRevoked") {
        label = "owner";
      }
      if (l.eventName === "CreditsPurchased" || l.eventName === "AgentSpent" || l.eventName === "AgentExecuted") {
        // Inside handleOps, an op's UserOperationEvent is emitted right after its execution: the first one after this log.
        const op = logs.find((x) => x.eventName === "UserOperationEvent" && x.transactionHash === l.transactionHash && x.logIndex > l.logIndex);
        if (op) {
          label = l.eventName === "CreditsPurchased" ? splitNonce(op.args.nonce).label : label;
          opHash = op.args.userOpHash;
        } else if (l.eventName === "CreditsPurchased") {
          if (!txs.has(l.transactionHash)) txs.set(l.transactionHash, client.getTransaction({ hash: l.transactionHash }));
          const tx = await txs.get(l.transactionHash);
          owner ??= await reads.owner();
          label = same(tx.to, a.wallet) && same(tx.from, owner) ? "owner" : "other";
        }
      }
      const requestId = (opHash && byOpHash.get(opHash)?.id) || byTxHash.get(l.transactionHash)?.id || null;
      rows.push([l.transactionHash.toLowerCase(), l.logIndex, Number(l.blockNumber), await timestamp(l.blockNumber), l.emitter, l.eventName, label, jsonArgs(l.args), requestId]);
    }
    return rows;
  }

  function commit(rows, to) {
    db.exec("BEGIN IMMEDIATE");
    try {
      let inserted = 0;
      for (const r of rows) inserted += Number(insert.run(...r).changes);
      putState.run(config.chainId, Number(to));
      db.exec("COMMIT");
      return inserted;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Indexes from last_block + 1 up to (head - confirmations). Returns { from, to, inserted, chunks } or { upToDate }. */
  async function syncOnce() {
    const head = (await client.getBlockNumber({ cacheTime: 0 })) - BigInt(o.confirmations ?? 0);
    const st = state();
    let from = st ? st.lastBlock + 1n : await startBlock(head);
    const first = from;
    if (from > head) return { upToDate: true, indexedToBlock: st ? Number(st.lastBlock) : null, inserted: 0, chunks: 0 };
    let inserted = 0;
    let chunks = 0;
    while (from <= head) {
      const to = from + chunkSize - 1n < head ? from + chunkSize - 1n : head;
      let logs;
      try {
        logs = await logsFor(from, to);
      } catch (e) {
        if (isRangeError(e) && chunkSize > 1n) {
          chunkSize = chunkSize / 2n;
          log(`events: RPC refused ${to - from + 1n} blocks, retrying with chunks of ${chunkSize}`);
          continue;
        }
        throw e;
      }
      inserted += commit(await toRows(logs), to);
      chunks += 1;
      from = to + 1n;
    }
    return { from: Number(first), to: Number(head), inserted, chunks, indexedToBlock: Number(head) };
  }

  /** One sync at a time; concurrent callers share it. */
  function sync() {
    running ??= syncOnce()
      .then((r) => {
        lastError = null;
        return r;
      })
      .catch((e) => {
        lastError = e?.shortMessage ?? e?.message ?? String(e);
        throw e;
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  return {
    sync,
    state,
    get chunkSize() {
      return Number(chunkSize);
    },
    status: () => ({ indexedToBlock: state() ? Number(state().lastBlock) : null, lastError, polling: Boolean(timer) }),

    /** Background polling every pollMs. Errors are logged and retried on the next tick; the server keeps serving. */
    start() {
      if (timer || !o.pollMs) return;
      const tick = () =>
        sync()
          .catch((e) => (e instanceof IndexerError ? log(`events: ${e.message}`) : log(`events: sync failed (${lastError}); retrying in ${o.pollMs} ms`)))
          .finally(() => {
            if (timer) timer = setTimeout(tick, o.pollMs).unref();
          });
      timer = setTimeout(tick, 0).unref();
    },
    async stop() {
      clearTimeout(timer);
      timer = null;
      await running?.catch(() => {});
    },
  };
}
