# Phase 9: owner approval of an over-limit request

A request above the agent's on-chain limits becomes `needs_owner_approval`. The backend never signs it. The owner
signs `wallet.executeBatch` from their own wallet, then hands the tx hash to the backend, which checks it on chain:

| # | Check (`details.checks[].name`) | Fails with |
|---|---|---|
| 1 | `request_status`: request is `needs_owner_approval` or `expired` | 404 `NOT_FOUND`, 409 `WRONG_STATUS` |
| 2 | `tx_unused`: no request already stores this tx hash | 409 `TX_ALREADY_USED` |
| 3 | `receipt_success`: mined, status success | 422 `TX_NOT_FOUND`, `TX_REVERTED` |
| 4 | `owner_authorized`: direct tx `to == wallet`, `from == owner()`, `executeBatch`; or a UserOp on nonce key 0 with `success` | 422 `NOT_OWNER_TX` |
| 5 | `credits_purchased`: `CreditsPurchased` from the merchant, `buyer == wallet`, the request's credits | 422 `NO_PURCHASE_EVENT`, `CREDITS_MISMATCH` |
| 6 | `after_request`: block time not before the request (120 s clock-skew allowance) | 422 `TX_TOO_OLD` |

Nothing is written unless all six pass. A database row alone never counts as paid: `GET /requests`, `GET /requests/:id`
and the agent's `list_requests` re-check every `succeeded` / `fulfilled_by_owner` row on chain and show
`proofVerified: false` for a row that was edited by hand. The server also logs such rows at start-up.

`APPROVAL_TTL_SECONDS` (default 86400, 60 to 2592000) sets when a request expires. An expired request can still be
verified: if the owner already paid, the chain wins. A rejected one cannot.

## Step 9.2: live check on Base Sepolia (PowerShell)

Uses the same `backend\.env` as H12 (`LLM_PROVIDER=none` is fine). The owner key stays in your Foundry keystore
(`--account deployer`); it is never in `backend\.env`.

**Window 1**: the backend.

```powershell
cd agent-wallet\backend
npm start
```

**Window 2**: the request.

```powershell
cd agent-wallet\backend
$api = "http://127.0.0.1:8787"
$before = Invoke-RestMethod "$api/wallet/status"
"spentToday $($before.agent.spentToday.mUSDC)  credits $($before.wallet.credits)"

$chat = Invoke-RestMethod -Method Post -Uri "$api/agent/chat" -ContentType application/json -Body '{"message":"buy 150 credits"}'
$chat.reply
$id = $chat.requestIds[0]
$req = Invoke-RestMethod "$api/requests/$id"
$req.status                                    # needs_owner_approval
$req.txHash                                    # empty: nothing was sent
$req.ownerApproval.price                       # base 1500000, mUSDC 1.5 (quote read now)
$req.ownerApproval.calls | ConvertTo-Json -Depth 5
```

**Window 2**: the owner signs (Foundry keystore, prompts for the keystore password).

```powershell
cd ..\contracts
$D = cast wallet address --account deployer     # must be the wallet owner 0x815d…7b64
$env:APPROVE_CREDITS = "150"
$env:APPROVE_MAX_PRICE = "1500000"
forge script script/OwnerApprovePurchase.s.sol --rpc-url base_sepolia --account deployer --sender $D
# review the printed price, allowance and owner, then send:
forge script script/OwnerApprovePurchase.s.sol --rpc-url base_sepolia --account deployer --sender $D --broadcast --slow
$tx = (Get-Content broadcast\OwnerApprovePurchase.s.sol\84532\run-latest.json | ConvertFrom-Json).transactions[0].hash
$tx
Remove-Item Env:APPROVE_CREDITS, Env:APPROVE_MAX_PRICE
cd ..\backend
```

**Window 2**: verify.

```powershell
$body = @{ txHash = $tx } | ConvertTo-Json
$v = Invoke-RestMethod -Method Post -Uri "$api/approvals/$id/verify" -ContentType application/json -Body $body
$v.request.status                              # fulfilled_by_owner
$v.checks | Format-Table                       # six checks, all True
"https://sepolia.basescan.org/tx/$tx"

$after = Invoke-RestMethod "$api/wallet/status"
"spentToday $($before.agent.spentToday.mUSDC) -> $($after.agent.spentToday.mUSDC)  (must be equal)"
"maxPerTx $($before.agent.maxPerTx.mUSDC) -> $($after.agent.maxPerTx.mUSDC), dailyLimit $($before.agent.dailyLimit.mUSDC) -> $($after.agent.dailyLimit.mUSDC)"
"credits $($before.wallet.credits) -> $($after.wallet.credits)  (+150)"
(Invoke-RestMethod "$api/requests/$id").proofVerified   # True
```

Pass when: status `fulfilled_by_owner`, all six checks `True`, `spentToday`, `maxPerTx` and `dailyLimit` unchanged,
credits +150.

Optional negative checks against the live backend (each must fail and leave the request alone):

```powershell
$chat2 = Invoke-RestMethod -Method Post -Uri "$api/agent/chat" -ContentType application/json -Body '{"message":"buy 150 credits"}'
$id2 = $chat2.requestIds[0]
function Try-Verify($h) {
  try { Invoke-RestMethod -Method Post -Uri "$api/approvals/$id2/verify" -ContentType application/json -Body (@{ txHash = $h } | ConvertTo-Json) }
  catch { ($_.ErrorDetails.Message | ConvertFrom-Json).error.code }
}
Try-Verify $tx                                  # TX_ALREADY_USED (already proved the first request)
Try-Verify ("0x" + "ab" * 32)                   # TX_NOT_FOUND
(Invoke-RestMethod "$api/requests/$id2").status # still needs_owner_approval
Invoke-RestMethod -Method Post -Uri "$api/approvals/$id2/reject" -ContentType application/json -Body '{"note":"test done"}'
```

If verify fails, the error body lists every check with `ok` and a `detail`:
`try { ... } catch { $_.ErrorDetails.Message }`. `NOT_OWNER_TX` means the tx was not sent by the owner account;
`CREDITS_MISMATCH` means `APPROVE_CREDITS` differed from the request; `TX_NOT_FOUND` right after sending means the
RPC has not seen the receipt yet, so wait a few seconds and retry.

## Tests (Anvil)

`npm run test:anvil` includes `test/approvals.anvil.test.mjs`: a real owner approval through the API (policy and
`spentToday` unchanged), a fake tx hash, an agent UserOp and a stranger's tx (not the owner), an owner tx for other
credits, an approve-only tx, a tx older than the request, a reused tx, expiry, reject, and hand-edited SQLite rows.
