# Phase 9: security test suite

This is a test-coverage review, **not an audit**. Passing tests show the cases below behave as expected; they do not prove the
wallet is secure.

## 1. Code paths reviewed and expected behaviour

| Area | Code path (src/AgentWallet.sol unless noted) | Expected behaviour | Tests (new in **bold**) |
|---|---|---|---|
| Agent authorization | `_validateSignature` agent branch: decode `executeAsAgent`, `signer == agent`, **nonce key == agent**, `_agentCallError` | Only the named agent's signature, on its own nonce key, for an allowed call | `AgentWalletValidation`, **`test_agentCannotUseOwnerNonceKey`**, **`test_agentCannotUseAnotherAgentsNonceKey`**, **`testFuzz_randomSignerRejected`** |
| Owner authorization | `onlyOwner` (SimpleAccount: owner or self), `super._validateSignature` | Admin, upgrade, withdraw only by owner; owner ops unchanged | `AgentWallet.t.sol`, **`testFuzz_nonOwnerCannotAdminister`**, **`test_ownerCannotRouteIntoExecuteAsAgentViaExecute`** |
| maxPerTx | `_agentCallError` (transfers, in validation) and `_recordSpend` (measured outflow) | No single execution moves more than maxPerTx | `AgentWalletSpending`, **`testFuzz_maxPerTxBoundary`**, fuzz + invariant below |
| Daily spending | `_recordSpend`: `spent + amount <= dailyLimit` | Executed outflow per UTC day ≤ dailyLimit | **`testFuzz_executedSpendingNeverExceedsPolicy`**, **`testFuzz_existingSpendingPlusNewAmount`**, **`invariant_dailyOutflowNeverAboveLimit`** |
| Day boundary | `_currentDay() = timestamp / 1 days`, reset in `_recordSpend`/`_spentToday` | 23:59:59 counts to that day; 00:00:00 starts at 0 | `test_dailyCounterResetsOnNewDay`, **`test_lastSecondOfDayStillCountsToThatDay`**, **`test_burstAcrossMidnightIsTwoBudgets`**, **`test_policyChangeMidDayKeepsCounter`** |
| Target allowlist | `_allowedCalls[agent][epoch][target][selector]` | Exact (target, selector) pair only | **`test_sameSelectorOnOtherContractRejected`**, **`test_removedCallPermissionTakesEffect`** |
| Selector allowlist | same | Any other selector on an allowed target is rejected | **`testFuzz_onlyAllowlistedSelectorOnMerchant`** |
| Recipient allowlist | token path: decoded recipient; pull path: target must be allowed payee | Tokens only reach allowed recipients | **`testFuzz_transferOnlyToAllowedRecipients`**, **`test_removedRecipientTakesEffect`**, **`test_merchantMustAlsoBeAllowedRecipient`**, **`invariant_nothingReachesUnapprovedAddresses`** |
| Admin self-calls | `target == address(this)` forbidden in `_agentCallError` and `_requireAllowedTarget` | Agent can never make the wallet call itself | **`testFuzz_agentCannotTargetWalletOrEntryPoint`**, **`test_ownerCannotAllowlistWalletOrEntryPoint`** |
| Token approvals | policy token path accepts only `transfer` | No approve / transferFrom, even if owner allowlists them | **`test_agentCannotApproveEvenIfOwnerAllowlistsApprove`**, **`test_agentCannotTransferFromOrApproveAnySpender`** |
| Revocation | `revokeAgent`: delete policy, bump epoch; re-checked in execution | Immediate; ops signed earlier fail | **`test_opSignedBeforeRevocationRejected`**, **`test_reAddedAgentGetsFreshPermissionsAndCounter`**, `test_executionRechecksPolicyAfterValidation` |
| Expiry | `validUntil/validAfter` in validationData (EntryPoint AA22) + `isAgentValid` in execution | Valid exactly at validUntil, not 1 s later | **`test_validUntilIsInclusiveAtEntryPoint`**, **`test_opSignedWhileValidRejectedAfterExpiry`**, **`test_notYetValidAgentRejected`** |
| Invalid signatures | OZ `ECDSA.recover` (reverts on bad length / high-s), signer mismatch → 1 | Malformed → AA23, wrong signer → AA24 | **`test_malleableHighSSignatureRejected`**, **`test_wrongLengthAndEmptySignaturesRejected`**, **`testFuzz_randomSignerRejected`** |
| Nonce / replay | EntryPoint 2D nonce + agent key enforcement | Replay → AA25, skipped nonce → AA25 | **`test_replayedAgentOpRejected`**, **`test_futureNonceRejected`** |
| Cross-chain replay | `userOpHash = keccak(hash(op), entryPoint, chainid)` | Same op on another chain, EntryPoint or wallet fails | **`test_signatureFromOtherChainRejected`**, **`test_opForOtherEntryPointRejected`**, **`test_opForOneWalletCannotRunOnAnother`** |
| Inherited bypasses | agent signatures accepted only for `executeAsAgent` | execute, executeBatch, upgrade, withdraw, initialize, addDeposit, admin, executeUserOp all rejected | **`testFuzz_agentSignedNonAgentCallDataRejected`**, **`test_agentCannotSignAnyInheritedEntry`** |
| Failed execution | whole `executeAsAgent` reverts; EntryPoint keeps the nonce | Counter and balances unchanged | **`testFuzz_failedPurchaseNeverCounted`**, **`invariant_counterEqualsActualOutflowToday`** |

## Step 9.2: spending fuzz on real executed spending

- `testFuzz_executedSpendingNeverExceedsPolicy` (512 runs): random `maxPerTx` (0–200 USDC), `dailyLimit` (0–500 USDC), 6 random amounts
  (transfers or merchant purchases), random time jumps including across midnight. For every step it measures the wallet's actual USDC
  outflow after a real `handleOps` and asserts: outflow equals the amount if and only if the policy allows it, no single outflow
  above maxPerTx, total per day ≤ dailyLimit, and the on-chain counter equals the measured outflow.
- `testFuzz_existingSpendingPlusNewAmount` (512 runs): builds existing daily spending from real transfers, then tries one more.
- `SpendingInvariantTest` (48 runs × 25 random calls): random transfers (incl. to a stranger), purchases (incl. wrong payments),
  approve attempts and time jumps. Invariants: per-day outflow ≤ dailyLimit, single outflow ≤ maxPerTx, counter = today's outflow,
  stranger never receives tokens or allowance, tokens conserved.

**Mutation check:** I broke the contract 8 ways (removed the daily check, maxPerTx check, nonce-key check, payee check, EntryPoint-only
check, self/EntryPoint target block, counter reset, counter increment). The suite failed for **all 8** (2 to 17 failing tests each), so
these tests do detect those mistakes.

## 2–3. Results

`forge test`: **165 passed, 0 failed, 0 skipped** (11 suites). Added in this phase: **41** (SecuritySuite 34, SpendingFuzz 2,
SpendingInvariant 5), plus a shared fixture `test/utils/AgentWalletTestBase.sol`.

## 4. Security issue discovered (fixed)

**Agent could consume the owner's nonce sequence.** An agent could sign its UserOp with nonce key 0 (the owner's key) or another agent's
key. The EntryPoint accepted it, which incremented that sequence and invalidated any owner op already signed for that nonce (griefing;
no funds at risk). Reproduced with a probe test before the fix. **Fix:** `_validateSignature` now requires
`userOp.nonce >> 64 == uint160(agent)` for agent ops. Tests: `test_agentCannotUseOwnerNonceKey`, `test_agentCannotUseAnotherAgentsNonceKey`.

## 5. Unresolved issues (documented, not fixed)

1. **Burst around midnight.** UTC-day buckets allow up to 2 × dailyLimit within seconds across 00:00 (`test_burstAcrossMidnightIsTwoBudgets`).
   A rolling 24 h window would need different storage.
2. **Gas griefing.** Ops that pass validation but fail in execution (daily limit, merchant revert) still cost the wallet's EntryPoint deposit.
3. **Standing merchant allowance.** The owner's approval can be pulled by the merchant outside agent calls, unmetered.
4. **Only the policy token is metered.** Other tokens are safe only if the owner never allowlists value-moving calls on them. If the owner
   changes an agent's policy token, earlier `allowCall` entries on the old token (e.g. `transfer`) become unmetered calls.
5. **Re-adding or token switch resets the daily counter** the same day (owner actions; `test_reAddedAgentGetsFreshPermissionsAndCounter`).
6. **Token assumptions.** Metering is net balance change of a standard ERC20; fee-on-transfer or rebasing tokens are not supported.
7. **No real bundler / ERC-7562 tracer run** yet; validation reads only the wallet's own storage, but this is unverified on a live bundler.
8. **Owner is fully trusted** (UUPS upgrade can replace all policy code).
9. **Not audited.** No external review, formal verification or static analysis (e.g. Slither) has been run.
