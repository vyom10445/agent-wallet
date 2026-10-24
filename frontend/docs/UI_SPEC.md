# Frontend UI spec (P-3 Phase 2, FROZEN)

**Status: frozen 2026-10-24.** This is a design only; nothing here is implemented yet. It is built against
`backend/docs/BACKEND_API.md` v1 plus the additive fields in `backend/docs/BACKEND_FINAL.md` §3, and uses no endpoint,
field or value that is not in those files. On-chain reads use only names in `abi/`. A change after the freeze is listed
in the changelog at the end.

---

## 0. Rules the UI follows

1. **`needs_owner_approval` is not an approval.** It means "nothing was bought; waiting for the owner to sign on chain".
   The UI never shows it as approved, paid or done, and never uses the words "approved" for it.
2. **Paid means `proofVerified === true`.** A request is shown as paid only when its status is `succeeded` or
   `fulfilled_by_owner` **and** `proofVerified === true`. `false` shows a red "proof does not hold" warning; `null` or a
   missing field shows a grey "could not check the chain". A mined tx alone is never shown as success.
3. **Amounts stay `Amount` objects.** Display `mUSDC` exactly as given (plus " mUSDC"); compare and compute with
   `BigInt(base)`. No JavaScript floats for amounts, ever. Wei is formatted from its string with viem `formatEther`.
4. **All backend and chain text is untrusted.** `reply`, `content`, `reason`, `error.message`, `args.reason`, `detail`
   and tool-call args are rendered as plain text (React text nodes), never as HTML or Markdown. Long text wraps; nothing
   in it becomes a link except values the UI builds itself (BaseScan links from a validated tx hash, request ids matching
   `^req_[0-9a-f]{16}$`).
5. **The owner signs only what the UI rebuilt and decoded itself** (§2.4). Any mismatch with `ownerApproval` blocks signing.
6. **No keys.** The UI never asks for, stores or logs a private key. The owner signs in the injected wallet.
7. **Times:** unix seconds shown as local time with the UTC time in a tooltip (`validUntilIso` shown as given).

## 1. Layout

One page, a header and five tabs. The header is always visible; tabs keep their own state when switching.

```
┌ Header: app name · backend status dot · chain (84532 Base Sepolia / 31337 Anvil) · planner llm|fallback ·
│         wallet 0x74cD…5c1A (copy, BaseScan) · Connect wallet / 0x815d…7b64 (owner ✓ | not owner ✗ | wrong network)
├ Banners: startup errors (§1.1), then every /wallet/status warning
├ Tabs: Dashboard | Chat | Requests (badge = count of needs_owner_approval) | Approve | Activity
└ Footer: "The contract is the only authority. Limits are enforced on chain." · indexedToBlock · last refresh time
```

### 1.1 Startup checks (blocking)

On load: `GET /health`, then `GET /wallet/status`, then compare with `contracts/deployments/<chainId>.json` loaded at build
time (`import.meta.glob`).

| Check | On failure |
|---|---|
| `/health` reachable | Full-page "Backend not reachable at `VITE_API_URL`. Start it with `npm start` in `backend/`." with a Retry button; retry every 5 s |
| `ok === true`, `apiVersion === "1"` | Blocking error "Backend API version X is not supported (expected 1)" |
| deployment file exists for `chainId` | Blocking error "No address book for chain X" |
| `/health.wallet` and `/wallet/status.addresses.{wallet, owner, entryPoint, usdc, merchant}` equal the file (case-insensitive) | Blocking red banner "Backend and address book disagree: <field>". The Approve tab is disabled; read-only tabs still work |
| `/health.agent === /wallet/status.addresses.agent` | Same as above |
| `/health.events.lastError` not null | Yellow banner "Event indexer error: <text>" (Activity may be stale) |

## 2. Screens

### 2.1 Dashboard (`GET /wallet/status`)

Cards, each value with its source field:

| Card | Fields shown |
|---|---|
| Agent | `addresses.agent` (short, copy); **Active** `agent.active`; **Valid now** `agent.validNow` (green Yes / red No); valid from `agent.validAfter`; **valid until** `agent.validUntil` / `validUntilIso` with "in 3 d 4 h" or "expired"; can buy `agent.canPurchase`; merchant allowed `agent.merchantAllowed` |
| Limits | `agent.maxPerTx` per purchase; `agent.dailyLimit` per UTC day; `agent.spentToday`; `agent.remainingDailyAllowance`; **bar** = `spentToday.base / dailyLimit.base` computed with BigInt to a whole percent (0 when dailyLimit is 0), label "resets 00:00 UTC" (no client reset, PHASE11 §9) |
| Wallet | `wallet.balance` mUSDC; `wallet.merchantAllowance`; `wallet.credits` credits owned; `wallet.entryPointDeposit` as ETH |
| Merchant | `merchant.pricePerCredit` per credit; `merchant.purchaseCount` purchases |
| Gas payer | `submitter.address` (short); `submitter.ethBalance` as ETH |
| Footer | `chainId`, `blockNumber`, `readAt` ("read 12 s ago") |

Warning banners (one per `warnings[]` value, in this order; an unknown value shows as its raw code in a grey banner):

| Warning | Colour | Text |
|---|---|---|
| `AGENT_NOT_VALID` | red | The agent is not valid now (expired, not started or revoked). It cannot buy anything until the owner renews it. |
| `AGENT_EXPIRES_SOON` | yellow | The agent's permission ends in under 24 hours (at `validUntilIso`). |
| `DEPOSIT_LOW` | yellow | The wallet's EntryPoint gas deposit is low. Agent purchases may fail with AA21 until it is topped up. |
| `ALLOWANCE_LOW` | yellow | The merchant allowance is below one maximum purchase. Larger purchases will need the owner. |
| `BALANCE_LOW` | yellow | The wallet's mUSDC balance is below one maximum purchase. |
| `SUBMITTER_LOW` | red | The backend's gas payer is low on ETH. The agent cannot send purchases until it is funded. |

Errors: `502 RPC_ERROR` keeps the last good values greyed out with "Chain read failed, showing values from <time>".

### 2.2 Chat (`GET /agent/messages`, `POST /agent/chat`)

- `conversationId` is always `"default"` (one conversation; the field is sent explicitly).
- On open: `GET /agent/messages?conversationId=default&limit=200`, shown oldest first. `role: "user"` right-aligned,
  `"assistant"` left-aligned, `createdAt` as time. A message with `requestId` shows a request chip (§2.6).
- Input: textarea, trimmed length 1 to 2000 with a live counter; Enter sends, Shift+Enter is a new line.
- **One turn at a time:** while a `POST /agent/chat` is in flight the Send button and Enter are disabled and a
  "Agent is working (can take up to a minute while a purchase is mined)" indicator shows. The user's text appears at once
  as a pending bubble.
- On `200`: show `reply` (plain text), a small `planner` badge (`llm` / `fallback`, fallback with tooltip "deterministic
  planner, no LLM"), a collapsible **Tool calls** list (`name`, `args` as JSON text, `result.requestId` and
  `result.status` as a chip, any other result as JSON text), and one request chip per `requestIds[]` entry. Then reload
  the history (the server copy replaces the pending bubble), the dashboard and the requests list.
- Request chips use the status label and colour from §3, so a `needs_owner_approval` chip reads "Needs your signature"
  and links to the Approve tab, never "Approved".
- Errors: `400 INVALID_INPUT` keeps the text in the box and shows the message (also covers "contains a backend key");
  `409 BUSY` shows "The agent is still busy with the previous message. Try again in a moment." and keeps the text;
  `502 LLM_ERROR` keeps the text; network failure keeps the text.
- Example prompts under the box (fill the input only, never auto-send): "status", "price of 50 credits",
  "buy 50 API credits", "buy 150 API credits", "show my requests".

### 2.3 Requests (`GET /requests`, `GET /requests/:id`)

**List** (`GET /requests?limit=50[&status=…][&before=…]`):

- Filter chips: All, Needs your signature (`needs_owner_approval`), In progress (`received,submitted`), Paid
  (`succeeded,fulfilled_by_owner`), Failed (`precheck_failed,failed_onchain`), Closed (`rejected,expired`). Sent as a
  comma-separated `status`.
- Columns: created (`createdAt`), status badge (§3, paid badge only when `proofVerified === true`), credits,
  price (`price.mUSDC` or "—"), paid (`amountPaid.mUSDC` or "—"), path (`agent` / `owner` / "—"), precheck,
  error code (`error.code`), tx (short `txHash` linking to `explorerUrl` when not null).
- Paging: "Older" sends `before = createdAt of the last row`; "Newest" clears it. Stop when fewer than `limit` rows came back.
- Row click opens the detail panel.

**Detail** (`GET /requests/:id`): every `PurchaseRequest` field, grouped:

- Summary: id (copy), status label + explanation (§3), credits, `reason` (plain text, labelled "Agent's reason
  (unverified)"), price, amountPaid, purchaseId, path, precheck.
- Chain: txHash + `explorerUrl`, blockNumber, userOpHash, nonce, actualGasCost (ETH), agent.
- Proof (paid statuses): `proofVerified` badge (§0.2) and, when present, the `proofChecks` list (`name`, ✓/✗, `detail`).
- Error: `error.code`, readable text (§4.2), raw `error.message` in monospace.
- Times: createdAt, updatedAt, expiresAt (owner path: "expires in …" / "expired at …").
- If `ownerApproval` is present: an "Open in Approve" button.
- `404 NOT_FOUND` shows "No such request"; `502 RPC_ERROR` shows "Chain read failed, try again" with no stale data.

### 2.4 Approve (owner, for `needs_owner_approval` or `expired`)

Left: the waiting requests (`GET /requests?status=needs_owner_approval,expired`). Right: the selected one, loaded with
`GET /requests/:id`. The page states at the top: **"Nothing has been bought. The agent asked for a purchase above its
limits. Only your signature on chain can buy it."**

1. **What the agent asked:** credits, `reason` (unverified), `createdAt`, `expiresAt`, precheck (`NEEDS_OWNER` "above the
   agent's limits" / `NEEDS_OWNER_TOPUP` "the merchant allowance or wallet balance is too low for the agent").
   For `expired`: "This request expired. You can still sign; the backend will accept a valid purchase."
2. **What you will sign** (from `ownerApproval`, then re-checked): target `ownerApproval.wallet`,
   function `executeBatch`, and the two decoded calls:
   - `mUSDC.approve(merchant, value)` showing `calls[0].args.value.mUSDC` = standing `standingAllowance.mUSDC` + price
   - `merchant.purchase(credits, payment)` showing `calls[1].args.credits` and `calls[1].args.payment.mUSDC`
   - "After this, the merchant allowance returns to `standingAllowance.mUSDC`. The agent's limits and spentToday do not change."
   - `readAt` ("prices read 8 s ago").
3. **Max price** field (mUSDC, decimal text, parsed with viem `parseUnits(x, 6)`, default = the price). Signing is disabled
   when `price.base > max`, with "The current price is above your maximum".
4. **Independent rebuild (Rule 5), right before the wallet opens:** the browser reads `merchant.quote(credits)` and
   `usdc.allowance(wallet, merchant)` from its own public RPC client, encodes
   `func = [approve(merchant, standing + price), purchase(credits, price)]`, and requires all of:
   `ownerApproval.wallet == deployments.wallet`; `args.dest == [deployments.usdc, deployments.merchant]`;
   `args.value` is `[]`; `args.func[i]` equals the rebuilt `func[i]` (lowercase hex compare); decoding each `func[i]` gives
   `approve`/`purchase` with the shown values; `price.base` and `standingAllowance.base` equal the fresh reads;
   `calls[1].args.credits == request.credits`. Any difference: **refuse to sign** and show
   "The approval data changed or does not match the chain: <field>. Reload and check again." Only the rebuilt values are sent.
5. **Connect wallet:** `eth_requestAccounts` through `window.ethereum`. Shows the account and these blocks:
   no `window.ethereum` "No browser wallet found; use the tx-hash option below"; chain id ≠ backend `chainId` "Switch to
   Base Sepolia" button (`wallet_switchEthereumChain`, then `wallet_addEthereumChain` for 84532 if unknown); account ≠
   on-chain `AgentWallet.owner()` "This account is not the wallet owner (owner is 0x815d…7b64)". Sign stays disabled
   until all three pass.
6. **Sign:** simulate `executeBatch(dest, [], func)` with the owner as account (show the decoded revert on failure, using
   `docs/PHASE11_DEBUGGING.md` wording), then `writeContract` through the injected wallet. Show the tx hash at once with a
   BaseScan link, then "Waiting for the block…" until the receipt. `receipt.status !== "success"` shows "Your transaction
   reverted" and does not call verify. Wallet rejection (user denied) shows "You cancelled in the wallet. Nothing was sent."
7. **Verify:** `POST /approvals/:id/verify { txHash }` automatically after a successful receipt. On `200`, show
   "Bought with your approval" with `request.amountPaid`, `purchaseId`, and the `checks` list. On failure show the code's
   text (§4.1) and every `details.checks` entry with ✓/✗ and `detail`, plus a Retry button (for `TX_NOT_FOUND` retry
   automatically every 5 s, up to 60 s).
8. **Tx-hash fallback** (always visible, collapsed): "Signed elsewhere (OwnerApprovePurchase.s.sol or
   integration/owner-approve.mjs)? Paste the tx hash." Input validated as `^0x[0-9a-fA-F]{64}$`, then step 7.
9. **Decline:** for `needs_owner_approval` only, a "Decline" button with an optional note (max 200 chars) and a confirm
   dialog "This only marks the request as declined. It moves no funds and changes nothing on chain."
   → `POST /approvals/:id/reject { note }`.

### 2.5 Activity (`GET /events`)

- Type filter (multi-select of the 7 types), sent as comma-separated `type`; `limit=50`; "Older" sends
  `before = blockNumber of the last row`.
- Row: time (`timestamp`), block, type, `label` badge (agent blue, owner purple, other grey), one-line summary,
  request chip when `requestId` is set, BaseScan link built from `txHash` (84532 only; on 31337 show the hash only).
- Summaries (all values from `args`):

| Type | Summary |
|---|---|
| `CreditsPurchased` | Purchase #`purchaseId`: `credits` credits for `amountPaid.mUSDC` mUSDC |
| `AgentSpent` | Agent spent `amount.mUSDC` mUSDC to `recipient` (today `spentToday.mUSDC`) |
| `AgentExecuted` | Agent called `selector` on `target` |
| `AgentRevoked` | Agent `agent` revoked |
| `PolicySet` | Policy for `agent`: max `maxPerTx.mUSDC` per tx, `dailyLimit.mUSDC` per day |
| `UserOperationEvent` | UserOp #`nonceSequence` `success ? "succeeded" : "FAILED"`, gas `actualGasCost` wei |
| `UserOperationRevertReason` | UserOp #`nonceSequence` reverted: `reason` (or "undecodable" when null) |

- Header line: "Indexed to block `indexedToBlock`".

### 2.6 Shared pieces

- **Request chip:** `req_…` short id + status label/colour (§3) → opens the Requests detail (or Approve when the status is
  `needs_owner_approval` / `expired`).
- **Address:** first 6 + last 4 chars, copy button, BaseScan address link on 84532.
- **Amount:** `"<mUSDC> mUSDC"`; tooltip with `base` units.
- **Error box:** readable text (§4) + the raw code in monospace.

## 3. Status table

| Status | Label | Colour | Shown as paid? | Next action |
|---|---|---|---|---|
| `received` | Checking | grey | No | Wait (poll) |
| `precheck_failed` | Not sent | orange | No | Show `error.code` and its text; nothing was sent |
| `submitted` | Sent, waiting for the chain | blue | No | Poll `GET /requests/:id` |
| `succeeded` | Bought by agent | green | Only if `proofVerified === true` | BaseScan link |
| `failed_onchain` | Failed on chain | red | No | Show the decoded revert (`error`) |
| `needs_owner_approval` | Needs your signature | purple | **No (not an approval)** | Open Approve |
| `fulfilled_by_owner` | Bought with owner approval | green | Only if `proofVerified === true` | BaseScan link |
| `rejected` | Declined by you | grey | No | None |
| `expired` | Expired | grey | No | The owner may still sign; verify accepts it |

For `succeeded` / `fulfilled_by_owner`: `proofVerified === false` → red badge "Proof does not hold" with the text "The
database says paid, but the chain does not confirm it. Treat as not paid."; `null` or missing → grey "Could not check the
chain". The green badge needs `true`.

Pre-check labels: `AGENT_OK` "Within the agent's limits", `NEEDS_OWNER` "Above the agent's limits",
`NEEDS_OWNER_TOPUP` "Allowance or balance too low for the agent", `BLOCKED` "Blocked by policy", `null` "—".

## 4. Error messages

The client maps by `error.code`; the HTTP status only picks the fallback. The backend's `message` is shown under the text
as plain text.

### 4.1 HTTP error codes

| HTTP | Code | Text shown |
|---|---|---|
| — | (network) | Backend not reachable at `VITE_API_URL`. Is `npm start` running in `backend/`? |
| — | (CORS) | Seen as a network error: open the app at http://localhost:5173 exactly. |
| 400 / 405 | `INVALID_INPUT` | The request was not accepted: `<message>` |
| 404 | `NOT_FOUND` | No such request (or endpoint). |
| 409 | `WRONG_STATUS` | This request can't do that in its current status (`<message>`). Reload it. |
| 409 | `BUSY` | The agent is still working on the previous message. Try again in a moment. |
| 409 | `TX_ALREADY_USED` | That transaction already proved another request. Each purchase can fulfil only one request. |
| 422 | `TX_NOT_FOUND` | Transaction not found on this network yet. Check the hash and network, or wait for it to be mined. |
| 422 | `TX_REVERTED` | That transaction reverted, so nothing was bought. |
| 422 | `NOT_OWNER_TX` | That transaction was not the wallet owner calling executeBatch. |
| 422 | `NO_PURCHASE_EVENT` | That transaction did not buy credits for this wallet. |
| 422 | `CREDITS_MISMATCH` | That transaction bought a different number of credits than this request. |
| 422 | `TX_TOO_OLD` | That transaction is older than this request, so it can't fulfil it. |
| 502 | `RPC_ERROR` | The backend could not read the chain. Try again in a few seconds. |
| 502 | `LLM_ERROR` | The agent could not answer (LLM and fallback both failed). Try again. |
| 500 | `INTERNAL` | The backend hit an internal error. Check the backend window. |
| other | unknown | Unexpected response (HTTP `<status>`). |

### 4.2 Stored `error.code` on a request

| Code | Text shown |
|---|---|
| `AA21` | The wallet's gas deposit is too low to pay for the agent's operation. |
| `AA22` | The agent's operation was outside its time window (expired or not yet valid). |
| `AA23` | The wallet rejected the agent's operation during validation. |
| `AA24` | The signature did not match an authorised signer. |
| `AA25` | Nonce conflict: another operation was in flight. Try again. |
| `AA95` | The operation ran out of gas. |
| `ExceedsPerTxLimit` | Above the agent's per-purchase limit. |
| `ExceedsDailyLimit` | Above what the agent may still spend today. |
| `RecipientNotAllowed` | The merchant is not an allowed recipient for this agent. |
| `CallNotAllowed` | The agent is not allowed to call this function. |
| `AgentNotValid` | The agent is not valid (expired, not started or revoked). |
| `NativeValueNotAllowed` | The agent may not send ETH. |
| `InvalidTokenCall` | The token call was not a valid transfer or approval. |
| `UnauthorizedCaller` | The call did not come from the EntryPoint or the owner. |
| `IncorrectPayment` | The payment did not match the merchant's price (the price may have changed). |
| `ZeroCredits` | Zero credits can't be bought. |
| `SafeERC20FailedOperation` | The mUSDC transfer to the merchant failed. |
| `ERC20InsufficientAllowance` | The merchant allowance is too low. |
| `ERC20InsufficientBalance` | The wallet does not have enough mUSDC. |
| `PRECHECK_BLOCKED` | Blocked by the agent's policy before sending (see the message). |
| `SUBMITTER_LOW` | The backend's gas payer is out of ETH. Nothing was sent. |
| `NO_PURCHASE_EVENT` | The operation ran but no purchase was recorded, so it counts as failed. |
| `CHAIN_MISMATCH` | The backend's chain did not match the expected network. Nothing was sent. |
| `UNKNOWN` | The transaction failed with an undecodable reason (raw data below). |
| other | Shown as the raw code. |

The exact AAxx wording comes from `error.message` (for example `AA21 didn't pay prefund`); the text above is the plain
explanation next to it.

## 5. Polling

All polling pauses while the browser tab is hidden (`document.visibilityState`) and resumes with an immediate fetch.
A poll never overlaps the previous one for the same endpoint. Failures back off (×2 up to 60 s) and recover on success.

| What | Endpoint | Interval | Notes |
|---|---|---|---|
| Header health | `GET /health` | 30 s | 5 s while unreachable |
| Dashboard | `GET /wallet/status` | 15 s while the Dashboard tab is open, 60 s otherwise (for the header and banners) | ~15 fresh chain reads per call, so not faster; also refetched after each chat turn and after verify |
| Chat history | `GET /agent/messages` | none | Loaded on open and after each turn |
| Requests list | `GET /requests` | 10 s while open; 3 s while any listed row is `received` or `submitted` | Newest page only; older pages are not polled |
| Request detail | `GET /requests/:id` | 3 s while `received` or `submitted`; otherwise none | |
| Approve | `GET /requests/:id` | none automatically; on select, on "Reload", and right before signing (step 4) | `ownerApproval` is rebuilt from chain on every call |
| Approve list / tab badge | `GET /requests?status=needs_owner_approval,expired&limit=50` | 15 s | |
| Activity | `GET /events` | 10 s while open | The indexer polls every 4 s by default |
| Owner tx receipt | public client `waitForTransactionReceipt` | viem default | Then verify once; `TX_NOT_FOUND` retries every 5 s up to 60 s |

## 6. TypeScript types (`BACKEND_API.md` v1 + `BACKEND_FINAL.md` §3)

Phase 3 copies these into `src/api/types.ts`. Optional (`?`) marks the additive fields and fields present only in some
responses.

```ts
export type Amount = { base: string; mUSDC: string }
export type Wei = string
export type Address = `0x${string}`
export type Hash = `0x${string}`

export type Status =
  | 'received' | 'precheck_failed' | 'submitted' | 'succeeded' | 'failed_onchain'
  | 'needs_owner_approval' | 'fulfilled_by_owner' | 'rejected' | 'expired'
export type Precheck = 'AGENT_OK' | 'NEEDS_OWNER' | 'NEEDS_OWNER_TOPUP' | 'BLOCKED'

export type HttpErrorCode =
  | 'INVALID_INPUT' | 'NOT_FOUND' | 'WRONG_STATUS' | 'BUSY' | 'TX_ALREADY_USED'
  | 'TX_NOT_FOUND' | 'TX_REVERTED' | 'NOT_OWNER_TX' | 'NO_PURCHASE_EVENT' | 'CREDITS_MISMATCH' | 'TX_TOO_OLD'
  | 'RPC_ERROR' | 'LLM_ERROR' | 'INTERNAL'
export type RequestErrorCode =
  | 'AA21' | 'AA22' | 'AA23' | 'AA24' | 'AA25' | 'AA95'
  | 'ExceedsPerTxLimit' | 'ExceedsDailyLimit' | 'RecipientNotAllowed' | 'CallNotAllowed' | 'AgentNotValid'
  | 'NativeValueNotAllowed' | 'InvalidTokenCall' | 'UnauthorizedCaller'
  | 'IncorrectPayment' | 'ZeroCredits' | 'SafeERC20FailedOperation'
  | 'ERC20InsufficientAllowance' | 'ERC20InsufficientBalance'
  | 'PRECHECK_BLOCKED' | 'SUBMITTER_LOW' | 'NO_PURCHASE_EVENT' | 'CHAIN_MISMATCH' | 'UNKNOWN'

export type VerifyCheckName =
  | 'request_status' | 'tx_unused' | 'receipt_success' | 'owner_authorized' | 'credits_purchased' | 'after_request'
export type Check = { name: string; ok: boolean; detail?: string }

// details.checks is present on verify failures
export type ErrorBody = { error: { code: HttpErrorCode | string; message: string; details?: { checks?: Check[] } & Record<string, unknown> } }

// 4.1
export type Health = {
  ok: boolean; apiVersion: string; chainId: number; wallet: Address; agent: Address
  llm: 'available' | 'fallback'; dbPath: string
  events?: { indexedToBlock: number | null; lastError: string | null; polling: boolean }  // additive (Phase 10)
}

// 4.2
export type ChatRequest = { message: string; conversationId?: string }
export type ToolCall = {
  name: 'get_wallet_status' | 'quote_credits' | 'buy_credits' | 'list_requests'
  args: Record<string, unknown>
  result: { requestId?: string; status?: Status } & Record<string, unknown>
}
export type ChatResponse = {
  conversationId: string; reply: string; requestIds: string[]; toolCalls: ToolCall[]; planner: 'llm' | 'fallback'
}

// 4.3
export type ChatMessage = { id: number; role: 'user' | 'assistant'; content: string; requestId: string | null; createdAt: number }
export type MessagesResponse = { conversationId: string; messages: ChatMessage[] }

// 4.4 / 4.5
export type OwnerApproval = {
  wallet: Address
  function: 'executeBatch'
  price: Amount
  standingAllowance: Amount
  args: { dest: [Address, Address]; value: []; func: [Hash, Hash] }
  calls: [
    { to: Address; function: 'approve'; args: { spender: Address; value: Amount } },
    { to: Address; function: 'purchase'; args: { credits: number; payment: Amount } },
  ]
  signWith: string
  readAt: number
}
export type PurchaseRequest = {
  id: string
  status: Status
  path: 'agent' | 'owner' | null
  precheck: Precheck | null
  credits: number
  reason: string | null                 // untrusted
  price: Amount | null
  amountPaid: Amount | null
  purchaseId: string | null
  agent: Address
  nonce: string | null
  userOpHash: Hash | null
  txHash: Hash | null
  blockNumber: number | null
  actualGasCost: Wei | null
  error: { code: RequestErrorCode | string; message: string | null } | null
  explorerUrl: string | null            // null on Anvil
  conversationId: string | null
  expiresAt: number | null
  createdAt: number
  updatedAt: number
  ownerApproval?: OwnerApproval         // GET /requests/:id, needs_owner_approval or expired only
  proofVerified?: boolean | null        // additive (Phase 9): paid statuses only
  proofChecks?: Check[]                 // additive (Phase 9): GET /requests/:id only, when freshly checked
}
export type RequestsQuery = { status?: Status[]; limit?: number; before?: number }
export type RequestsResponse = { requests: PurchaseRequest[] }

// 4.6
export type VerifyRequest = { txHash: Hash }
export type VerifyResponse = {
  request: Pick<PurchaseRequest, 'id' | 'status' | 'txHash' | 'purchaseId' | 'amountPaid'> & Partial<PurchaseRequest>
  checks: { name: VerifyCheckName; ok: boolean }[]
}

// 4.7
export type RejectRequest = { note?: string }
export type RejectResponse = { request: PurchaseRequest }

// 4.8
export type Warning = 'AGENT_NOT_VALID' | 'AGENT_EXPIRES_SOON' | 'DEPOSIT_LOW' | 'ALLOWANCE_LOW' | 'BALANCE_LOW' | 'SUBMITTER_LOW'
export type WalletStatus = {
  chainId: number; blockNumber: number; readAt: number
  addresses: { wallet: Address; owner: Address; entryPoint: Address; usdc: Address; merchant: Address; agent: Address }
  agent: {
    active: boolean; validNow: boolean
    validAfter: number; validUntil: number; validUntilIso: string
    token: Address
    maxPerTx: Amount; dailyLimit: Amount; spentToday: Amount; remainingDailyAllowance: Amount
    canPurchase: boolean; merchantAllowed: boolean
    nonceKey: string; nextNonce: string
  }
  wallet: { balance: Amount; merchantAllowance: Amount; entryPointDeposit: Wei; credits: number }
  merchant: { pricePerCredit: Amount; purchaseCount: number }
  submitter: { address: Address; ethBalance: Wei }
  warnings: (Warning | string)[]
}

// 4.9
export type EventType =
  | 'AgentSpent' | 'AgentExecuted' | 'AgentRevoked' | 'PolicySet'
  | 'CreditsPurchased' | 'UserOperationEvent' | 'UserOperationRevertReason'
type EventBase<T extends EventType, A> = {
  type: T; emitter: 'wallet' | 'merchant' | 'entryPoint'
  blockNumber: number; timestamp: number | null; txHash: Hash; logIndex: number
  label: 'agent' | 'owner' | 'other'; requestId: string | null
  args: A
}
export type ChainEvent =
  | EventBase<'AgentSpent', { agent: Address; token: Address; recipient: Address; amount: Amount; spentToday: Amount }>
  | EventBase<'AgentExecuted', { agent: Address; target: Address; selector: string; value: string }>
  | EventBase<'AgentRevoked', { agent: Address }>
  | EventBase<'PolicySet', { agent: Address; token: Address; maxPerTx: Amount; dailyLimit: Amount }>
  | EventBase<'CreditsPurchased', { purchaseId: string; buyer: Address; credits: string; amountPaid: Amount }>
  | EventBase<'UserOperationEvent', { userOpHash: Hash; sender: Address; paymaster: Address; nonce: string; nonceKey: string;
      nonceSequence: string; success: boolean; actualGasCost: string; actualGasUsed: string }>
  | EventBase<'UserOperationRevertReason', { userOpHash: Hash; sender: Address; nonce: string; nonceKey: string;
      nonceSequence: string; revertReason: string; reason: string | null }>
export type EventsQuery = { type?: EventType[]; limit?: number; before?: number }
export type EventsResponse = { fromBlock: number | null; toBlock: number | null; indexedToBlock: number | null; events: ChainEvent[] }
```

Notes on the types:
- `nonceSequence` and `reason` on UserOp events and `events` in `/health` are the additive fields from `BACKEND_FINAL.md` §3.
- Event `args` keys are the ABI event parameter names in `abi/`; uint256 values are decimal strings, and the token
  amounts (`amount`, `spentToday`, `amountPaid`, `maxPerTx`, `dailyLimit`) are `Amount`.
- Code fields keep `| string` so an unknown future code is shown raw instead of breaking the page.

## 7. Endpoint coverage

| Endpoint | Used by |
|---|---|
| `GET /health` | Header, startup checks (§1.1) |
| `POST /agent/chat` | Chat |
| `GET /agent/messages` | Chat |
| `GET /requests` | Requests list, Approve list, tab badge |
| `GET /requests/:id` | Request detail, Approve |
| `POST /approvals/:id/verify` | Approve (after signing, or the tx-hash fallback) |
| `POST /approvals/:id/reject` | Approve (Decline) |
| `GET /wallet/status` | Dashboard, header, banners, startup checks |
| `GET /events` | Activity |

On-chain reads from the browser (public client, not the wallet): `AgentWallet.owner()`, `MockMerchant.quote(credits)`,
`MockUSDC.allowance(wallet, merchant)`; simulation and write of `AgentWallet.executeBatch`; `waitForTransactionReceipt`.
All exist in `abi/`.

## Changelog

- v1 (2026-10-24): first frozen version.
