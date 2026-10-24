# P-3 Phase 1: Inspection report and setup plan

Inspected 2026-10-24 from the P-1 zips plus every P-2 changes zip (phase 1 to 12, applied in order). Nothing in
`contracts/`, `abi/`, `integration/` or `backend/` was changed. The frontend is not implemented yet; this phase only adds
setup files (`vite.config.ts`, `.env.example`, `scripts/check-setup.mjs`) and this report.

What was tested in the sandbox (no Base Sepolia access there): `create-vite@9.3.1` scaffold, `viem@2.57.11` install,
`tsc -b && vite build` clean, the dev server serving `../abi` and `../contracts/deployments` with the new
`vite.config.ts` (and refusing `backend/`), and `check-setup.mjs` against a mock backend (pass, CORS mismatch, expired
agent, backend down). The live checks in Step 4 are yours to run.

---

## 1. Directory structure

```
agent-wallet/
├── README.md, .gitignore, .gitmodules, .vscode/
├── abi/                     AgentWallet, AgentWalletFactory, EntryPoint.v0.7.0, IAgentWallet, MockMerchant, MockUSDC,
│                            SimpleAccount.v0.7.0 (.json, plain ABI arrays), selectors.json
├── contracts/               Foundry project (src, script, test, lib), deployments/84532.json (31337.json only after a local deploy)
├── docs/                    P-1 phase docs: INTERFACE, PHASE6..PHASE12, PHASE11_INTEGRATION, PHASE11_DEBUGGING
├── integration/             viem examples: lib.mjs, read.mjs, events.mjs, owner-configure.mjs, owner-approve.mjs, agent-purchase.mjs
├── backend/                 src/{server,config}.js, agent/, approvals/, chain/, db/, events/, policy/; scripts/; test/;
│                            docs/BACKEND_API.md (v1 frozen), BACKEND_FINAL.md, H12_RUNBOOK, PHASE9/10/11 docs
└── frontend/                NEW (this phase): Vite + React + TS starter, plus the files in this zip
    ├── docs/P3_PHASE1_INSPECTION.md
    ├── scripts/check-setup.mjs
    ├── .env.example
    └── vite.config.ts
```

Planned layout for later phases (unchanged from the plan): `src/config.ts`, `src/api/`, `src/chain/`, `src/components/`,
`src/lib/`, `test/`.

## 2. Backend API v1 (`backend/docs/BACKEND_API.md`) and additive fields (`BACKEND_FINAL.md` §3)

Conventions: base URL `http://127.0.0.1:8787`, JSON, bodies need `Content-Type: application/json`, max 16 KB, no auth.
Amounts are `Amount = { base: string; mUSDC: string }` (6 decimals). Wei is a decimal string. Times are unix seconds.
Request ids match `req_[0-9a-f]{16}`. Errors are `{ error: { code, message, details? } }`.

| Endpoint | Request | 200 response | Errors |
|---|---|---|---|
| `GET /health` | none | `{ ok, apiVersion: "1", chainId, wallet, agent, llm: "available"\|"fallback", dbPath }` + additive `events: { indexedToBlock, lastError, polling }` | — |
| `POST /agent/chat` | `{ message: 1..2000 chars, conversationId?: ^[a-zA-Z0-9_-]{1,64}$ }` | `{ conversationId, reply, requestIds: string[], toolCalls: { name, args, result }[], planner: "llm"\|"fallback" }` | 400 `INVALID_INPUT` (also: message contains a backend key), 409 `BUSY`, 502 `LLM_ERROR` |
| `GET /agent/messages` | `?conversationId=default&limit=1..200` (50) | `{ conversationId, messages: { id, role: "user"\|"assistant", content, requestId, createdAt }[] }` oldest first | 400 |
| `GET /requests` | `?status=a,b&limit=1..200&before=<unix s>` | `{ requests: PurchaseRequest[] }` newest first, no `ownerApproval` | 400 |
| `GET /requests/:id` | — | `PurchaseRequest` + `ownerApproval` while `needs_owner_approval`/`expired` | 404 `NOT_FOUND`, 502 `RPC_ERROR` |
| `POST /approvals/:id/verify` | `{ txHash: 0x + 64 hex }` | `{ request: PurchaseRequest (proofVerified: true), checks: { name, ok }[] }` | 400, 404, 409 `WRONG_STATUS`/`TX_ALREADY_USED`, 422 (§5 below), 502 |
| `POST /approvals/:id/reject` | `{ note?: ≤200 chars }` | `{ request: PurchaseRequest }` status `rejected` | 404, 409 `WRONG_STATUS` (only from `needs_owner_approval`) |
| `GET /wallet/status` | — | see below | 502 `RPC_ERROR` |
| `GET /events` | `?type=a,b&limit=1..200&before=<blockNumber>` | `{ fromBlock, toBlock, indexedToBlock, events: ChainEvent[] }` newest first | 400 (unknown type, bad limit/before) |

`PurchaseRequest`: `id, status, path ("agent"|"owner"|null), precheck ("AGENT_OK"|"NEEDS_OWNER"|"NEEDS_OWNER_TOPUP"|"BLOCKED"|null),
credits, reason (untrusted), price: Amount|null, amountPaid: Amount|null, purchaseId, agent, nonce, userOpHash, txHash,
blockNumber, actualGasCost: Wei|null, error: { code, message }|null, explorerUrl, conversationId, expiresAt, createdAt,
updatedAt, ownerApproval?`, plus additive `proofVerified?: boolean|null` (paid statuses only) and
`proofChecks?: { name, ok, detail? }[]` (`GET /requests/:id` only).

`GET /wallet/status`: `chainId, blockNumber, readAt, addresses { wallet, owner, entryPoint, usdc, merchant, agent },
agent { active, validNow, validAfter, validUntil, validUntilIso, token, maxPerTx, dailyLimit, spentToday,
remainingDailyAllowance, canPurchase, merchantAllowed, nonceKey, nextNonce }, wallet { balance, merchantAllowance,
entryPointDeposit (wei), credits }, merchant { pricePerCredit, purchaseCount }, submitter { address, ethBalance },
warnings[]`.

`ChainEvent`: `type, emitter ("wallet"|"merchant"|"entryPoint"), blockNumber, timestamp, txHash, logIndex,
label ("agent"|"owner"|"other"), requestId|null, args` (uint256 as decimal strings, token amounts as `Amount`); additive
`args.nonceSequence` on UserOp events and `args.reason` on `UserOperationRevertReason`. `nonceKey` is `"0x0"` for owner ops.

**Status values (9):** `received`, `precheck_failed`, `submitted`, `succeeded`, `failed_onchain`, `needs_owner_approval`,
`fulfilled_by_owner`, `rejected`, `expired`. Paid means `succeeded`/`fulfilled_by_owner` **and** `proofVerified === true`.

**Warnings (6):** `AGENT_NOT_VALID`, `AGENT_EXPIRES_SOON`, `DEPOSIT_LOW`, `ALLOWANCE_LOW`, `BALANCE_LOW`, `SUBMITTER_LOW`.

**Event types (7):** `AgentSpent`, `AgentExecuted`, `AgentRevoked`, `PolicySet`, `CreditsPurchased`, `UserOperationEvent`,
`UserOperationRevertReason`.

**HTTP error codes:** `INVALID_INPUT` 400, `NOT_FOUND` 404, `WRONG_STATUS` 409, `BUSY` 409, `TX_ALREADY_USED` 409,
`TX_NOT_FOUND` / `TX_REVERTED` / `NOT_OWNER_TX` / `NO_PURCHASE_EVENT` / `CREDITS_MISMATCH` / `TX_TOO_OLD` 422,
`RPC_ERROR` 502, `LLM_ERROR` 502, `INTERNAL` 500. Two cases the doc table does not list, seen in `server.js`: an unknown
path returns 404 `NOT_FOUND` ("No such endpoint", also for a malformed request id), and a wrong method returns
**405** with code `INVALID_INPUT`. The client should map by `code`, not by status.

**Stored `error.code` values on a request:** `AA21`, `AA22`, `AA23`, `AA24`, `AA25`, `AA95`, `ExceedsPerTxLimit`,
`ExceedsDailyLimit`, `RecipientNotAllowed`, `CallNotAllowed`, `AgentNotValid`, `NativeValueNotAllowed`, `InvalidTokenCall`,
`UnauthorizedCaller`, `IncorrectPayment`, `ZeroCredits`, `SafeERC20FailedOperation`, `ERC20InsufficientAllowance`,
`ERC20InsufficientBalance`, `PRECHECK_BLOCKED`, `SUBMITTER_LOW`, `NO_PURCHASE_EVENT`, `UNKNOWN`, and additive `CHAIN_MISMATCH`.

## 3. Addresses and importing them with Vite

`contracts/deployments/84532.json`:

| Key | Address |
|---|---|
| chainId | 84532 |
| entryPoint | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |
| factory | `0xAD5E19b7A292735b79D13e48A854BAf6baC96D51` |
| implementation | `0xec0de95c6C52d1AECCECde692c422c94987Bc262` |
| merchant | `0x8D94CcD748a00C27Cc339aaE3A14F2965E8b4FC1` |
| owner | `0x815d211D2E85E2C2526f0CC3bB1DEE11513C7b64` |
| usdc | `0xC91a11d7096c0685590267C083Fd67A518D65C3F` |
| wallet | `0x74cD24BBaf39022155d2912923F4dC234D215c1A` |

There is **no `agent` key** in the file. The agent address comes from the backend (`/health.agent`,
`/wallet/status.addresses.agent`); the frontend checks the two agree and that `getAgent(agent)` on chain is active.

Importing (both tested):

```ts
import walletAbi from '../../abi/AgentWallet.json'            // from frontend/src/...
const books = import.meta.glob<Deployment>('../../contracts/deployments/*.json', { eager: true, import: 'default' })
```

- Use `import.meta.glob` for the deployments, not a static import of `31337.json`: that file only exists after a local
  deploy, and a static import of a missing file breaks the build. The glob simply returns what exists.
- `tsc -b` accepts JSON imports with the template's settings (TS 6, `moduleResolution: "bundler"`). JSON ABIs are typed
  loosely, so viem cannot infer function names or return types from them. Phase 3 will cast them to viem's `Abi` and give
  each read an explicit return type (no copied ABIs).
- **`server.fs.allow` is needed.** `vite build` is fine without it, but the dev server returns **403 "outside of Vite
  serving allow list"** for `../abi` and `../contracts/deployments` whenever `agent-wallet/` is not a git repository
  (with a `.git` folder it happens to work). The new `vite.config.ts` allows exactly `frontend/`, `../abi` and
  `../contracts/deployments`. It deliberately does not allow `..`, so `backend/.env` (agent and submitter keys) can
  never be served by the dev server; this was checked (403).

## 4. How `integration/owner-approve.mjs` does the owner approval, and `ownerApproval`

1. **Build from chain, never from the agent's numbers:** `price = merchant.quote(credits)`,
   `standing = usdc.allowance(wallet, merchant)`. `dest = [usdc, merchant]`,
   `func = [encodeFunctionData(approve(merchant, standing + price)), encodeFunctionData(purchase(credits, price))]`,
   `value = []` (SimpleAccount treats an empty array as zero ETH for every call).
2. **Decode and show:** each `func[i]` is decoded back with `decodeFunctionData` (`abi.usdc` for 0, `abi.merchant` for 1)
   and printed as `dest.function(args)`, plus the price, the owner's max and the standing allowance it returns to.
3. **Max-price gate:** refuses if `price > MAX_PRICE`.
4. **Simulate:** `publicClient.simulateContract({ account: owner, address: wallet, abi: wallet, functionName: "executeBatch", args: [dest, [], func] })`.
5. **Send:** `walletClient.writeContract(request)` as a **direct tx from the owner EOA** (executeBatch is owner or
   EntryPoint only; a wrong account reverts `"account: not Owner or EntryPoint"`).
6. **Result:** `waitForTransactionReceipt`, `readOpResult(receipt)` and look for `CreditsPurchased`; for a direct owner tx
   `receipt.status === "success"` plus that event is the result.

In the browser the only change is the signer: `createWalletClient({ chain, transport: custom(window.ethereum) })`, the
account from `eth_requestAccounts`, `switchChain` to 84532, reads and simulation through an `http()` public client.

The backend's `ownerApproval` (`src/approvals/ownerApproval.js`) is built the same way on every `GET /requests/:id`:
`{ wallet, function: "executeBatch", price, standingAllowance, args: { dest: [usdc, merchant], value: [], func: [approveData, purchaseData] },
calls: [ { to: usdc, function: "approve", args: { spender: merchant, value: standing + price } },
{ to: merchant, function: "purchase", args: { credits, payment: price } } ], signWith, readAt }`.
If either chain read fails the whole call is `502 RPC_ERROR`. The frontend will rebuild `func` itself and refuse to sign
unless every byte, address and amount matches (plan Rule 5).

## 5. `POST /approvals/:id/verify` checks (`src/approvals/verify.js`)

| # | Check name | Passes when | Failure |
|---|---|---|---|
| — | input | `txHash` is `0x` + 64 hex | 400 `INVALID_INPUT` |
| 1 | `request_status` | request exists, status `needs_owner_approval` or `expired` | 404 `NOT_FOUND`, 409 `WRONG_STATUS` |
| 2 | `tx_unused` | no request already stores this hash (also enforced by `UNIQUE`) | 409 `TX_ALREADY_USED` |
| 3 | `receipt_success` | receipt and tx found, `status == success` | 422 `TX_NOT_FOUND`, 422 `TX_REVERTED` |
| 4 | `owner_authorized` | direct: `to == wallet`, `from == owner()`, calldata is `executeBatch`; or to the EntryPoint with every wallet `UserOperationEvent` on nonce key 0 and `success` | 422 `NOT_OWNER_TX` |
| 5 | `credits_purchased` | `CreditsPurchased` emitted by the merchant, `buyer == wallet`, `credits == request.credits` | 422 `NO_PURCHASE_EVENT`, 422 `CREDITS_MISMATCH` |
| 6 | `after_request` | block time ≥ `createdAt − 120 s` | 422 `TX_TOO_OLD` |

On failure nothing changes and `details.checks` lists every check with `ok` and a `detail` string (later checks show
"not checked"). On success the `checks` array has `name` and `ok` only. An RPC failure is 502 `RPC_ERROR`.
`TX_NOT_FOUND` right after sending usually means "not mined yet": the UI will wait for the receipt before calling verify.

## 6. CORS (`backend/src/server.js`)

`access-control-allow-origin` is exactly `FRONTEND_ORIGIN` (default `http://localhost:5173`), methods
`GET, POST, OPTIONS`, header `content-type`, and every `OPTIONS` gets 204. The backend listens on `127.0.0.1` only.
So the dev server must be opened at **`http://localhost:5173`**: not `127.0.0.1:5173`, not port 5174. The new
`vite.config.ts` sets `host: 'localhost'`, `port: 5173`, `strictPort: true`, so Vite stops with an error instead of
silently moving to 5174. The API URL itself stays `http://127.0.0.1:8787`.

## 7. `docs/PHASE11_INTEGRATION.md` §9 (frontend notes)

- Spending counter: show `spentToday` and `remainingDailyAllowance` exactly as returned; they reset at 00:00 UTC on
  their own, so no client-side reset. 6 decimals.
- Validity: use `isAgentValid(agent)` (`validNow`); `validUntil` is unix seconds.
- Results: for owner txs `receipt.status` is enough; for UserOps a mined `handleOps` is not success, read
  `UserOperationEvent.success` and decode `UserOperationRevertReason` (`readOpResult()` in `integration/lib.mjs`).
- Event feed: nonce key = `nonce >> 64` (agent address or 0 for owner), sequence = `nonce & (2^64 − 1)`.
  The backend's `/events` already provides `label`, `nonceKey` and `nonceSequence`.

## 8. Windows and dependency risks

| Risk | What to do |
|---|---|
| PowerShell blocks `npm.ps1` / `npx.ps1` ("running scripts is disabled") | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or call `npm.cmd` |
| `npm create vite@latest` now gives create-vite 9 (Vite 8 with Rolldown, React 19, TypeScript ~6.0, oxlint instead of ESLint) and asks "Install with npm and start now?" | Pin `create-vite@9.3.1` and pass `--no-interactive`; tested: `tsc -b` and `vite build` are clean with viem 2.57.11 |
| Node: Vite 8 and plugin-react 6 need ^20.19 or ≥22.12, Vitest 5 needs ≥22.12, the backend needs ≥22.13 | One Node 22.13+ for everything (`node -v`) |
| Build warning `Module "node:worker_threads" has been externalized` from `ox` (viem dependency) | Harmless, unused code path in the browser |
| Port 5173 busy (an old dev server) | `strictPort` makes Vite fail loudly; close the other window. Never accept 5174 |
| `VITE_API_URL=http://localhost:8787` may resolve to IPv6 `::1`, but the backend listens on IPv4 `127.0.0.1` | Keep `http://127.0.0.1:8787` |
| Several wallet extensions fight over `window.ethereum` | Use a testnet-only browser profile with only MetaMask |
| Project folder inside OneDrive, or Defender scanning `node_modules` | Slow installs and file locks; keep `agent-wallet` outside OneDrive |
| JSON ABIs lose viem's type inference | Cast to `Abi`, explicit return types (Phase 3) |
| Missing `31337.json` | Load deployments with `import.meta.glob` |

## 9. Setup plan (for your approval)

1. **Scaffold** `frontend/` with create-vite 9.3.1 (React + TS) and install `viem@2.57.11` exactly.
2. **Paste this zip** over it: `vite.config.ts` (port, origin, fs.allow), `.env.example`, `scripts/check-setup.mjs`, this report.
3. **Run the checks** in Step 4 on your PC and the browser wallet check.
4. **No other packages** now. Vitest (+ jsdom) arrives in Phase 3 with the first tests; no wagmi, no router, no state
   library, no UI kit unless a later phase shows a need.
5. **Then Phase 2:** `frontend/docs/UI_SPEC.md` (screens, TypeScript types for every response, status table, error messages,
   polling), still no UI code.

### Step 4: commands to run (PowerShell)

```powershell
# window 1: backend, leave running
cd agent-wallet\backend
npm start

# window 2
cd agent-wallet
Invoke-RestMethod http://127.0.0.1:8787/health
(Invoke-RestMethod http://127.0.0.1:8787/wallet/status).agent | Format-List validNow, maxPerTx, spentToday

npm create vite@9.3.1 frontend -- --template react-ts --no-interactive
cd frontend
npm install
npm install viem@2.57.11 --save-exact
# now unzip agent-wallet-p3-phase1-changes.zip into agent-wallet\ (overwrite frontend\vite.config.ts)
Copy-Item .env.example .env
node scripts\check-setup.mjs      # all PASS
npm run dev                       # open http://localhost:5173 (not 127.0.0.1)
```

If `validNow` is false, rerun ConfigureAgent as in `docs/PHASE12_FINAL.md` §8.

**Browser wallet check.** On `http://localhost:5173`, open DevTools (F12) → Console and run:

```js
await ethereum.request({ method: 'eth_chainId' })        // '0x14a34' = 84532 Base Sepolia
await ethereum.request({ method: 'eth_requestAccounts' }) // ['0x815d211d2e85e2c2526f0cc3bb1dee11513c7b64']
```

If you chose not to import the owner key, skip the second line: the approval page will accept a tx hash from
`script/OwnerApprovePurchase.s.sol` instead.

### Acceptance (from the plan)

- [ ] `GET /health` → `ok: true`, `chainId: 84532`
- [ ] `GET /wallet/status` → `validNow: true`
- [ ] `check-setup.mjs` all PASS (viem 2.57.11 in frontend, backend and integration; addresses match; CORS allows `http://localhost:5173`)
- [ ] Vite starter page at `http://localhost:5173`
- [ ] Wallet on `0x14a34` with owner `0x815d…7b64`, or tx-hash fallback chosen
