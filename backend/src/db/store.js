// SQLite store (node:sqlite) for purchase requests and chat messages. Schema: ./schema.js (BACKEND_API.md §5).
//
// Rules enforced here:
// - Amounts are base-unit decimal strings in SQLite and bigint in JS. Floats are refused.
// - transition() is the ONLY function that changes a request's status, and only along the lifecycle arrows.
// - succeeded / fulfilled_by_owner need a tx hash AND the decoded CreditsPurchased values (also a SQL CHECK).
// - A row is never authorization: needs_owner_approval is a proposal, nothing here can mark a purchase paid
//   without on-chain proof passed in by the caller.
// - No column holds a key, and every text value is checked against the secrets in the env before it is written.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { SCHEMA_SQL } from "./schema.js";

export const STATUSES = Object.freeze([
  "received", "precheck_failed", "submitted", "succeeded", "failed_onchain",
  "needs_owner_approval", "fulfilled_by_owner", "rejected", "expired",
]);

/** Lifecycle from BACKEND_API.md §3. Anything not listed throws. */
export const TRANSITIONS = Object.freeze({
  received: ["precheck_failed", "submitted", "needs_owner_approval"],
  submitted: ["succeeded", "failed_onchain"],
  needs_owner_approval: ["fulfilled_by_owner", "rejected", "expired"],
  expired: ["fulfilled_by_owner"], // the chain wins: an owner tx verified after expiry still fulfils it
  precheck_failed: [],
  succeeded: [],
  failed_onchain: [],
  fulfilled_by_owner: [],
  rejected: [],
});

export class TransitionError extends Error {
  name = "TransitionError";
}
export class SecretLeakError extends Error {
  name = "SecretLeakError";
}

const BACKEND_DIR = fileURLToPath(new URL("../../", import.meta.url));
const HASH = /^0x[0-9a-fA-F]{64}$/;
const now = () => Math.floor(Date.now() / 1000);

/** Values of env vars that look like secrets (keys, API keys). They must never reach the database. */
export function secretsFromEnv(env = process.env) {
  return Object.entries(env)
    .filter(([k, v]) => /PRIVATE_KEY|API_KEY|SECRET|MNEMONIC|SEED/i.test(k) && typeof v === "string" && v.trim().length >= 16)
    .map(([, v]) => v.trim().replace(/^0x/i, "").toLowerCase());
}

function baseUnits(v, name) {
  if (v === undefined || v === null) return null;
  if (typeof v === "bigint" && v >= 0n) return v.toString();
  if (typeof v === "string" && /^\d+$/.test(v)) return v;
  throw new TypeError(`${name} must be a non-negative bigint or base-unit string, got ${typeof v}`);
}
const toBig = (v) => (v === null || v === undefined ? null : BigInt(v));

function rowToRequest(r) {
  if (!r) return null;
  return {
    id: r.id,
    conversationId: r.conversation_id,
    credits: r.credits,
    reason: r.reason,
    agent: r.agent_address,
    precheck: r.precheck,
    path: r.path,
    status: r.status,
    price: toBig(r.price_base),
    nonce: toBig(r.nonce),
    userOpHash: r.user_op_hash,
    txHash: r.tx_hash,
    blockNumber: r.block_number,
    purchaseId: toBig(r.purchase_id),
    amountPaid: toBig(r.amount_paid_base),
    actualGasCost: toBig(r.actual_gas_cost_wei),
    errorCode: r.error_code,
    errorText: r.error_text,
    ownerNote: r.owner_note,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Opens (and creates) the database. dbPath is relative to backend/ unless absolute; ":memory:" for tests. */
export function openDb(dbPath = "data/agent.sqlite") {
  const file = dbPath === ":memory:" || isAbsolute(dbPath) ? dbPath : resolve(BACKEND_DIR, dbPath);
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA_SQL);
  return db;
}

export function createStore(db, { secrets = secretsFromEnv(), clock = now } = {}) {
  const guard = (value, field) => {
    if (typeof value !== "string" || !value) return value;
    const lower = value.toLowerCase();
    if (secrets.some((s) => lower.includes(s))) throw new SecretLeakError(`Refused to store ${field}: it contains a secret from the env.`);
    return value;
  };

  const getRow = db.prepare("SELECT * FROM purchase_requests WHERE id = ?");

  function tx(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Checks what each target status needs, against the row as it will be after the update. */
  function checkTarget(to, next, current) {
    const need = (cond, msg) => {
      if (!cond) throw new TransitionError(`${current.status} -> ${to} for ${current.id}: ${msg}`);
    };
    switch (to) {
      case "precheck_failed":
        need(next.error_code, "errorCode is required");
        break;
      case "submitted":
        need(next.path === "agent", "path must be 'agent'");
        need(next.tx_hash && next.user_op_hash && next.nonce !== null, "txHash, userOpHash and nonce are required");
        break;
      case "failed_onchain":
        need(next.tx_hash, "txHash is required");
        need(next.error_code, "errorCode is required");
        break;
      case "needs_owner_approval":
        need(next.path === "owner", "path must be 'owner'");
        need(["NEEDS_OWNER", "NEEDS_OWNER_TOPUP"].includes(next.precheck), "precheck must be NEEDS_OWNER or NEEDS_OWNER_TOPUP");
        break;
      case "succeeded":
      case "fulfilled_by_owner":
        need(next.tx_hash, "txHash is required (on-chain proof)");
        need(next.purchase_id !== null && next.amount_paid_base !== null, "the decoded CreditsPurchased event is required (on-chain proof)");
        need(next._purchase_credits === BigInt(current.credits), `CreditsPurchased.credits ${next._purchase_credits} does not match the request's ${current.credits}`);
        if (to === "succeeded") need(next.path === "agent" && next.user_op_hash, "agent path with a userOpHash is required");
        else need(next.path === "owner", "path must be 'owner'");
        break;
    }
  }

  return {
    db,

    createRequest({ conversationId = null, credits, reason = null, agentAddress, expiresAt = null }) {
      if (!Number.isSafeInteger(credits) || credits < 1 || credits > 10_000) throw new TypeError("credits must be an integer from 1 to 10000");
      if (!/^0x[0-9a-fA-F]{40}$/.test(agentAddress ?? "")) throw new TypeError("agentAddress must be an address");
      const id = `req_${randomBytes(8).toString("hex")}`;
      const t = clock();
      db.prepare(
        "INSERT INTO purchase_requests (id, conversation_id, credits, reason, agent_address, status, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'received', ?, ?, ?)",
      ).run(id, conversationId, credits, guard(reason, "reason"), agentAddress, expiresAt, t, t);
      return rowToRequest(getRow.get(id));
    },

    getRequest(id) {
      return rowToRequest(getRow.get(id));
    },

    listRequests({ status, limit = 50, before } = {}) {
      const statuses = status ? (Array.isArray(status) ? status : String(status).split(",")) : [];
      for (const s of statuses) if (!STATUSES.includes(s)) throw new TypeError(`unknown status ${s}`);
      const where = [];
      const args = [];
      if (statuses.length) {
        where.push(`status IN (${statuses.map(() => "?").join(",")})`);
        args.push(...statuses);
      }
      if (before !== undefined) {
        where.push("created_at < ?");
        args.push(before);
      }
      const sql = `SELECT * FROM purchase_requests ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`;
      return db.prepare(sql).all(...args, Math.min(Math.max(1, limit), 200)).map(rowToRequest);
    },

    /**
     * The only status writer. `fields` may set: path, precheck, price, nonce, userOpHash, txHash, blockNumber,
     * actualGasCost, errorCode, errorText, ownerNote, expiresAt, and purchase = { purchaseId, credits, amountPaid }
     * (the decoded CreditsPurchased args, required for succeeded / fulfilled_by_owner).
     */
    transition(id, to, fields = {}) {
      if (!STATUSES.includes(to)) throw new TransitionError(`unknown status ${to}`);
      return tx(() => {
        const current = getRow.get(id);
        if (!current) throw new TransitionError(`no request ${id}`);
        if (!TRANSITIONS[current.status].includes(to)) throw new TransitionError(`${current.status} -> ${to} is not allowed for ${id}`);
        for (const h of ["userOpHash", "txHash"]) if (fields[h] !== undefined && !HASH.test(fields[h])) throw new TransitionError(`${h} must be a 32-byte hex hash`);

        const set = {};
        const put = (col, v) => v !== undefined && (set[col] = v);
        put("path", fields.path);
        put("precheck", fields.precheck);
        put("price_base", fields.price !== undefined ? baseUnits(fields.price, "price") : undefined);
        put("nonce", fields.nonce !== undefined ? baseUnits(fields.nonce, "nonce") : undefined);
        put("user_op_hash", fields.userOpHash !== undefined ? guard(fields.userOpHash, "userOpHash") : undefined);
        put("tx_hash", fields.txHash !== undefined ? guard(fields.txHash, "txHash") : undefined);
        put("block_number", fields.blockNumber !== undefined && fields.blockNumber !== null ? Number(fields.blockNumber) : undefined);
        put("actual_gas_cost_wei", fields.actualGasCost !== undefined ? baseUnits(fields.actualGasCost, "actualGasCost") : undefined);
        put("error_code", fields.errorCode);
        put("error_text", fields.errorText !== undefined ? guard(fields.errorText, "errorText") : undefined);
        put("owner_note", fields.ownerNote !== undefined ? guard(fields.ownerNote, "ownerNote") : undefined);
        put("expires_at", fields.expiresAt);
        if (fields.purchase) {
          put("purchase_id", baseUnits(fields.purchase.purchaseId, "purchase.purchaseId"));
          put("amount_paid_base", baseUnits(fields.purchase.amountPaid, "purchase.amountPaid"));
        }
        const next = { ...current, ...set, _purchase_credits: fields.purchase ? BigInt(fields.purchase.credits) : null };
        checkTarget(to, next, current);

        const cols = Object.keys(set);
        const r = db
          .prepare(`UPDATE purchase_requests SET ${[...cols.map((c) => `${c} = ?`), "status = ?", "updated_at = ?"].join(", ")} WHERE id = ? AND status = ?`)
          .run(...cols.map((c) => set[c]), to, clock(), id, current.status);
        if (r.changes !== 1) throw new TransitionError(`${id} changed while updating`);
        return rowToRequest(getRow.get(id));
      });
    },

    /** needs_owner_approval rows past expires_at -> expired. Returns the ids. */
    expireDue(at = clock()) {
      const due = db.prepare("SELECT id FROM purchase_requests WHERE status = 'needs_owner_approval' AND expires_at IS NOT NULL AND expires_at <= ?").all(at);
      return due.map(({ id }) => this.transition(id, "expired").id);
    },

    addChatMessage({ conversationId = "default", role, content, toolName = null, toolCallId = null, requestId = null }) {
      const r = db
        .prepare("INSERT INTO chat_messages (conversation_id, role, content, tool_name, tool_call_id, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(conversationId, role, guard(content, "content"), toolName, toolCallId, requestId, clock());
      return Number(r.lastInsertRowid);
    },

    /** Oldest first. user/assistant only unless includeTool. */
    listChatMessages({ conversationId = "default", limit = 50, includeTool = false } = {}) {
      const rows = db
        .prepare(`SELECT * FROM (SELECT * FROM chat_messages WHERE conversation_id = ? ${includeTool ? "" : "AND role IN ('user','assistant')"} ORDER BY id DESC LIMIT ?) ORDER BY id ASC`)
        .all(conversationId, Math.min(Math.max(1, limit), 200));
      return rows.map((r) => ({ id: r.id, conversationId: r.conversation_id, role: r.role, content: r.content, toolName: r.tool_name, toolCallId: r.tool_call_id, requestId: r.request_id, createdAt: r.created_at }));
    },

    close() {
      db.close();
    },
  };
}
