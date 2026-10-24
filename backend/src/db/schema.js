// SQLite schema from docs/BACKEND_API.md §5 (v1, frozen). Idempotent: safe to run on every start.
export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS purchase_requests (
  id                  TEXT    PRIMARY KEY,
  conversation_id     TEXT,
  credits             INTEGER NOT NULL CHECK (credits BETWEEN 1 AND 10000),
  reason              TEXT    CHECK (reason IS NULL OR length(reason) <= 200),
  agent_address       TEXT    NOT NULL,
  precheck            TEXT    CHECK (precheck IN ('AGENT_OK','NEEDS_OWNER','NEEDS_OWNER_TOPUP','BLOCKED')),
  path                TEXT    CHECK (path IN ('agent','owner')),
  status              TEXT    NOT NULL DEFAULT 'received' CHECK (status IN (
                        'received','precheck_failed','submitted','succeeded','failed_onchain',
                        'needs_owner_approval','fulfilled_by_owner','rejected','expired')),
  price_base          TEXT,
  nonce               TEXT,
  user_op_hash        TEXT    UNIQUE,
  tx_hash             TEXT    UNIQUE,
  block_number        INTEGER,
  purchase_id         TEXT,
  amount_paid_base    TEXT,
  actual_gas_cost_wei TEXT,
  error_code          TEXT,
  error_text          TEXT,
  owner_note          TEXT    CHECK (owner_note IS NULL OR length(owner_note) <= 200),
  expires_at          INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  CHECK (status NOT IN ('succeeded','fulfilled_by_owner')
         OR (tx_hash IS NOT NULL AND purchase_id IS NOT NULL AND amount_paid_base IS NOT NULL)),
  CHECK (status <> 'succeeded' OR (path = 'agent' AND user_op_hash IS NOT NULL)),
  CHECK (status <> 'fulfilled_by_owner' OR path = 'owner')
);
CREATE INDEX IF NOT EXISTS purchase_requests_status  ON purchase_requests (status);
CREATE INDEX IF NOT EXISTS purchase_requests_created ON purchase_requests (created_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT    NOT NULL DEFAULT 'default',
  role            TEXT    NOT NULL CHECK (role IN ('user','assistant','tool')),
  content         TEXT    NOT NULL,
  tool_name       TEXT    CHECK (tool_name IS NULL OR tool_name IN ('get_wallet_status','quote_credits','buy_credits','list_requests')),
  tool_call_id    TEXT,
  request_id      TEXT    REFERENCES purchase_requests (id),
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_conv ON chat_messages (conversation_id, id);

-- Phase 10 (indexer).
CREATE TABLE IF NOT EXISTS chain_events (
  tx_hash      TEXT    NOT NULL,
  log_index    INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  timestamp    INTEGER,
  emitter      TEXT    NOT NULL CHECK (emitter IN ('wallet','merchant','entryPoint')),
  type         TEXT    NOT NULL CHECK (type IN ('AgentSpent','AgentExecuted','AgentRevoked','PolicySet',
                                                'CreditsPurchased','UserOperationEvent','UserOperationRevertReason')),
  label        TEXT    NOT NULL CHECK (label IN ('agent','owner','other')),
  args_json    TEXT    NOT NULL,
  request_id   TEXT    REFERENCES purchase_requests (id),
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS chain_events_block ON chain_events (block_number DESC);

CREATE TABLE IF NOT EXISTS indexer_state (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  chain_id         INTEGER NOT NULL,
  last_block       INTEGER NOT NULL
);

PRAGMA user_version = ${SCHEMA_VERSION};
`;
