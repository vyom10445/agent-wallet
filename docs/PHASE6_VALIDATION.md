# Phase 6: agent authorization and validation

## Signature-validation path (before and after)

**Before (SimpleAccount v0.7.0, unchanged):** `EntryPoint.handleOps` → `_validatePrepayment` → `account.validateUserOp(userOp, userOpHash, missingFunds)`
(`core/BaseAccount.sol:35`) → `_requireFromEntryPoint` → `_validateSignature` (`samples/SimpleAccount.sol:105`):
`ECDSA.recover(toEthSignedMessageHash(userOpHash), userOp.signature) == owner` ? `0` : `1` → `_validateNonce` (empty; the EntryPoint
checks the 2D nonce) → `_payPrefund`. After all ops validate, the EntryPoint calls the wallet with `userOp.callData` as-is.

**After (AgentWallet overrides only `_validateSignature`):**
1. Call `super._validateSignature` (the unchanged SimpleAccount code). If it returns success, return `0` (owner path, identical behaviour and return value).
2. Otherwise the callData must start with `executeAsAgent.selector`, else return `1` (AA24).
3. Decode `executeAsAgent(agent, target, value, data)` from `callData[4:]`.
4. Recover the signer the same way SimpleAccount does. It must equal the decoded `agent`, else `1`.
5. Run the time-independent policy checks (`_agentCallError`): agent active, `value == 0`, target not 0/wallet/EntryPoint,
   `data` has a selector, policy token calls blocked, `(target, selector)` allowlisted. Any failure returns `1`.
6. Return `_packValidationData(false, validUntil, validAfter)`. The EntryPoint enforces the window (AA22), because ERC-7562 forbids
   `TIMESTAMP` in validation.

Only the wallet's own storage is read during validation (allowed for unstaked accounts under ERC-7562).

## UserOperation calldata structure (agent op)

```
PackedUserOperation {
  sender             = wallet
  nonce              = entryPoint.getNonce(wallet, uint192(uint160(agent)))   // key = agent address, owner keeps key 0
  initCode           = ""
  callData           = 0x6151bacc                                              // executeAsAgent(address,address,uint256,bytes)
                       ‖ abi.encode(agent, target, value = 0, data)
                       where data = target selector ‖ args, e.g. Target.ping() or MockMerchant.purchase(credits, payment)
  accountGasLimits   = verificationGasLimit << 128 | callGasLimit
  preVerificationGas, gasFees, paymasterAndData = as usual
  signature          = agent's EIP-191 signature over entryPoint.getUserOpHash(op)  (65 bytes r‖s‖v)
}
```

## Execution path

`executeAsAgent` re-checks everything at execution time (the agent may have been revoked between validation and execution,
or the agent may call it directly from its own EOA):
caller is the EntryPoint or `agent` → `isAgentValid` (uses block.timestamp, fine in execution) → same `_agentCallError` checks →
`_call(target, 0, data)` (inherited) → if the wallet's policy-token balance dropped, revert → emit `AgentExecuted`.

## Bypass items from ACCOUNT_INSPECTION.md

| # | Bypass | Status | Test(s) |
|---|---|---|---|
| B1 | Agent signs `execute` / `executeBatch` | Rejected in validation (AA24) | `test_agentCannotSignExecute`, `test_agentCannotSignExecuteBatch` |
| B2 | Agent signs admin / upgrade / withdraw | Rejected in validation (AA24) | `test_agentCannotSignAdminFunctions` |
| B3 | `executeAsAgent(target = wallet)` | `ForbiddenTarget`, both paths | `test_agentCannotTargetWalletItself` |
| B4 | `executeAsAgent(target = EntryPoint)` | `ForbiddenTarget`, both paths | `test_agentCannotTargetEntryPoint` |
| B5 | approve / pull the policy token | `InvalidTokenCall`; any balance drop reverts | `test_agentCannotApproveOrPullPolicyToken`, `test_allowedCallThatSpendsPolicyTokenReverts` |
| B6 | Native ETH via `value` | `NativeValueNotAllowed` / AA24 | `test_nativeValueRejected` |
| B7 | Acting as another agent | `UnauthorizedCaller` / AA24 | `test_directCallerMustBeTheAgent`, `test_agentCannotSignForAnotherAgent` |
| B8 | Re-added agent inherits old permissions | Epoch counter (Phase 5) | `test_reAddedAgentStartsClean` |
| B9 | Ops pass validation, fail in execution (gas) | Partly mitigated: allowlist/target/value checked in validation too | `test_executionRechecksPolicyAfterValidation` |
| B10 | `executeUserOp` selector | Rejected in validation (AA24) | `test_agentCannotUseExecuteUserOpSelector` |

## Design decisions forced by the account architecture

- `execute` / `executeBatch` are not `virtual` in SimpleAccount v0.7.0, so they cannot be restricted by overriding. Agents are kept
  out of them by binding agent signatures to the `executeAsAgent` selector in `_validateSignature`.
- Daily limits need the current day, which validation cannot read (ERC-7562). They can only be enforced in execution. A failing
  agent op still costs the wallet gas.
- Because MockMerchant pulls payment, spending can happen inside an allowed call. Measuring the policy-token balance around the call is
  the only generic way to account for it without changing the merchant or the account.

## Unresolved concerns

1. **Spending is disabled (fail-closed).** Transfers of the policy token and any call that lowers its balance revert with
   `SpendingNotEnabled` until per-transaction/daily limits and the recipient allowlist are wired into execution (next phase).
2. **Gas griefing.** A valid agent can submit many ops (or ops whose allowed target reverts) and spend the wallet's EntryPoint deposit.
   Mitigations: keep the deposit small, use a paymaster with its own limits, revoke the agent.
3. **Only the policy token is protected.** An allowed call could move other tokens or NFTs the wallet holds if the owner gave the
   target an allowance for them. Owner should not approve anything else to agent-allowlisted contracts.
4. **Agents without a policy token** (`token == address(0)`) have no balance check at all; they can only call allowlisted functions.
5. **Not tested against a real bundler.** ERC-7562 compliance was checked by reading the rules; run once on Base Sepolia with a
   bundler to confirm agent ops are accepted.
6. **Owner powers are unchanged:** the owner can upgrade the wallet (UUPS) and so replace all policy code.
