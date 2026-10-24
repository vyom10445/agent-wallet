# Phase 10: event indexer and `GET /events`

`npm start` starts a background poller (`src/events/indexer.js`, ported from `integration/events.mjs`). It indexes, for
our wallet only:

| Emitter | Events | Filter |
|---|---|---|
| wallet | `AgentSpent`, `AgentExecuted`, `AgentRevoked`, `PolicySet` | address = wallet |
| merchant | `CreditsPurchased` | `buyer == wallet` |
| EntryPoint | `UserOperationEvent`, `UserOperationRevertReason` | `sender == wallet` |

- **Chunks:** `eth_getLogs` over `EVENTS_CHUNK_SIZE` blocks (default 5000). If the RPC refuses the range, the chunk is
  halved and retried.
- **Resume:** each chunk's events and the new `indexer_state.last_block` are committed in one SQLite transaction, and
  `(tx_hash, log_index)` is the primary key. A restart or crash resumes at `last_block + 1`: nothing is duplicated
  or skipped.
- **Start block** for a new database: `EVENTS_START_BLOCK`, else the first block in
  `contracts/broadcast/Deploy.s.sol/<chainId>/run-latest.json`, else the last 100,000 blocks.
- **Confirmations:** only blocks `EVENTS_CONFIRMATIONS` deep (default 2 on Base Sepolia, 0 on Anvil).
- **Labels:** UserOp nonce key `nonce >> 64`: `0` = owner, the agent address = agent (`nonceSequence` = low 64 bits).
  `AgentSpent` / `AgentExecuted` = agent; `PolicySet` / `AgentRevoked` = owner. `CreditsPurchased` takes the label of
  the UserOp it ran in, or `owner` for a direct tx from `wallet.owner()`.
- **requestId:** matched to `purchase_requests` by `userOpHash`, else tx hash; also re-matched when read, so an owner
  purchase indexed before it was verified gets its `requestId` once verify stores the tx.
- A database indexed on another chain is refused at start-up (use one `DB_PATH` per chain).

`GET /events?type=CreditsPurchased,UserOperationEvent&limit=50&before=<block>`: newest first, see `BACKEND_API.md` §4.9.
`GET /health` shows `events: { indexedToBlock, lastError, polling }`.

## Check on Base Sepolia (PowerShell)

Use the same `backend\.env` and database as H12 and Step 9.2, so the Phase 8 and 9 purchases are in it.
If `contracts\broadcast\Deploy.s.sol\84532\run-latest.json` is not on this PC, set the start block once:
`EVENTS_START_BLOCK=<the wallet's deploy block from BaseScan>` in `backend\.env`.

Window 1:

```powershell
cd agent-wallet\backend
npm start
```

Window 2 (the first catch-up from the deploy block takes a minute or two on the public RPC):

```powershell
cd agent-wallet\backend
$api = "http://127.0.0.1:8787"
(Invoke-RestMethod "$api/health").events          # indexedToBlock rises until it reaches the head, lastError empty
npm run events:check                               # run 1: saves data\events-check.json
Invoke-RestMethod "$api/events?type=CreditsPurchased&limit=10" | Select-Object -ExpandProperty events |
  Format-Table blockNumber, label, requestId, @{n="credits"; e={$_.args.credits}}, txHash
```

Expect the H12 purchase (10 credits) labelled `agent` and the Step 9.2 purchase (150 credits) labelled `owner`, each
with its `requestId`. Then restart and check again:

```powershell
# window 1: Ctrl+C, then
npm start
# window 2, after a few seconds:
npm run events:check                               # run 2: all saved events still present, none twice -> EVENTS: OK
```

`npm run events:check` checks: no duplicate `(txHash, logIndex)`; every `succeeded` request has a `CreditsPurchased`
labelled `agent` and every `fulfilled_by_owner` one labelled `owner`, with matching tx and credits; and, from the second
run on, every event saved by the previous run is still there exactly once.

If `lastError` mentions a rate limit or range, the poller retries every `EVENTS_POLL_MS`; lower `EVENTS_CHUNK_SIZE`
(e.g. 2000) if it keeps failing.

## Tests (Anvil)

`test/events.anvil.test.mjs` (in `npm run test:anvil`): an agent purchase and a verified owner purchase through the API
appear with labels `agent` / `owner` and their requestIds; an owner UserOp on nonce key 0, a failed agent op
(`UserOperationRevertReason` with the decoded reason) and an owner `setPolicy`; type filter and paging; restart with
nothing new; a crash in the middle of a sync, then a restart that resumes and ends identical to a clean re-index; an RPC
range limit; a database from another chain.
