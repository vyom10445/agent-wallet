# Agent backend (P-2)

The AI agent backend for the AgentWallet contracts. **Status:** Phase 1 (setup), Phase 2 (API frozen in [docs/BACKEND_API.md](docs/BACKEND_API.md)), Phase 3 (config and read-only chain client), Phase 4 (agent UserOp pipeline), Phase 5 (policy pre-check), Phase 6 (SQLite store), Phase 7 (AI agent), the HTTP server for H12 and Phase 9 (owner approvals) done.

Addresses come from `../contracts/deployments/<chainId>.json` and ABIs from `../abi/`. Nothing is hard-coded,
and nothing in `contracts/`, `abi/` or `integration/` is changed.

## Choices (recorded in Phase 1)

| What | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 LTS, **22.13 or later** | `node:sqlite` works without a flag from 22.13. `--env-file-if-exists` needs 22.9 or later. |
| viem | **2.57.11** (exact, no `^`) | Same pin as `integration/package.json`, so code ported from `integration/lib.mjs` behaves the same. `npm run check` fails if they drift. |
| SQLite | **`node:sqlite`** (built into Node) | No install, no native build, no prebuilt binary to download. Fallback: `better-sqlite3@13.0.3`, which ships a `win32-x64` prebuild. |
| `.env` loading | Node's `--env-file-if-exists` | No `dotenv` dependency. |
| LLM SDK | Chosen in Phase 7 | Not needed yet. |

`node:sqlite` is still marked experimental, so Node prints an `ExperimentalWarning`. The npm scripts hide it with
`--disable-warning=ExperimentalWarning`.

## Setup (PowerShell)

```powershell
node --version        # v22.13.0 or later
npm --version
cd agent-wallet\backend
npm install
Copy-Item .env.example .env   # then fill in .env in VS Code (testnet throwaway keys only)
npm run check
```

`npm run check` is offline and read-only. It should end with `Setup OK`.

If PowerShell says `npm.ps1 cannot be loaded because running scripts is disabled`, run this once:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

## Verify the live P-1 setup (Step 1.4)

```powershell
cd agent-wallet\integration
npm install
$env:AGENT_ADDRESS = "0xC74Ba823524Cbd1d889b5FD38785b9d293C6D8aD"
node read.mjs
cd ..\contracts
forge script script/Status.s.sol --rpc-url base_sepolia
```

Expect `EntryPoint is v0.7 true` and `agent valid now true`. If the agent has expired, revoke it and rerun
ConfigureAgent as in `docs/PHASE12_FINAL.md` §8.

## Phase 3: config and reads

- `src/config.js`: loads `backend/.env` values, the address book `../contracts/deployments/<CHAIN_ID>.json` and the ABIs in
  `../abi/`. It fails at startup with a clear `ConfigError` if `RPC_URL`, `AGENT_PRIVATE_KEY` or `SUBMITTER_PRIVATE_KEY` is
  missing or malformed, if `AGENT_ADDRESS` doesn't match the agent key, or if a key is the owner's. Keys become viem
  accounts; the key strings are never kept, logged or put in an error message.
- `src/chain/reads.js`: every read the backend needs (bigint base units), `snapshot()` at one block, and
  `assertStartup()`: RPC is on `CHAIN_ID`, `wallet.entryPoint()` equals the deployment's EntryPoint, and
  `getAgent(agent).active` is true for the agent key. Otherwise it throws a clear `StartupError`.
- `scripts/status.mjs`: prints the same labels and values as `Status.s.sol`, plus a few extra lines.

### Compare with Status.s.sol on Base Sepolia

`backend/.env` needs `CHAIN_ID=84532`, `RPC_URL`, `AGENT_PRIVATE_KEY` and `SUBMITTER_PRIVATE_KEY`.

```powershell
cd agent-wallet\backend
npm run status
cd ..\contracts
forge script script/Status.s.sol --rpc-url base_sepolia
```

Every line down to `remaining today` should be the same (the backend also shows mUSDC in brackets).

### Tests

```powershell
cd agent-wallet\backend
npm test               # all tests: config (offline), Anvil (skipped if Anvil is not running), Base Sepolia (read-only, skipped without keys in .env)
npm run test:sepolia   # only the Base Sepolia read-only tests
npm run test:anvil     # only the config + Anvil tests (does not read .env)
```

Local Anvil chain for `test:anvil` (Anvil's published dev keys only; redo the deploy after every Anvil restart):

```powershell
# terminal 1
anvil
# terminal 2
cd agent-wallet\contracts
forge script script/Deploy.s.sol --rpc-url anvil --broadcast --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
$env:AGENT_ADDRESS="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"   # Anvil account #1
forge script script/ConfigureAgent.s.sol --rpc-url anvil --broadcast --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
cd ..\backend
npm run test:anvil
```

To run the status script on Anvil, override the env for that window. Process env wins over `.env`:

```powershell
$env:CHAIN_ID="31337"; $env:RPC_URL="http://127.0.0.1:8545"
$env:AGENT_PRIVATE_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"      # Anvil #1
$env:SUBMITTER_PRIVATE_KEY="0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"  # Anvil #2
npm run status
Remove-Item Env:CHAIN_ID, Env:RPC_URL, Env:AGENT_PRIVATE_KEY, Env:SUBMITTER_PRIVATE_KEY   # back to .env
```

## Phase 4: agent UserOp pipeline

`src/chain/userop.js` ports `buildUserOp`, `signUserOp`, `submitUserOp`, `readOpResult`, `explainError` and
`BUNDLE_GAS_LIMIT` from `integration/lib.mjs` unchanged in behaviour, and adds:

- `createPurchaser(config, reads).purchaseCredits({ credits })`: the only entry point for the app. It accepts nothing
  but an integer `credits` (1 to 10000), builds `purchase(credits, quote(credits))` and wraps it in
  `executeAsAgent(agent, merchant, 0, inner)` itself.
- A per-agent queue: one UserOp in flight per agent, nonce read right before each op (no AA25).
- Funds checks before sending: the wallet's EntryPoint deposit must cover the op's prefund (else `AA21`, not sent),
  a `DEPOSIT_LOW` warning below 0.001 ETH, and the submitter must have ETH for `BUNDLE_GAS_LIMIT` (else `SUBMITTER_LOW`).
- Error codes: `errorCode()` returns `AA21`/`AA22`/`AA24`/`AA25`/`AA95`..., or the custom error name
  (`ExceedsPerTxLimit`, `ExceedsDailyLimit`, `ERC20InsufficientAllowance`, ...), plus the `explainError` line.

Result `outcome`: `succeeded` (UserOperationEvent.success and a CreditsPurchased from the merchant),
`failed_onchain` (mined, op failed; `code` from UserOperationRevertReason), `not_sent` (nothing sent), or
`submitted` (sent, receipt not read yet: `RECEIPT_TIMEOUT`).

The Anvil tests top up the wallet's EntryPoint deposit themselves (Anvil gas is about 1000x Base Sepolia's, so the
0.005 ETH default lasts only about a dozen ops). Each `test:anvil` run spends about 0.18 mUSDC of the agent's 5 mUSDC daily limit and the 10 mUSDC merchant allowance.
If tests start failing with `ExceedsDailyLimit` or `ERC20InsufficientAllowance`, rerun ConfigureAgent (or restart
Anvil and redeploy).

## Phase 5: policy pre-check

`src/policy/precheck.js`: `precheck(reads, { credits })` reads fresh values at the latest block (no cache) and
returns `AGENT_OK`, `NEEDS_OWNER`, `NEEDS_OWNER_TOPUP` or `BLOCKED`, with every failed rule in `reasons`
(`INVALID_CREDITS`, `AGENT_NOT_ACTIVE`, `AGENT_NOT_VALID`, `WRONG_POLICY_TOKEN`, `CALL_NOT_ALLOWED`,
`RECIPIENT_NOT_ALLOWED`, `EXCEEDS_PER_TX`, `EXCEEDS_DAILY`, `ALLOWANCE_TOO_LOW`, `BALANCE_TOO_LOW`).
Priority: BLOCKED > NEEDS_OWNER > NEEDS_OWNER_TOPUP > AGENT_OK. `evaluatePrecheck(state)` is the pure decision.

The result is **advisory** (`advisory: true`): it only picks the path. It never marks anything paid or approved;
success is proven only on chain (UserOperationEvent.success + CreditsPurchased, or a verified owner tx).

`test/precheck.anvil.test.mjs` wraps every test in `evm_snapshot` / `evm_revert`, so it leaves the agent's daily
spend, the allowance and the agent list exactly as they were. It uses the Anvil owner key (#0) to approve, transfer
and add/revoke a spare agent (#4) the way the real owner would.

## Phase 6: SQLite store

`src/db/` (`node:sqlite`, schema exactly as in `docs/BACKEND_API.md` §5):

- `schema.js`: tables `purchase_requests`, `chat_messages`, `chain_events`, `indexer_state` (idempotent, `user_version` 1).
- `store.js`: `createStore(openDb(path))`. `transition(id, to, fields)` is the only status writer and allows only the
  lifecycle arrows. `succeeded` / `fulfilled_by_owner` need a tx hash and the decoded `CreditsPurchased`
  (`purchase: { purchaseId, credits, amountPaid }`, credits must match). SQL `CHECK`s back this up, and
  `tx_hash UNIQUE` stops one tx proving two requests. Amounts are base-unit strings in SQLite and bigint in JS.
  Text that contains a secret from the env (`*PRIVATE_KEY*`, `*API_KEY*`, ...) is refused.
- `recovery.js`: `resolveSubmitted()` reads the receipt of every `submitted` row: `succeeded` (with proof) or
  `failed_onchain` (decoded reason); rows with no receipt yet stay `submitted`.
- `index.js`: `startStore(config, reads)` = open + recover + expire overdue approvals. The server calls it on start.

The database file is `DB_PATH` (default `data/agent.sqlite`, git-ignored). To start over, stop the backend and delete
`backend\data\`.

## Phase 7: AI agent

`src/agent/`:

- `tools.js`: the four tools from `docs/BACKEND_API.md` §6 (`get_wallet_status`, `quote_credits`, `buy_credits`,
  `list_requests`). Arguments are validated in code (no extra keys, `credits` 1 to 10000). `buy_credits` runs the
  pre-check, then buys through the UserOp pipeline (`AGENT_OK`), creates a `needs_owner_approval` request
  (`NEEDS_OWNER` / `NEEDS_OWNER_TOPUP`), or returns the reason (`BLOCKED`). Tool results contain no addresses or calldata.
- `llm.js`: plain `fetch`, no SDK. Provider from `.env` (below). Any API error, timeout or refusal falls back to the planner.
- `fallback.js`: deterministic planner ("buy N credits", "price of N credits", "status", "requests"). It refuses
  messages that contain an address or ask to change limits, move funds or approve anything.
- `agent.js`: the loop. Code adds a fixed "On-chain result" line for every purchase, and a model reply that claims an
  unproven purchase, a transfer or a limit change is replaced. Addresses are stripped from model text.

Try it (uses `backend\.env`):

```powershell
cd agent-wallet\backend
npm run chat -- "buy 50 credits"
npm run chat -- "buy 500 credits"      # over the 1 mUSDC limit: needs_owner_approval, nothing sent
npm run chat -- "status"
```

### Choosing an LLM (`backend\.env`)

| Option | Cost | Settings |
|---|---|---|
| No LLM (default) | Free, offline | `LLM_PROVIDER=none` |
| Ollama on your PC | Free, local | Install from ollama.com, run `ollama pull qwen2.5:7b` (a model with tool calling), then `LLM_PROVIDER=openai-compatible`, `LLM_BASE_URL=http://localhost:11434/v1`, `LLM_MODEL=qwen2.5:7b`, no key |
| Google Gemini | Free tier (rate-limited) | Key from aistudio.google.com, then `LLM_PROVIDER=openai-compatible`, `LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/`, `LLM_MODEL=gemini-2.5-flash` (or a newer Flash model), `LLM_API_KEY=<key>` |
| Anthropic Claude | Paid per token | `LLM_PROVIDER=anthropic`, `LLM_API_KEY=<key>`; `LLM_MODEL` defaults to `claude-opus-5-5`. `claude-haiku-5-5` is much cheaper if you prefer. Refusal fallbacks (`fallbacks: "default"`) are on for the models that support them |
| OpenAI | Paid per token | `LLM_PROVIDER=openai-compatible`, `LLM_API_KEY=<key>`; base URL defaults to `https://api.openai.com/v1`, model to `gpt-4o-mini` |

Model names change often; check the provider's model list if one is rejected. Whatever you pick, a failing or
missing LLM never blocks the demo: the planner takes over and `planner` in the result says `fallback`.

## HTTP server and H12 live run

`src/server.js` (`npm start`): `node:http` on `127.0.0.1:PORT`, routes from `docs/BACKEND_API.md` §4:
`GET /health`, `POST /agent/chat`, `GET /agent/messages`, `GET /requests`, `GET /requests/:id` (with `ownerApproval`
rebuilt from chain for over-limit requests), `POST /approvals/:id/verify`, `POST /approvals/:id/reject`,
`GET /wallet/status`. `GET /events` (Phase 10) returns `501 NOT_IMPLEMENTED` for now.
On start it runs the config and chain checks, recovers `submitted` rows, expires overdue approvals and re-checks paid
rows against the chain.

`scripts/h12-live.mjs` (`npm run h12`): the H12 go/no-go against the running server. Full PowerShell steps,
including the `integration/agent-purchase.mjs` diagnosis and the Anvil fallback: [docs/H12_RUNBOOK.md](docs/H12_RUNBOOK.md).

## Phase 9: owner approvals

`src/approvals/`: `ownerApproval.js` builds what the owner signs (`wallet.executeBatch` with `approve(merchant,
standing + quote)` and `purchase(credits, quote)`, read from chain each time). `verify.js` checks the owner's tx on chain
before a request becomes `fulfilled_by_owner`. `proof.js` re-checks paid rows on read, so an edited database row shows
`proofVerified: false`. The backend never signs owner approvals. Requests expire after `APPROVAL_TTL_SECONDS`.
Checks, the Step 9.2 PowerShell run and the tests: [docs/PHASE9_OWNER_APPROVAL.md](docs/PHASE9_OWNER_APPROVAL.md).

## Keys

- `.env` holds the **agent** key and a separate **submitter** key (a funded Base Sepolia EOA). Testnet throwaway keys only.
- The backend never holds the **owner** key. `npm run check` fails if `OWNER_PRIVATE_KEY` is set.
- Keys never go into SQLite, logs, API responses or prompts.

## Planned layout (later phases)

```
backend/
├── scripts/check-setup.mjs   (Phase 1)
├── scripts/status.mjs        (Phase 3)
├── scripts/chat.mjs          (Phase 7)
├── scripts/h12-live.mjs      (H12 live check)
├── docs/H12_RUNBOOK.md       (H12 PowerShell steps)
├── docs/BACKEND_API.md       (Phase 2, frozen)
├── src/
│   ├── config.js             (Phase 3, done: env, chain, addresses, ABIs)
│   ├── chain/reads.js        (Phase 3, done: read-only client and startup checks)
│   ├── chain/userop.js       (Phase 4, done: UserOp builder, submitter, decoder, per-agent queue)
│   ├── policy/precheck.js    (Phase 5, done: off-chain pre-check, advisory)
│   ├── db/                   (Phase 6, done: schema, store, transitions, startup recovery)
│   ├── agent/                (Phase 7, done: LLM loop, typed tools, fallback planner)
│   ├── approvals/            (Phase 9, done: owner approval payload, on-chain verify, proof re-check)
│   └── server.js             (done: HTTP API, /events still 501)
├── test/
└── data/                     (SQLite file, git-ignored)
```
