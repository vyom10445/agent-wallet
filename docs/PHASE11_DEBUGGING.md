# Phase 11: Debugging guide

Every row marked ✅ is reproduced by a test (`contracts/test/IntegrationSupport.t.sol`, `SecuritySuite.t.sol`, `OwnerApproval.t.sol`) or by a run of the `integration/` examples. The other rows follow from the code but have no dedicated test.

**First step for any agent op:** simulate `handleOps` (viem `simulateContract`, or `cast call`). Validation failures come back as `FailedOp(opIndex, "AAxx …")` or `FailedOpWithRevert(opIndex, "AAxx …", inner)`. `explainError()` in `integration/lib.mjs` turns them into one readable line.

## P-2: agent backend (UserOperations)

| Symptom | Cause | Fix |
|---|---|---|
| ✅ `AA24 signature error` | The signer isn't the `agent` in `executeAsAgent(agent, …)`, or the agent isn't registered or was revoked. | Sign with the key whose address is the first argument. Check `getAgent(agent).active`. |
| ✅ `AA24` with the correct key | You signed the **raw** userOpHash. | Use EIP-191: `signMessage({ message: { raw: userOpHash } })` (viem) or `toEthSignedMessageHash` and then sign. |
| ✅ `AA24` with the correct key and prefix | The nonce key isn't the agent's address. For example, you used `getNonce(wallet, 0)` or the wallet's `getNonce()`. | `nonce = EntryPoint.getNonce(wallet, BigInt(agentAddress))`. |
| ✅ `AA24` | The call breaks the policy at validation: target not allowlisted, wallet/EntryPoint/zero target, `value != 0`, a token call other than an exact `transfer`, or a transfer above maxPerTx or to a recipient that isn't allowed. | Check `isCallAllowed(agent, merchant, 0x70876c98)` and `isRecipientAllowed(agent, merchant)`. Keep `value` at 0. |
| ✅ `AA24` | The hash was computed for another chain or EntryPoint (for example, you signed on Anvil and submitted on Base Sepolia). | Call `getUserOpHash` on the EntryPoint of the chain you submit to. |
| ✅ `AA23 reverted` → `ECDSAInvalidSignatureLength(64)` | The signature isn't exactly 65 bytes (r‖s‖v). | Don't strip `v`. Don't use compact (EIP-2098) signatures. |
| `AA23 reverted` → `ECDSAInvalidSignatureS` | High-s signature. | Use a standard signer, which always produces low-s. |
| ✅ `AA22 expired or not due` | Outside the agent's `validAfter`/`validUntil` window. | Owner: `revokeAgent` and then `addAgent` with a new window, or wait until `validAfter`. |
| ✅ `AA25 invalid account nonce` | The nonce was already used (replay or a stale cache), or you skipped ahead. | Read `getNonce(wallet, agentKey)` right before building each op. Send one op at a time per agent. |
| ✅ `AA21 didn't pay prefund` | The wallet's EntryPoint deposit (or its ETH balance) can't cover `gasLimits × maxFeePerGas`. | Owner: `wallet.addDeposit{value}` (ConfigureAgent does this). Or lower `maxFeePerGas` to the real network fee. |
| ✅ `AA95 out of gas` (whole transaction reverts) | The `handleOps` transaction gas is below what the op declares. | Send `handleOps` with `gas ≥ verification + call + preVerification + 200k` (`BUNDLE_GAS_LIMIT`). |
| ✅ The transaction succeeds but `UserOperationEvent.success == false` | Validation passed but execution reverted. `UserOperationRevertReason` holds the reason. | Decode `revertReason` with the combined ABIs. The common reasons are in the next table. |
| ✅ Gas estimation reverts with a dummy signature | The dummy wasn't well-formed (wrong length or high s). | Use the documented dummy (r = G.x, s = 1, v = 27). It returns `SIG_VALIDATION_FAILED` without reverting. |
| `UnauthorizedCaller(addr)` | `executeAsAgent` was called directly instead of through the EntryPoint. | Agents always go through a UserOp. |
| Wrong callData shape | `executeAsAgent(agent, target, value, data)`: the outer call goes to the **wallet**, and `data` is the merchant's `purchase(credits, payment)` calldata. | Compare with `integration/agent-purchase.mjs`. The selector for `executeAsAgent` is `0x6151bacc`. |

Execution-time reverts (inside `UserOperationRevertReason`, or a direct simulation):

| Error | Selector | Meaning |
|---|---|---|
| ✅ `ExceedsPerTxLimit(amount, maxPerTx)` | `0xd1e6b2fa` | The merchant pulled more than maxPerTx. Ask for owner approval (section 8 of the integration doc). |
| `ExceedsDailyLimit(amount, remaining)` | `0x473a3226` | Today's (UTC) budget is used up. Check `remainingDailyAllowance`. |
| `RecipientNotAllowed(agent, recipient)` | `0x28c539e8` | Funds moved to an address that isn't allowlisted. |
| `IncorrectPayment(expected, provided)` | `0x0d35e921` | `payment != quote(credits)`. Re-read `quote`. |
| `ERC20InsufficientAllowance(spender, allowance, needed)` | `0xfb8f41b2` | The merchant allowance from the owner is too low. The owner needs to re-approve. |
| `ERC20InsufficientBalance(sender, balance, needed)` | `0xe450d38c` | The wallet has too little mUSDC. `mint` it on testnet. |
| `ZeroCredits()` | `0x943ec9b1` | `credits == 0`. |

Every other selector is in `abi/selectors.json`.

## P-3: frontend

| Symptom | Cause | Fix |
|---|---|---|
| ✅ A read returns `active: false` / zeros | Wrong agent address, or the agent was revoked or has expired (7-day window). | Run `Status.s.sol` or `integration/read.mjs` with the right `AGENT_ADDRESS`. Ask P-1 to re-add the agent if it has expired. |
| A read fails or returns `0x` | Wrong chain or address. | Chain ID 84532, with addresses from `contracts/deployments/84532.json`. |
| ✅ The owner transaction reverts `only owner` | It wasn't signed by `owner()` (0x815d…7b64). | Connect the owner wallet. Agents and anyone else are refused. |
| `InvalidAgent(addr)` | `addAgent` with zero, the owner, the wallet or the EntryPoint as the agent. | Use a separate EOA as the agent. |
| `AgentAlreadyActive(addr)` | `addAgent` on an active agent. | Use `setPolicy` to change limits, or revoke first. |
| `InvalidValidityWindow(after, until)` | `validUntil == 0` or `validAfter > validUntil`. | Send unix **seconds**, not milliseconds. |
| `ForbiddenTarget(addr)` | `allowCall`/`allowRecipient` targeting zero, the wallet or the EntryPoint. | Allow the merchant address instead. |
| ✅ The spend counter "doesn't reset" in the UI | A cached value. | Re-read `getAgent`/`remainingDailyAllowance`. They roll over at 00:00 UTC on their own. |
| Amounts are 1,000,000× too big or too small | Decimals. | mUSDC uses 6 decimals: `formatUnits(x, 6)` / `parseUnits(s, 6)`. |
| ✅ Events don't decode | Wrong ABI or emitter. | `AgentSpent`/`AgentExecuted`/`PolicySet` come from the **wallet**, `CreditsPurchased` from the **merchant**, `UserOperationEvent` from the **EntryPoint**. Pass all the ABIs to `parseEventLogs`. |
| ✅ "Success" was shown but nothing was bought | Only the transaction status of `handleOps` was checked. | Check `UserOperationEvent.success` for the `userOpHash`. |
| ✅ The owner approval reverts and nothing changes | Wrong price, or a balance or allowance problem. The batch is atomic, so it all rolls back. | Rebuild from `quote(credits)` right before signing. |
| `getContractEvents` errors on the public RPC | The block range is too large. | Query in chunks (for example 5000 blocks), or use your own RPC URL. |

## Quick tools

```bash
cast 4byte-decode <calldata>                      # what a calldata does
cast decode-error <revert data> --sig "ExceedsPerTxLimit(uint256,uint256)"
cast run <txhash> --rpc-url base_sepolia          # full trace of a mined tx
forge script script/Status.s.sol --rpc-url base_sepolia   # live state, read-only
```
