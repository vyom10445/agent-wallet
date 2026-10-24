# Phase 8: contract integration on Anvil (H12 go/no-go)

**Result: H12 = GO.** The full flow runs on a live Anvil node through EntryPoint v0.7 `handleOps`, and in `forge test`.

```
Agent request ("buy 500 credits")
  → UserOperation   callData = executeAsAgent(agent, merchant, 0, purchase(500, 5_000_000)), signed by the agent key
  → EntryPoint      handleOps, submitted by a separate funded account (no bundler: planned direct handleOps fallback)
  → AgentWallet     _validateSignature: signer == agent, merchant.purchase allowlisted → validUntil/validAfter
  → Restricted execution  executeAsAgent (EntryPoint-only) → _call(merchant, purchase)
  → Merchant payment      merchant.transferFrom(wallet → merchant, 5 mUSDC); wallet meters −5 mUSDC against limits
  → Successful purchase   CreditsPurchased(1, wallet, 500, 5_000_000); AgentSpent(agent, mUSDC, merchant, 5_000_000, 5_000_000)
```

## What was inspected first

- Existing `script/Deploy.s.sol` was a Phase 1 placeholder; `DemoPurchase.s.sol` calls the merchant directly from an EOA (kept as the
  Phase 4 merchant-only demo, **not** used as ERC-4337 evidence).
- No factory for AgentWallet: `SimpleAccountFactory` hard-codes `SimpleAccount`, so `AgentWalletFactory` was added (same code pattern).
- All earlier tests built EntryPoint and wallet by hand; nothing exercised a deployment script.

## New files

| File | Purpose |
|---|---|
| `src/AgentWalletFactory.sol` | CREATE2 proxy factory for AgentWallet (copy of the v0.7.0 SimpleAccountFactory pattern) |
| `script/Deploy.s.sol` | Deterministic deployment: EntryPoint v0.7 (Anvil only; canonical address elsewhere), factory, MockUSDC, MockMerchant, wallet. Idempotent |
| `script/utils/UserOps.sol` | Builds and signs PackedUserOperations like the agent backend will (nonce key = agent address, EIP-191 signature, bundle gas) |
| `script/H12Demo.s.sol` | Live Anvil run of the 10 stages, prints PASS/FAIL and GO/NO-GO, reverts on NO-GO |
| `test/Integration.t.sol` | Same stages as `forge test`, using `Deploy.deploy()` and real `handleOps` |

## Stage results

| # | Stage | forge test | Live Anvil |
|---|---|---|---|
| 1 | Deploy to expected (CREATE2) addresses | PASS (`test_stage1_*`) | PASS |
| – | EntryPoint is v0.7 (ERC-165 id of v0.7 IEntryPoint) | PASS (`test_env_entryPointIsV07`) | PASS |
| – | Signature format: 65-byte r‖s‖v over EIP-191(userOpHash); raw-hash signature rejected | PASS (`test_env_signatureFormat`) | used by every op |
| 2 | Wallet initialized with the owner; re-initialization blocked | PASS | PASS |
| 3 | Agent registered with policy (owner-signed `executeBatch` UserOp) | PASS | PASS |
| 4 | Wallet funded with MockUSDC (+ EntryPoint gas deposit) | PASS | PASS |
| 5 | Agent UserOp executes a permitted purchase through the EntryPoint | PASS | PASS |
| 6 | Merchant records the purchase | PASS | PASS (`creditsOf = 500`, `purchaseCount = 1`) |
| 7 | Token balances and spending counter | PASS | PASS (wallet −5, merchant +5, `spentToday = 5 USDC`) |
| 8 | Over-limit purchase cannot complete | PASS (maxPerTx and daily limit) | PASS (`UserOperationEvent.success = false`, balance unchanged) |
| 9 | Revoked agent cannot purchase | PASS (`FailedOp AA24`) | PASS (simulated: a bundler would drop it, so it is not sent) |
| 10 | Owner execution path still works (UserOp and direct) | PASS | PASS |

`forge test`: **124 passed, 0 failed** (8 suites; `IntegrationTest` 11/11). On-chain check with `cast` after the live run:
owner = Anvil account 0, merchant `creditsOf(wallet) = 500`, wallet 94 mUSDC (100 − 5 purchase − 1 owner transfer), merchant 5 mUSDC,
agent revoked, `UserOperationEvent` success flags: owner config = true, agent purchase = true, over-limit = false.

## First failure found and fixed

The first live run passed every stage in simulation but the **stage 3 transaction failed on-chain** with
`FailedOp(0, "AA95 out of gas")`. Cause: `forge script` sets the transaction gas limit from an estimate of gas actually used
(~405k), but the EntryPoint requires the transaction to carry enough gas for the op's *declared* `verificationGasLimit` +
`callGasLimit` (500k + 500k). Not a contract bug: any submitter (our fallback or a real bundler) must send
`handleOps` with at least `UserOps.bundleGasLimit()` (= verification + call + preVerification + 200k ≈ 1.26M). The demo and the
integration tests now pass that explicit gas limit, so the tests would catch this too. **P-2: do the same in the agent backend.**

## How to run

```bash
cd contracts
forge test --match-contract IntegrationTest -vv
anvil                                                   # terminal 1
forge script script/H12Demo.s.sol --rpc-url anvil --broadcast   # terminal 2
```
The demo uses only Anvil's public dev mnemonic (`test … junk`, accounts 0–3) and refuses to run on any other chain id.

## Notes and limits

- **Anvil EntryPoint is built from the v0.7.0 source** with this repo's compiler settings, so its address is not the canonical
  `0x0000000071727De22E5E9d8BAf0edAc6f37da032`. On Base Sepolia `Deploy` uses the canonical deployment and refuses to deploy its own.
- **No bundler was used.** The direct `handleOps` fallback still goes through full EntryPoint validation and execution; nothing bypasses it.
  A real bundler's ERC-7562 simulation has not been tested yet (Base Sepolia step).
- Remaining security concerns are unchanged from Phase 7 (standing merchant allowance, gas griefing, only the policy token is metered).
