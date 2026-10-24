# Phase 7: restricted execution path and daily spending limits

## Execution trace: EntryPoint → AgentWallet → target

1. **Bundler / agent backend** calls `EntryPoint.handleOps([op], beneficiary)` (`core/EntryPoint.sol:174`). `handleOps` is `nonReentrant`.
2. **Validation loop (all ops first)**: `_validatePrepayment` → `AgentWallet.validateUserOp` (inherited `BaseAccount:35`) →
   `_requireFromEntryPoint` → **`AgentWallet._validateSignature`**:
   - callData selector is `executeAsAgent` → decode `(agent, target, value, data)`, recover signer from the UserOp hash (same EIP-191
     scheme as SimpleAccount), require `signer == agent`, run the time-independent checks (`_agentCallError`), return
     `validationData = (validUntil, validAfter)`.
   - any other selector → unchanged `SimpleAccount._validateSignature` (owner only). So an agent signature can never select
     `execute`, `executeBatch`, admin, upgrade or withdraw functions, and the owner cannot run ops "as" an agent.
   - then the EntryPoint checks the time window (AA22) and the agent's nonce key (AA25).
3. **Execution loop**: `_executeUserOp` → `innerHandleOp` → `Exec.call(wallet, 0, callData)` (`EntryPoint.sol:341`) →
   **`AgentWallet.executeAsAgent(agent, target, 0, data)`** with `msg.sender == EntryPoint`:
   1. `msg.sender` must be the EntryPoint (`UnauthorizedCaller` otherwise). This is the only entry for agents, and since only the
      EntryPoint can call it, the `agent` argument is always the one whose signature was verified in step 2.
   2. `isAgentValid(agent)` again (revoked or expired since validation → revert).
   3. `_agentCallError` again: value 0; target not 0 / wallet / EntryPoint; selector present;
      - target == policy token: data must be exactly `transfer(address,uint256)` (68 bytes, clean address), recipient allowed,
        amount ≤ maxPerTx;
      - otherwise `(target, selector)` must be allowlisted.
   4. Record the wallet's policy-token balance.
   5. **`_call(target, 0, data)`** (inherited from SimpleAccount): the wallet calls the target, e.g. `MockMerchant.purchase(credits, payment)`,
      which calls `MockUSDC.transferFrom(wallet, merchant, payment)` using the owner's approval. Reverts bubble up.
   6. Measure the balance again. If it fell by `spent > 0` (`_recordSpend`):
      - non-token target: the target must be an allowed recipient (the payee),
      - `spent ≤ maxPerTx`,
      - reset the counter if `block.timestamp / 1 days` changed, then `spentToday + spent ≤ dailyLimit`,
      - store `currentDay`, `spentToday += spent`, emit `AgentSpent(agent, token, recipient, spent, spentToday)`.
   7. Emit `AgentExecuted`. Any revert in 3–6 reverts the whole call, so the counter and balances never change for a failed op.
      The EntryPoint emits `UserOperationRevertReason`, charges gas and the nonce stays used.

**Why measure the balance instead of trusting decoded arguments?** The outer target being allowlisted says nothing about where tokens
go (an allowlisted contract could `transferFrom` the wallet to anyone). The measured decrease is the real amount spent, whatever the
target's ABI, and it covers both `transfer` and pull payments.

## Inherited execution methods reviewed

| Method | Who can reach it | Agent bypass? |
|---|---|---|
| `execute`, `executeBatch` | owner EOA, EntryPoint | No: agent-signed ops can only select `executeAsAgent` |
| `executeAsAgent` (new) | EntryPoint only | Bound to the signer by validation |
| `upgradeToAndCall`, `withdrawDepositTo`, all admin functions | `onlyOwner` = owner or the wallet itself | No: agents can't select them, and `target == wallet` is forbidden |
| `validateUserOp` | EntryPoint | Agent path only for `executeAsAgent` |
| `initialize` | once, at proxy creation | No |
| `executeUserOp` (EntryPoint v0.7 option) | not implemented by SimpleAccount | Rejected in validation |
| `receive`, `addDeposit`, token callbacks | anyone | Only bring value in |
| EntryPoint `withdrawTo` / `incrementNonce` / `addStake` via the wallet | wallet as caller | No: `target == EntryPoint` is forbidden |

## Test results

`forge test`: **113 passed, 0 failed** (7 suites). New suite `AgentWalletSpendingTest`: 21 passed (incl. 256-run fuzz).
All agent tests go through a real `EntryPoint.handleOps` with signed UserOps.

| Required test | Test name |
|---|---|
| Spending within limits | `test_transferWithinLimits`, `test_purchaseWithinLimits`, `test_exactlyMaxPerTxAndExactlyDailyLimitAllowed` |
| Above maxPerTx | `test_transferAboveMaxPerTxRejectedInValidation`, `test_purchaseAboveMaxPerTxRejected` |
| Purchase crossing dailyLimit | `test_identicalPurchaseAcceptedThenRejectedByDailyLimit` (acceptance), `test_transferCrossingDailyLimitRejected`, `testFuzz_dailyLimitNeverExceeded` |
| Unauthorized recipient | `test_unauthorizedRecipientRejected`, `test_allowlistedContractPullingToElsewhereIsChecked` |
| Unauthorized selector | `test_unauthorizedSelectorRejected`, `test_malformedTransferCalldataRejected` |
| Failed merchant call | `test_failedMerchantCallLeavesCounterUnchanged`, `test_merchantCallFailingOnAllowanceLeavesCounterUnchanged` |
| Agent calling admin functions | `test_agentCannotRaiseItsOwnLimits` |
| Bypassing the restricted path | `test_agentCannotBypassViaInheritedExecute`, `test_agentCannotSpendUnderAnotherAgentsIdentity`, `test_onlyEntryPointCanCallExecuteAsAgent`, `test_ownerSignedExecuteAsAgentRejected` |
| Daily counter reset | `test_dailyCounterResetsOnNewDay` (blocked at 23:59:59, open at 00:00 UTC) |
| Extra | `test_allowlistedPayeeStillBoundByLimits`, `test_limitsArePerAgent`, `test_ownerPathUnaffectedByAgentLimits` |

## Changes from earlier phases

- `executeAsAgent` is now **EntryPoint-only** (Phase 6 also allowed the agent EOA to call it directly). Agents must submit UserOps.
- Owner-signed UserOps that call `executeAsAgent` are rejected; the owner uses `execute`.
- Paying a merchant needs `allowCall(agent, merchant, purchase.selector)` **and** `allowRecipient(agent, merchant)`, plus an owner approval.
- `SpendingNotEnabled` (Phase 6 temporary error) removed. No change to any IAgentWallet signature or event (freeze test still passes).

## Remaining security concerns

1. **Standing allowance outside agent calls.** The owner's approval to the merchant can be used by the merchant contract at any time,
   not only during an agent call, and that spending is not counted. Keep approvals small; with a trusted merchant this is fine for the demo.
2. **Gas griefing.** Ops that pass validation but fail in execution (e.g. over the daily limit, which can't be checked in validation
   without block.timestamp) still cost the wallet's EntryPoint deposit. Keep the deposit small or use a paymaster; revoke a misbehaving agent.
3. **Only the policy token is metered.** Other tokens/NFTs the wallet holds are safe only if the owner never approves them to an
   agent-allowlisted contract. Agents with `token == address(0)` have no spending metering at all.
4. **Token assumptions.** Metering assumes a standard ERC20 (MockUSDC): no fee-on-transfer, rebasing or callback hooks.
5. **Not yet run through a real bundler** on Base Sepolia (ERC-7562 tracing). Validation reads only the wallet's own storage, which
   should be accepted for an unstaked account, but this needs one live check.
6. **Owner is fully trusted** (can upgrade the implementation and change every policy).
