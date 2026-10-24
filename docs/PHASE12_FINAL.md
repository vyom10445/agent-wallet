# Phase 12: Final verification and demo

**Feature freeze (H30).** Phase 12 added no contract features and changed no contract code. It added one test (factory idempotency), ran a static analysis, and added this document.

## 1. Results at a glance

| Evidence | Result |
|---|---|
| `forge build` | compiles (solc 0.8.23, EntryPoint v0.7.0, OpenZeppelin 5.0.2) |
| `forge test` | **187 passed, 0 failed** (14 suites) |
| Line, statement, branch and function coverage of `src/` (`forge coverage`) | **100% / 100% / 100% / 100%** for AgentWallet, AgentWalletFactory, MockMerchant and MockUSDC |
| Fuzz tests | 8 security-suite fuzzers at 5,000 runs each, 2 spending fuzzers at 512 runs, and 3 more at the default 256 runs, 0 failures |
| Invariants | 5 spending invariants, 1,200 calls per invariant, 0 violations |
| Mutation check (Phase 9) | 8 of 8 hand-made bugs caught by the suite |
| Slither 0.11.6 (`src/`, informational excluded) | 6 low findings, all by design (section 6) |
| Live Anvil demo (`H12Demo.s.sol`) | 10 of 10 stages PASS, **H12: GO** |
| Base Sepolia | deployed, configured, and the smoke-test purchase PASSED (run by P-1) |
| Bugs found during the project | 1 (an agent could use the owner's nonce key). Fixed in Phase 9 and regression-tested. |

## 2. Verification checklist

Each row shows the status and the tests that prove it. Run any row with `forge test --match-test <name> -vv`.

### Contract integrity

| Item | Status | Evidence |
|---|---|---|
| Project compiles | PASS | `forge build` |
| All critical Foundry tests pass | PASS | `forge test`: 187/187 |
| EntryPoint version confirmed | PASS | `test_env_entryPointIsV07`, `test_baseSepolia_usesCanonicalEntryPointAndOwner`. Live: `Status.s.sol` prints `EntryPoint is v0.7 true`. |
| Owner authorization works | PASS | `test_validOwnerOperationAccepted`, `test_ownerCanAdministerViaUserOperation`, `test_ownerCanStillExecute`, `testFuzz_nonOwnerCannotAdminister` |
| Agent authorization works | PASS | `test_validAgentOperationAccepted`, `test_unregisteredSignerRejected`, `test_agentCannotSignForAnotherAgent` |
| Restricted execution enforced | PASS | `test_onlyEntryPointCanCallExecuteAsAgent`, `test_executionRechecksPolicyAfterValidation`, `test_agentCannotBypassViaInheritedExecute` |
| No known unrestricted inherited execution route | PASS | `test_agentCannotSignAnyInheritedEntry` covers execute, executeBatch, upgradeToAndCall, withdrawDepositTo, initialize, addDeposit, admin functions and executeUserOp. Re-initialization is blocked (Integration suite). The full table is in section 3. |
| Spending counters correct | PASS | `invariant_counterEqualsActualOutflowToday`, `test_dailyCounterResetsOnNewDay`, `test_spentToday_readsZeroAfterUtcMidnight` |
| Token decimals and units consistent | PASS | `test_metadata`, `test_baseUnits` (6 decimals). Merchant price is 10,000 = 0.01 mUSDC, and every doc uses base units. |

### Security

| Item | Status | Evidence |
|---|---|---|
| Per-transaction limit | PASS | `testFuzz_maxPerTxBoundary`, `test_purchaseAboveMaxPerTxRejected`, `invariant_singleOutflowNeverAboveMaxPerTx` |
| Daily limit | PASS (see limitation L1) | `testFuzz_dailyLimitNeverExceeded`, `invariant_dailyOutflowNeverAboveLimit`, `test_identicalPurchaseAcceptedThenRejectedByDailyLimit` |
| Target allowlisting | PASS | `test_unauthorizedTargetRejected`, `test_sameSelectorOnOtherContractRejected` |
| Function-selector allowlisting | PASS | `testFuzz_onlyAllowlistedSelectorOnMerchant`, `test_unauthorizedSelectorRejected`, `test_removedCallPermissionTakesEffect` |
| Recipient allowlisting | PASS | `testFuzz_transferOnlyToAllowedRecipients`, `test_merchantMustAlsoBeAllowedRecipient`, `invariant_nothingReachesUnapprovedAddresses` |
| Revocation | PASS | `test_revokeIsImmediate`, `test_opSignedBeforeRevocationRejected`, `test_stage9_revokedAgentCannotPurchase` |
| Expiry | PASS | `test_opSignedWhileValidRejectedAfterExpiry`, `test_validUntilIsInclusiveAtEntryPoint`, `test_notYetValidAgentRejected` |
| Invalid signatures rejected | PASS | `testFuzz_randomSignerRejected`, `test_malleableHighSSignatureRejected`, `test_wrongLengthAndEmptySignaturesRejected`, `test_signingWithoutEip191Prefix_isRejected` |
| Replay protection | PASS | `test_replayedAgentOpRejected`, `test_signatureFromOtherChainRejected`, `test_opForOtherEntryPointRejected`, `test_opForOneWalletCannotRunOnAnother`, `test_agentCannotUseOwnerNonceKey` |
| Administrative self-calls rejected | PASS | `testFuzz_agentCannotTargetWalletOrEntryPoint`, `test_agentCannotTargetWalletItself`, `test_ownerCannotAllowlistWalletOrEntryPoint`, `test_agent_cannotExpandOwnPermissions` |
| Failed execution doesn't corrupt accounting | PASS | `testFuzz_failedPurchaseNeverCounted`, `test_failedMerchantCallLeavesCounterUnchanged`, `test_ownerApproval_wrongPrice_rollsBackEverything` |

### Integration

| Item | Status | Evidence |
|---|---|---|
| Agent purchases through EntryPoint | PASS | `test_stage5to7_agentPurchaseThroughEntryPoint`. Live on Anvil (H12Demo) and Base Sepolia (SmokeTest). |
| MockUSDC balances update correctly | PASS | `invariant_tokensConserved`, `testFuzz_purchaseConservesTokens`, SmokeTest "wallet paid exactly the quote" |
| Merchant purchases recorded | PASS | `test_validPurchaseMovesTokensAndRecordsCredits`, `test_purchaseEmitsEvent`. Live: `credits purchased` in Status. |
| Owner-authorized execution works | PASS | `test_ownerApproval_viaOwnerSignedUserOp`, `test_ownerApproval_viaDirectOwnerTransaction`, `test_stage10_ownerExecutionPathStillWorks` |
| P-2 has ABIs and addresses | PASS | `abi/`, `contracts/deployments/84532.json`, `docs/PHASE11_INTEGRATION.md` §7 |
| P-3 can read state and events | PASS | `integration/read.mjs` and `events.mjs`, run on a local chain (P-1 confirmed Phase 11 on their side) |

### Documentation

| Item | Status | Where |
|---|---|---|
| Deployment instructions | PASS | `docs/PHASE10_DEPLOYMENT.md` (plus the step-by-step guide) |
| Test commands | PASS | Section 5 below, `contracts/README.md` |
| Contract addresses | PASS | Section 4 below, `contracts/deployments/84532.json`, `docs/INTERFACE.md` |
| Known limitations | PASS | Section 7 below |
| Security results for presentation | PASS | Sections 1, 2 and 6 |
| BaseScan source verification | **Not confirmed** | Optional step 12 of the Phase 10 guide. Do it before the demo if you want readable contracts on the explorer. |

## 3. Every way to make the wallet do something

| Entry point | Who can use it | Proof |
|---|---|---|
| `executeAsAgent` | EntryPoint only, inside an agent-signed op that passes the policy (validated, then rechecked in execution) | Validation and Spending suites |
| `execute`, `executeBatch` | owner, or EntryPoint with an **owner** signature | `test_agentCannotSignExecute(Batch)` |
| `addAgent`, `setPolicy`, `allowCall`, `allowRecipient`, `revokeAgent` | owner or the wallet itself. The agent can't target the wallet, so in practice only the owner. | `testFuzz_nonOwnerCannotAdminister` |
| `upgradeToAndCall` (UUPS) | owner | `test_agentCannotSignAnyInheritedEntry`, SecuritySuite |
| `withdrawDepositTo` | owner | same |
| `initialize` | nobody (already initialized) | Integration suite |
| `validateUserOp` | EntryPoint only | SimpleAccount v0.7.0 |
| `addDeposit`, `receive` | anyone. These only add funds. | — |
| ERC-721/1155 receiver hooks | anyone. They are pure and move nothing. | — |

## 4. Addresses (Base Sepolia, chain ID 84532)

| Contract | Address |
|---|---|
| EntryPoint v0.7 (canonical) | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |
| AgentWallet | `0x74cD24BBaf39022155d2912923F4dC234D215c1A` |
| Owner | `0x815d211D2E85E2C2526f0CC3bB1DEE11513C7b64` |
| Agent | `0xC74Ba823524Cbd1d889b5FD38785b9d293C6D8aD` |
| AgentWalletFactory | `0xAD5E19b7A292735b79D13e48A854BAf6baC96D51` |
| AgentWallet implementation | `0xec0de95c6C52d1AECCECde692c422c94987Bc262` |
| MockUSDC (6 decimals) | `0xC91a11d7096c0685590267C083Fd67A518D65C3F` |
| MockMerchant (0.01 mUSDC per credit) | `0x8D94CcD748a00C27Cc339aaE3A14F2965E8b4FC1` |

Explorer: `https://sepolia.basescan.org/address/<address>`

## 5. Commands (PowerShell, from `agent-wallet\contracts`)

```powershell
forge build
forge test                                            # everything (187)
forge test --match-contract SecuritySuiteTest -vv      # security suite only
forge test --match-contract OwnerApprovalTest -vv      # owner approval flow
forge test --match-path "test/invariant/*" -vv         # invariants
forge coverage --report summary                       # coverage table
$env:FOUNDRY_FUZZ_RUNS=5000; forge test --match-contract SecuritySuiteTest; Remove-Item Env:FOUNDRY_FUZZ_RUNS
```

## 6. Static analysis (Slither 0.11.6, `slither . --filter-paths "lib/|test/|script/" --exclude-informational`)

| Finding | Where | Verdict |
|---|---|---|
| incorrect-equality (×2) | `p.currentDay == today` | By design: the day bucket is an integer (`timestamp / 1 days`), so an exact comparison is correct. |
| timestamp (×3) | `isAgentValid`, `_recordSpend`, `_spentToday` | By design: day buckets and the validity window. A validator can only shift the timestamp by seconds. Validation itself uses no timestamp (ERC-7562), because the window goes to the EntryPoint in validationData. |
| reentrancy-events (×1) | `MockMerchant.purchase` emits after `transferFrom` | Mock only. The token is our MockUSDC, and credits are written before the external call. Left unchanged under the feature freeze. |

No high- or medium-severity findings. This is not an audit.

## 7. Known limitations (presented honestly)

| # | Limitation | Impact for the demo |
|---|---|---|
| L1 | Daily limits are UTC calendar days, so up to 2× dailyLimit is possible within seconds across 00:00 UTC (`test_burstAcrossMidnightIsTwoBudgets`). | Expected behaviour. Mention it if asked. |
| L2 | An op that passes validation but fails in execution still costs the wallet's gas deposit (gas griefing by a compromised agent key). | Revoke the agent. Keep the deposit small. |
| L3 | The owner's standing merchant allowance can be pulled by the merchant outside agent calls, unmetered. | The mock merchant only pulls on `purchase`. |
| L4 | Only the policy token is metered. Other assets are safe only if the owner never allowlists value-moving calls on them. | The demo uses mUSDC only. |
| L5 | Re-adding an agent or switching its token resets the same-day counter. These are owner actions. | — |
| L6 | Metering assumes a standard ERC-20. Fee-on-transfer and rebasing tokens aren't supported. | — |
| L7 | No public bundler and no ERC-7562 tracer have been tested. The demo submits `handleOps` directly from an EOA. | Say "bundler-compatible format, direct EntryPoint submission". |
| L8 | The owner is fully trusted, including UUPS upgrades. | — |
| L9 | Not audited. 100% coverage, fuzzing, invariants, mutation checks and Slither are evidence, not proof. | Never claim "secure". |
| L10 | Demo keys: the agent key sits in a local `.env` on a testnet throwaway account. MockUSDC has an open mint. | Testnet only. |

## 8. Demo script (about 7 minutes)

**Before the demo** (the day before, and again 1 hour before):
1. The agent's validity ends **7 days after ConfigureAgent ran**, so check `agent valid now` in Status. If it has expired, revoke and then rerun ConfigureAgent:
   ```powershell
   cast send 0x74cD24BBaf39022155d2912923F4dC234D215c1A "revokeAgent(address)" 0xC74Ba823524Cbd1d889b5FD38785b9d293C6D8aD --account deployer --rpc-url base_sepolia
   ```
2. Rerun ConfigureAgent anyway. It tops up the gas deposit, mUSDC and the merchant allowance, and skips everything else. Keep 0.005 or more Base Sepolia ETH on the deployer.
3. Remember the daily limit is 5 mUSDC per UTC day. The smoke test spends 0.1, so 50 runs a day are fine.
4. Run `forge test` once, so the 187 count is fresh on screen.
5. In every PowerShell window, run `$D = cast wallet address --account deployer`.

**On stage:**

| # | Show | Command | Say |
|---|---|---|---|
| 1 | Tests | `forge test` | "187 tests, 100% coverage of the contracts, including fuzzing and invariants on spending." |
| 2 | Local full flow | in a second window, `anvil`; then `forge script script/H12Demo.s.sol --rpc-url anvil --broadcast` | "Agent request, UserOp, EntryPoint, policy check, merchant payment. Over-limit and revoked agents are blocked. H12: GO." |
| 3 | Live state | `forge script script/Status.s.sol --rpc-url base_sepolia` | "This is Base Sepolia: real EntryPoint v0.7, our wallet, the agent's policy and today's spend." |
| 4 | Live agent purchase | `forge script script/SmokeTest.s.sol --rpc-url base_sepolia --account deployer --sender $D --broadcast --slow` | "The agent signs, the EntryPoint executes, and the merchant records credits. A wrong signer and an over-limit purchase are rejected." Open the transaction on BaseScan. |
| 5 | Owner approval | `$env:APPROVE_CREDITS=150; $env:APPROVE_MAX_PRICE=1500000` then `forge script script/OwnerApprovePurchase.s.sol --rpc-url base_sepolia --account deployer --sender $D` (review), then the same command with `--broadcast --slow` | "1.5 mUSDC is above the agent's 1 mUSDC limit. Only the owner's signature can authorize it, and the agent's limits stay the same." |
| 6 | Result | `forge script script/Status.s.sol --rpc-url base_sepolia` | "Credits went up, and the agent's spentToday counts only the agent's own purchase." |
| 7 | Limits | Section 7 | "What we know isn't covered." |

**Fallback:** if Base Sepolia or the RPC is slow, steps 1 and 2 (local) prove the whole flow on their own.
