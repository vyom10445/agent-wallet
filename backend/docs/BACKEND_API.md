# Backend API (v1, FROZEN)

**Status: frozen 2026-10-24 (P-2 Phase 2).** This is the contract between the backend, the frontend and the LLM.
It is a design only: nothing here is implemented yet. Any change after the freeze bumps the version to v2 and
must be listed in the changelog at the end.

Sources: `abi/*.json`, `contracts/deployments/84532.json`, `integration/lib.mjs`, `integration/owner-approve.mjs`,
`integration/events.mjs`, `docs/PHASE11_DEBUGGING.md`. Every on-chain name used here is listed in §10 and exists in `abi/`.

---

## 1. Ground rules

1. **The contract is the only authority.** A purchase is real only when:
   - agent path: `UserOperationEvent.success == true` for our `userOpHash`, plus a `CreditsPurchased` event from the merchant in the same tx; or
   - owner path: the owner's transaction emitted `CreditsPurchased` with `buyer == wallet`, verified by `POST /approvals/:id/verify`.
2. **A SQLite approval is not authorization.** A `needs_owner_approval` row is only a proposal that asks the owner to sign.
   Nothing in SQLite (a status, an edited row, an LLM decision, a pre-check result) ever permits a spend or proves a
   purchase. Only the owner's signed on-chain transaction authorizes an out-of-policy purchase, and the backend marks a
   request `fulfilled_by_owner` only after it has verified that transaction on chain (§4.6).
3. **The backend never holds the owner key** and never signs anything for the owner. It holds the agent key (signs
   UserOps) and a submitter key (pays gas for `handleOps`). Keys never appear in SQLite, logs, API responses or LLM prompts.
4. **The LLM never sees or chooses** addresses, selectors, calldata, nonces, gas values or keys. It can only call the
   four tools in §6. The backend builds all calldata from `contracts/deployments/<chainId>.json` and `abi/`.
5. **The pre-check is advisory.** It picks the path (agent or owner) and gives good messages. The contract still decides.

## 2. Conventions

| Item | Rule |
|---|---|
| Base URL | `http://127.0.0.1:${PORT}` (default `PORT=8787`). Binds to localhost only. |
| CORS | Allowed origin from env `FRONTEND_ORIGIN` (default `http://localhost:5173`). |
| Format | JSON, UTF-8. Requests with a body need `Content-Type: application/json`. Max body 16 KB. |
| Amounts | mUSDC **base units** (6 decimals, `1000000` = 1 mUSDC) as decimal **strings**, never JSON numbers. Every amount is an `Amount` object (below). |
| Wei | Decimal strings (`"5000000000000000"`). |
| Integers | `credits`, `blockNumber`, `limit` are JSON numbers (all fit in 2^53). |
| Times | Unix **seconds** (number) plus an ISO-8601 UTC string where shown. |
| Addresses, hashes | `0x`-prefixed hex strings. Addresses are checksummed. |
| Request ids | `req_` + 16 lowercase hex chars, e.g. `req_3f9a0c1b7d2e4a65`. |
| Auth | None (single-user local hackathon backend, localhost only). |

```ts
type Amount = { base: string; mUSDC: string };       // { base: "1500000", mUSDC: "1.5" }  (viem formatUnits(x, 6))
type Wei    = string;
type ErrorBody = { error: { code: ErrorCode; message: string; details?: object } };
```

## 3. Request lifecycle and status values

Every purchase attempt is one row in `purchase_requests`.

```
received ─┬─> precheck_failed                                  (terminal, nothing sent)
          ├─> submitted ─┬─> succeeded                         (terminal, needs proof)
          │              └─> failed_onchain                    (terminal)
          └─> needs_owner_approval ─┬─> fulfilled_by_owner     (terminal, needs proof)
                                    ├─> rejected               (terminal)
                                    └─> expired ──> fulfilled_by_owner   (only via verify, see below)
```

| Status | Meaning | Set when |
|---|---|---|
| `received` | Row created, pre-check not finished. | `buy_credits` is called. |
| `precheck_failed` | Not sent. Either the pre-check returned `BLOCKED`, or `handleOps` simulation rejected the op (`FailedOp` AAxx). `error_code` says which. | Pre-check or simulation. |
| `submitted` | `handleOps` tx sent, waiting for the receipt. | After `writeContract` returns a tx hash. |
| `succeeded` | `UserOperationEvent.success == true` for this `userOpHash` **and** `CreditsPurchased` decoded from the same tx. | Receipt read. Requires `tx_hash`, `purchase_id`, `amount_paid_base`. |
| `failed_onchain` | Tx mined but `UserOperationEvent.success == false`, or the tx reverted. `error_code` from `UserOperationRevertReason`. | Receipt read. |
| `needs_owner_approval` | Waiting for the owner to sign `executeBatch` on chain. **Not** permission to spend. | Pre-check `NEEDS_OWNER` or `NEEDS_OWNER_TOPUP`. |
| `fulfilled_by_owner` | The owner's tx was verified on chain (§4.6). | `POST /approvals/:id/verify` succeeded. Requires `tx_hash`, `purchase_id`, `amount_paid_base`. |
| `rejected` | The owner declined in the app. Bookkeeping only. | `POST /approvals/:id/reject`. |
| `expired` | No verified owner tx within `APPROVAL_TTL_SECONDS` (default 86400). | Background sweep. |

Rules:
- All status changes go through one function that allows only the arrows above. Anything else throws.
- `succeeded` and `fulfilled_by_owner` cannot be set without a tx hash and the decoded `CreditsPurchased` values (also enforced by a SQL `CHECK`, §5).
- `expired → fulfilled_by_owner` is allowed because the chain wins: if the owner already paid, the request is fulfilled. `rejected` is final; verify on a rejected request returns `409 WRONG_STATUS`.
- On startup, every `submitted` row is resolved by reading its receipt.

**Pre-check outcomes** (stored in `precheck`, from Phase 5):

| Value | Condition (fresh reads) | Next status |
|---|---|---|
| `AGENT_OK` | `quote(credits) <= maxPerTx`, `<= remainingDailyAllowance(agent)`, `<= allowance(wallet, merchant)`, `<= balanceOf(wallet)`, `isAgentValid(agent)`, `isCallAllowed(agent, merchant, 0x70876c98)`, `isRecipientAllowed(agent, merchant)` | `submitted` (or `precheck_failed` if simulation rejects) |
| `NEEDS_OWNER` | price above `maxPerTx` or above `remainingDailyAllowance` | `needs_owner_approval` |
| `NEEDS_OWNER_TOPUP` | merchant allowance or wallet balance below the price | `needs_owner_approval` |
| `BLOCKED` | agent not valid or revoked, call or recipient not allowed, `credits == 0` | `precheck_failed` |

## 4. Endpoints

| # | Method | Path | Purpose |
|---|---|---|---|
| 4.1 | GET | `/health` | Liveness and config summary |
| 4.2 | POST | `/agent/chat` | Talk to the agent |
| 4.3 | GET | `/agent/messages` | Chat history |
| 4.4 | GET | `/requests` | List purchase requests |
| 4.5 | GET | `/requests/:id` | One request (+ what the owner must sign) |
| 4.6 | POST | `/approvals/:id/verify` | Verify the owner's on-chain tx |
| 4.7 | POST | `/approvals/:id/reject` | Owner declines (bookkeeping only) |
| 4.8 | GET | `/wallet/status` | Live wallet and agent state |
| 4.9 | GET | `/events` | Recent on-chain activity |

`/health`, `/agent/messages` and `/approvals/:id/reject` were added to the suggested list: the frontend needs history after a reload, and `rejected` needs a way in.

### 4.1 `GET /health`

`200`
```json
{ "ok": true, "apiVersion": "1", "chainId": 84532, "wallet": "0x74cD…5c1A", "agent": "0xC74B…D8aD",
  "llm": "available" , "dbPath": "data/agent.sqlite" }
```
`llm` is `"available"` or `"fallback"` (deterministic planner in use). Never includes keys or the RPC URL.

### 4.2 `POST /agent/chat`

Request
```json
{ "message": "buy 50 API credits", "conversationId": "default" }
```
| Field | Type | Rule |
|---|---|---|
| `message` | string | required, 1 to 2000 chars after trim |
| `conversationId` | string | optional, `^[a-zA-Z0-9_-]{1,64}$`, default `"default"` |

`200`
```json
{
  "conversationId": "default",
  "reply": "Bought 50 credits for 0.5 mUSDC. Tx 0xabc…",
  "requestIds": ["req_3f9a0c1b7d2e4a65"],
  "toolCalls": [
    { "name": "buy_credits", "args": { "credits": 50, "reason": "user asked" },
      "result": { "requestId": "req_3f9a0c1b7d2e4a65", "status": "succeeded" } }
  ],
  "planner": "llm"
}
```
- `requestIds`: every request created during this turn (empty array if none).
- `planner`: `"llm"` or `"fallback"`.
- The reply must state the on-chain result. It never claims success unless the request status is `succeeded`.
- One chat turn at a time per conversation; a second concurrent call returns `409 BUSY`.

Errors: `400 INVALID_INPUT`, `409 BUSY`, `502 LLM_ERROR` (only if the fallback planner also cannot answer).

### 4.3 `GET /agent/messages?conversationId=default&limit=50`

`limit` 1 to 200 (default 50). Oldest first.

`200`
```json
{ "conversationId": "default",
  "messages": [ { "id": 12, "role": "user", "content": "buy 50 API credits", "requestId": null, "createdAt": 1761317000 },
                { "id": 13, "role": "assistant", "content": "Bought 50 credits…", "requestId": "req_3f9a0c1b7d2e4a65", "createdAt": 1761317009 } ] }
```
Only `user` and `assistant` rows are returned; `tool` rows stay internal.

### 4.4 `GET /requests?status=&limit=50&before=`

| Query | Rule |
|---|---|
| `status` | optional, one of the §3 status values (comma-separated list allowed) |
| `limit` | 1 to 200, default 50 |
| `before` | optional unix seconds; returns rows with `createdAt < before` (paging) |

`200` → `{ "requests": PurchaseRequest[] }`, newest first. `ownerApproval` is omitted in the list.

```ts
type PurchaseRequest = {
  id: string;
  status: Status;
  path: "agent" | "owner" | null;            // null until pre-check finishes
  precheck: "AGENT_OK" | "NEEDS_OWNER" | "NEEDS_OWNER_TOPUP" | "BLOCKED" | null;
  credits: number;
  reason: string | null;                     // from the LLM tool call, untrusted text
  price: Amount | null;                      // quote(credits) at pre-check time
  amountPaid: Amount | null;                 // CreditsPurchased.amountPaid (only when proven)
  purchaseId: string | null;                 // CreditsPurchased.purchaseId
  agent: string;
  nonce: string | null;                      // full UserOp nonce (decimal string), agent path only
  userOpHash: string | null;
  txHash: string | null;
  blockNumber: number | null;
  actualGasCost: Wei | null;                 // UserOperationEvent.actualGasCost
  error: { code: ErrorCode; message: string } | null;   // decoded revert reason, e.g. "ExceedsDailyLimit(600000, 400000)"
  explorerUrl: string | null;                // https://sepolia.basescan.org/tx/<txHash>
  conversationId: string | null;
  expiresAt: number | null;                  // owner path only
  createdAt: number; updatedAt: number;
  ownerApproval?: OwnerApproval;             // only in GET /requests/:id, only while needs_owner_approval or expired
};
```

### 4.5 `GET /requests/:id`

`200` → `PurchaseRequest` with `ownerApproval` when the status is `needs_owner_approval` or `expired`.
`ownerApproval` is rebuilt from **on-chain** reads at request time, exactly as `integration/owner-approve.mjs` does.
It never reuses a price the agent proposed.

```ts
type OwnerApproval = {
  wallet: string;                              // the call goes to wallet.executeBatch(dest, value, func)
  function: "executeBatch";
  price: Amount;                               // MockMerchant.quote(credits), read now
  standingAllowance: Amount;                   // MockUSDC.allowance(wallet, merchant), read now
  args: { dest: [string, string]; value: []; func: [string, string] };  // [usdc, merchant], [], [approve data, purchase data]
  calls: [                                     // decoded back from func, for display
    { to: string; function: "approve";  args: { spender: string; value: Amount } },   // approve(merchant, standing + price)
    { to: string; function: "purchase"; args: { credits: number; payment: Amount } }  // purchase(credits, price)
  ];
  signWith: "owner wallet (injected), integration/owner-approve.mjs, or script/OwnerApprovePurchase.s.sol";
  readAt: number;
};
```
Errors: `404 NOT_FOUND`, `502 RPC_ERROR`. If the on-chain reads fail, the whole call fails with 502, so the frontend never shows stale calldata.

### 4.6 `POST /approvals/:id/verify`

Request: `{ "txHash": "0x…" }` (32-byte hex).

The backend fetches the receipt and the transaction and marks the request `fulfilled_by_owner` only if **all** checks pass:

| # | Check | Failure code |
|---|---|---|
| 1 | Request exists and status is `needs_owner_approval` or `expired` | `404 NOT_FOUND`, `409 WRONG_STATUS` |
| 2 | `txHash` not already stored on any request | `409 TX_ALREADY_USED` |
| 3 | Receipt exists and `status == success` | `422 TX_NOT_FOUND`, `422 TX_REVERTED` |
| 4 | Owner authorized it: **either** a direct tx with `to == wallet`, `from == wallet.owner()` and calldata decoding to `executeBatch`; **or** a tx to the EntryPoint whose `UserOperationEvent` has `sender == wallet`, nonce key `nonce >> 64 == 0` (owner key) and `success == true` | `422 NOT_OWNER_TX` |
| 5 | A `CreditsPurchased` log **emitted by the merchant address** in this receipt with `buyer == wallet` and `credits == request.credits` | `422 NO_PURCHASE_EVENT`, `422 CREDITS_MISMATCH` |
| 6 | The block timestamp is at or after the request's `createdAt` (an older purchase cannot be reused) | `422 TX_TOO_OLD` |

`200`
```json
{ "request": { "id": "req_…", "status": "fulfilled_by_owner", "txHash": "0x…", "purchaseId": "7",
               "amountPaid": { "base": "1500000", "mUSDC": "1.5" } },
  "checks": [ { "name": "owner_authorized", "ok": true }, { "name": "credits_purchased", "ok": true } ] }
```
On failure the status does not change and the body is `ErrorBody` with `details.checks` listing each check and result.

### 4.7 `POST /approvals/:id/reject`

Request: `{ "note": "too expensive" }` (optional, max 200 chars).
`200` → `{ "request": PurchaseRequest }` with status `rejected`. Allowed only from `needs_owner_approval` (`409 WRONG_STATUS` otherwise).
This is bookkeeping: it moves no funds and revokes nothing on chain.

### 4.8 `GET /wallet/status`

All values are fresh reads at request time (no cache).

`200`
```json
{
  "chainId": 84532, "blockNumber": 12345678, "readAt": 1761317000,
  "addresses": { "wallet": "0x74cD…", "owner": "0x815d…", "entryPoint": "0x0000…a032", "usdc": "0xC91a…", "merchant": "0x8D94…", "agent": "0xC74B…" },
  "agent": {
    "active": true, "validNow": true,
    "validAfter": 1761300000, "validUntil": 1761904800, "validUntilIso": "2026-10-31T10:00:00Z",
    "token": "0xC91a…",
    "maxPerTx": { "base": "1000000", "mUSDC": "1" },
    "dailyLimit": { "base": "5000000", "mUSDC": "5" },
    "spentToday": { "base": "100000", "mUSDC": "0.1" },
    "remainingDailyAllowance": { "base": "4900000", "mUSDC": "4.9" },
    "canPurchase": true, "merchantAllowed": true,
    "nonceKey": "0xc74ba823524cbd1d889b5fd38785b9d293c6d8ad", "nextNonce": "…"
  },
  "wallet": {
    "balance": { "base": "99800000", "mUSDC": "99.8" },
    "merchantAllowance": { "base": "9800000", "mUSDC": "9.8" },
    "entryPointDeposit": "4990000000000000",
    "credits": 20
  },
  "merchant": { "pricePerCredit": { "base": "10000", "mUSDC": "0.01" }, "purchaseCount": 3 },
  "submitter": { "address": "0x…", "ethBalance": "20000000000000000" },
  "warnings": ["DEPOSIT_LOW"]
}
```

| Field | Source |
|---|---|
| `owner` | `AgentWallet.owner()` |
| `agent.active, validAfter, validUntil, token, maxPerTx, dailyLimit, spentToday` | `AgentWallet.getAgent(agent)` |
| `agent.validNow` | `AgentWallet.isAgentValid(agent)` |
| `agent.remainingDailyAllowance` | `AgentWallet.remainingDailyAllowance(agent)` |
| `agent.canPurchase` | `AgentWallet.isCallAllowed(agent, merchant, 0x70876c98)` |
| `agent.merchantAllowed` | `AgentWallet.isRecipientAllowed(agent, merchant)` |
| `agent.nextNonce` | `EntryPoint.getNonce(wallet, BigInt(agent))` |
| `wallet.balance` | `MockUSDC.balanceOf(wallet)` |
| `wallet.merchantAllowance` | `MockUSDC.allowance(wallet, merchant)` |
| `wallet.entryPointDeposit` | `AgentWallet.getDeposit()` |
| `wallet.credits` | `MockMerchant.creditsOf(wallet)` |
| `merchant.pricePerCredit`, `purchaseCount` | `MockMerchant.pricePerCredit()`, `purchaseCount()` |
| `submitter.ethBalance` | `eth_getBalance` (not a contract call) |

`warnings` (strings): `AGENT_NOT_VALID`, `AGENT_EXPIRES_SOON` (under 24 h), `DEPOSIT_LOW` (below `MIN_DEPOSIT_WEI`, default 0.001 ETH), `ALLOWANCE_LOW` (below `maxPerTx`), `BALANCE_LOW` (below `maxPerTx`), `SUBMITTER_LOW` (below `MIN_SUBMITTER_WEI`, default 0.001 ETH).

Errors: `502 RPC_ERROR`.

### 4.9 `GET /events?type=&limit=50&before=`

Served from the indexer tables (Phase 10), not live log queries.

| Query | Rule |
|---|---|
| `type` | optional, comma-separated from `AgentSpent, AgentExecuted, AgentRevoked, PolicySet, CreditsPurchased, UserOperationEvent, UserOperationRevertReason` |
| `limit` | 1 to 200, default 50 |
| `before` | optional `blockNumber` for paging |

`200`
```json
{ "fromBlock": 12340000, "toBlock": 12345678, "indexedToBlock": 12345678,
  "events": [
    { "type": "CreditsPurchased", "emitter": "merchant", "blockNumber": 12345670, "timestamp": 1761316990,
      "txHash": "0x…", "logIndex": 4, "label": "agent", "requestId": "req_…",
      "args": { "purchaseId": "7", "buyer": "0x74cD…", "credits": "50", "amountPaid": { "base": "500000", "mUSDC": "0.5" } } },
    { "type": "UserOperationEvent", "emitter": "entryPoint", "blockNumber": 12345670, "timestamp": 1761316990,
      "txHash": "0x…", "logIndex": 5, "label": "agent", "requestId": "req_…",
      "args": { "userOpHash": "0x…", "sender": "0x74cD…", "paymaster": "0x0000…0000", "nonce": "…", "nonceKey": "0xc74b…",
                "success": true, "actualGasCost": "123", "actualGasUsed": "456" } }
  ] }
```
- Newest first. All uint256 args are decimal strings; token amounts (`amount`, `spentToday`, `amountPaid`, `maxPerTx`, `dailyLimit`) are `Amount` objects.
- `label`: `"agent"` (UserOp nonce key = agent address, or an agent event), `"owner"` (nonce key 0, or a direct owner tx), `"other"`.
- Filters: wallet events from the wallet address; `CreditsPurchased` with `buyer == wallet`; EntryPoint events with `sender == wallet`.
- `requestId` links to `purchase_requests` by `userOpHash` or `txHash`, else `null`.

### Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `INVALID_INPUT` | 400 | Bad body or query |
| `NOT_FOUND` | 404 | Unknown request id |
| `WRONG_STATUS` | 409 | Transition not allowed from the current status |
| `BUSY` | 409 | A chat turn or UserOp is already in flight |
| `TX_ALREADY_USED` | 409 | That tx hash already fulfilled a request |
| `TX_NOT_FOUND`, `TX_REVERTED`, `NOT_OWNER_TX`, `NO_PURCHASE_EVENT`, `CREDITS_MISMATCH`, `TX_TOO_OLD` | 422 | Verify failed (§4.6) |
| `RPC_ERROR` | 502 | Chain read failed |
| `LLM_ERROR` | 502 | LLM and fallback both failed |
| `INTERNAL` | 500 | Anything else (no stack traces in the body) |

Codes stored in `purchase_requests.error_code` (never returned as HTTP errors; they describe the purchase):

| Code | From |
|---|---|
| `AA21`, `AA22`, `AA23`, `AA24`, `AA25`, `AA95` | `FailedOp` / `FailedOpWithRevert` reason prefix |
| `ExceedsPerTxLimit`, `ExceedsDailyLimit`, `RecipientNotAllowed`, `CallNotAllowed`, `AgentNotValid`, `NativeValueNotAllowed`, `InvalidTokenCall`, `UnauthorizedCaller` | AgentWallet errors |
| `IncorrectPayment`, `ZeroCredits`, `SafeERC20FailedOperation` | MockMerchant errors |
| `ERC20InsufficientAllowance`, `ERC20InsufficientBalance` | MockUSDC errors |
| `PRECHECK_BLOCKED` | Pre-check `BLOCKED` (message says why) |
| `SUBMITTER_LOW` | Submitter can't pay for `handleOps` (nothing sent) |
| `NO_PURCHASE_EVENT` | Op succeeded but no `CreditsPurchased` was found (treated as `failed_onchain`) |
| `UNKNOWN` | Undecodable revert data (raw hex kept in `error_text`) |

## 5. SQLite schema (`node:sqlite`)

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE purchase_requests (
  id                  TEXT    PRIMARY KEY,                          -- req_<16 hex>
  conversation_id     TEXT,
  credits             INTEGER NOT NULL CHECK (credits BETWEEN 1 AND 10000),
  reason              TEXT    CHECK (reason IS NULL OR length(reason) <= 200),
  agent_address       TEXT    NOT NULL,
  precheck            TEXT    CHECK (precheck IN ('AGENT_OK','NEEDS_OWNER','NEEDS_OWNER_TOPUP','BLOCKED')),
  path                TEXT    CHECK (path IN ('agent','owner')),
  status              TEXT    NOT NULL DEFAULT 'received' CHECK (status IN (
                        'received','precheck_failed','submitted','succeeded','failed_onchain',
                        'needs_owner_approval','fulfilled_by_owner','rejected','expired')),
  price_base          TEXT,                                         -- quote(credits), base units
  nonce               TEXT,                                         -- full UserOp nonce, decimal
  user_op_hash        TEXT    UNIQUE,
  tx_hash             TEXT    UNIQUE,                               -- one tx can prove one request only
  block_number        INTEGER,
  purchase_id         TEXT,                                         -- CreditsPurchased.purchaseId
  amount_paid_base    TEXT,                                         -- CreditsPurchased.amountPaid
  actual_gas_cost_wei TEXT,
  error_code          TEXT,
  error_text          TEXT,
  owner_note          TEXT    CHECK (owner_note IS NULL OR length(owner_note) <= 200),
  expires_at          INTEGER,                                      -- unix seconds, owner path
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  CHECK (status NOT IN ('succeeded','fulfilled_by_owner')
         OR (tx_hash IS NOT NULL AND purchase_id IS NOT NULL AND amount_paid_base IS NOT NULL)),
  CHECK (status <> 'succeeded' OR (path = 'agent' AND user_op_hash IS NOT NULL)),
  CHECK (status <> 'fulfilled_by_owner' OR path = 'owner')
);
CREATE INDEX purchase_requests_status  ON purchase_requests (status);
CREATE INDEX purchase_requests_created ON purchase_requests (created_at DESC);

CREATE TABLE chat_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT    NOT NULL DEFAULT 'default',
  role            TEXT    NOT NULL CHECK (role IN ('user','assistant','tool')),
  content         TEXT    NOT NULL,                                 -- tool rows: JSON of the tool result
  tool_name       TEXT    CHECK (tool_name IS NULL OR tool_name IN ('get_wallet_status','quote_credits','buy_credits','list_requests')),
  tool_call_id    TEXT,
  request_id      TEXT    REFERENCES purchase_requests (id),
  created_at      INTEGER NOT NULL
);
CREATE INDEX chat_messages_conv ON chat_messages (conversation_id, id);

-- Phase 10 (indexer). Listed here so the schema is complete.
CREATE TABLE chain_events (
  tx_hash      TEXT    NOT NULL,
  log_index    INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  timestamp    INTEGER,
  emitter      TEXT    NOT NULL CHECK (emitter IN ('wallet','merchant','entryPoint')),
  type         TEXT    NOT NULL CHECK (type IN ('AgentSpent','AgentExecuted','AgentRevoked','PolicySet',
                                                'CreditsPurchased','UserOperationEvent','UserOperationRevertReason')),
  label        TEXT    NOT NULL CHECK (label IN ('agent','owner','other')),
  args_json    TEXT    NOT NULL,                                     -- bigints as decimal strings
  request_id   TEXT    REFERENCES purchase_requests (id),
  PRIMARY KEY (tx_hash, log_index)                                   -- restart-safe, no duplicates
);
CREATE INDEX chain_events_block ON chain_events (block_number DESC);

CREATE TABLE indexer_state (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  chain_id         INTEGER NOT NULL,
  last_block       INTEGER NOT NULL
);
```

Rules: amounts are TEXT base units (never REAL or INTEGER); times are unix seconds; no key, seed or API key is ever stored;
the only status writer is the transition function from §3.

## 6. LLM tools

Exactly four tools. The model gets no other way to act. Arguments are validated in code against these schemas
(`additionalProperties: false`), and anything invalid returns `{ "error": "INVALID_INPUT", … }` to the model without side effects.

```json
[
  {
    "name": "get_wallet_status",
    "description": "Read the live wallet and agent status: whether the agent is active and valid, per-transaction and daily limits, spent today, remaining today, wallet mUSDC balance, merchant allowance and credits owned. Read-only.",
    "input_schema": { "type": "object", "properties": {}, "additionalProperties": false }
  },
  {
    "name": "quote_credits",
    "description": "Get the price of a number of API credits from the merchant, in mUSDC. Read-only, buys nothing.",
    "input_schema": {
      "type": "object",
      "properties": { "credits": { "type": "integer", "minimum": 1, "maximum": 10000, "description": "Number of API credits" } },
      "required": ["credits"], "additionalProperties": false
    }
  },
  {
    "name": "buy_credits",
    "description": "Buy API credits for the user. The backend checks the on-chain policy. Within policy it buys through the wallet and returns the on-chain result. Above the limits it creates a request that the wallet owner must sign; it never bypasses limits.",
    "input_schema": {
      "type": "object",
      "properties": {
        "credits": { "type": "integer", "minimum": 1, "maximum": 10000, "description": "Number of API credits to buy" },
        "reason":  { "type": "string", "minLength": 1, "maxLength": 200, "description": "Short reason, shown to the owner" }
      },
      "required": ["credits", "reason"], "additionalProperties": false
    }
  },
  {
    "name": "list_requests",
    "description": "List recent purchase requests and their status. Read-only.",
    "input_schema": {
      "type": "object",
      "properties": {
        "limit":  { "type": "integer", "minimum": 1, "maximum": 20, "default": 10 },
        "status": { "type": "string", "enum": ["received","precheck_failed","submitted","succeeded","failed_onchain",
                                               "needs_owner_approval","fulfilled_by_owner","rejected","expired"] }
      },
      "additionalProperties": false
    }
  }
]
```
(`input_schema` is the Anthropic name; for an OpenAI-style API the same object goes in `parameters`.)

**Tool results** (what the model sees; no addresses other than the tx hash, no calldata):

| Tool | Result |
|---|---|
| `get_wallet_status` | `{ agentActive, agentValidNow, validUntilIso, maxPerTx, dailyLimit, spentToday, remainingToday, walletBalance, merchantAllowance, credits, pricePerCredit, warnings }` (amounts as mUSDC strings) |
| `quote_credits` | `{ credits, price: "0.5 mUSDC", withinPerTxLimit: bool, withinRemainingToday: bool }` |
| `buy_credits` | `{ requestId, status, precheck, price, txHash?, explorerUrl?, error?: { code, message }, ownerMustSign: bool }` |
| `list_requests` | `{ requests: [{ requestId, status, credits, price, txHash, error, createdAt }] }` |

**Not tools, by design:** changing the policy, adding or revoking agents, approving or verifying a request, marking
anything paid, choosing a target, recipient, token or amount other than `credits`, transferring tokens, minting.
Messages asking for any of these get a refusal and no tool call.

**Fallback planner** (no LLM): regex `/\bbuy\s+(\d{1,5})\s+(?:api\s+)?credits?\b/i` → `buy_credits`;
`/\b(status|balance|limit)\b/i` → `get_wallet_status`; `/\b(price|quote|cost)\b.*?(\d{1,5})/i` → `quote_credits`;
`/\b(requests?|history)\b/i` → `list_requests`; otherwise a help reply.

## 7. Agent purchase pipeline (for reference, Phase 4)

`buy_credits` → row `received` → pre-check → if `AGENT_OK`: per-agent lock → `price = quote(credits)` →
`inner = purchase(credits, price)` → `callData = executeAsAgent(agent, merchant, 0, inner)` →
`nonce = EntryPoint.getNonce(wallet, BigInt(agent))` → packed v0.7 op (gas 500k / 500k / 60k, no initCode, no paymaster) →
`getUserOpHash` → agent `signMessage({ message: { raw } })` → simulate `handleOps` (reject → `precheck_failed` + AAxx) →
send `handleOps([op], submitter)` with `gas = 1_260_000` → `submitted` → receipt →
`UserOperationEvent.success` + `CreditsPurchased` → `succeeded`, else `failed_onchain` with decoded `UserOperationRevertReason`.

## 8. Configuration (`backend/.env`)

| Var | Default | Notes |
|---|---|---|
| `CHAIN_ID` | `84532` | `31337` for Anvil |
| `RPC_URL` | chain default | |
| `AGENT_ADDRESS`, `AGENT_PRIVATE_KEY` | — | Startup fails if the key's address ≠ `AGENT_ADDRESS` |
| `SUBMITTER_PRIVATE_KEY` | — | Funded throwaway EOA, not the owner |
| `LLM_API_KEY` | — | Empty → fallback planner |
| `DB_PATH` | `data/agent.sqlite` | |
| `PORT` | `8787` | |
| `FRONTEND_ORIGIN` | `http://localhost:5173` | CORS |
| `APPROVAL_TTL_SECONDS` | `86400` | |
| `MIN_DEPOSIT_WEI`, `MIN_SUBMITTER_WEI` | `1000000000000000` | Warnings and send guard |
| `MAX_CREDITS_PER_REQUEST` | `10000` | Same as the tool schema |

Startup refuses to run if `OWNER_PRIVATE_KEY` is set.

## 9. Security summary

- SQLite rows, LLM output and pre-check results are never authorization (§1).
- `fulfilled_by_owner` requires the six checks in §4.6; `tx_hash UNIQUE` stops one owner tx proving two requests.
- `CreditsPurchased` is only trusted when emitted by the merchant address in `contracts/deployments/<chainId>.json`.
- User text, LLM text, `reason` and chain strings are untrusted; they are stored and displayed as text only.
- One UserOp in flight per agent (prevents `AA25`).
- Error bodies never include keys, the RPC URL or stack traces.

## 10. On-chain names used (all present in `abi/`)

| ABI file | Functions | Events | Errors |
|---|---|---|---|
| `AgentWallet.json` | `executeAsAgent`, `executeBatch`, `getAgent`, `isAgentValid`, `isCallAllowed`, `isRecipientAllowed`, `remainingDailyAllowance`, `owner`, `getDeposit` | `AgentSpent`, `AgentExecuted`, `AgentRevoked`, `PolicySet` | `ExceedsPerTxLimit`, `ExceedsDailyLimit`, `RecipientNotAllowed`, `CallNotAllowed`, `AgentNotValid`, `NativeValueNotAllowed`, `InvalidTokenCall`, `UnauthorizedCaller` |
| `EntryPoint.v0.7.0.json` | `getNonce`, `getUserOpHash`, `handleOps` | `UserOperationEvent`, `UserOperationRevertReason` | `FailedOp`, `FailedOpWithRevert` |
| `MockMerchant.json` | `quote`, `purchase`, `pricePerCredit`, `purchaseCount`, `creditsOf` | `CreditsPurchased` | `IncorrectPayment`, `ZeroCredits`, `SafeERC20FailedOperation` |
| `MockUSDC.json` | `balanceOf`, `allowance`, `approve` | — | `ERC20InsufficientAllowance`, `ERC20InsufficientBalance` |

Selectors used: `executeAsAgent` `0x6151bacc`, `purchase(uint256,uint256)` `0x70876c98` (from `abi/selectors.json`).

## Changelog

- v1 (2026-10-24): first frozen version.
