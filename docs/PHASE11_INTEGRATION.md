# Phase 11: Integration package for P-2 (agent backend) and P-3 (frontend)

Everything below comes from the compiled contracts and the actual Base Sepolia deployment. Nothing is guessed.
Every example was run against a local chain. Use the files themselves, not screenshots.

## 0. Deployment status on Base Sepolia

| Step | Status |
|---|---|
| Contracts deployed (factory, implementation, MockUSDC, MockMerchant, wallet) | **Done** |
| Agent registered, policy set, merchant allowlisted (ConfigureAgent) | **Done** |
| Wallet funded (mUSDC), merchant allowance, EntryPoint gas deposit | **Done** |
| Smoke-test purchase (agent UserOp, then EntryPoint, then merchant) | **Done, passed** |

The stack is live and configured, so P-2 and P-3 can integrate against it now. The policy is the ConfigureAgent default unless P-1 changed it: maxPerTx 1 mUSDC, daily 5 mUSDC, valid 7 days.

To check the live state, run `forge script script/Status.s.sol --rpc-url base_sepolia` (read-only), or `node integration/read.mjs` with `AGENT_ADDRESS` set.
If the gas deposit runs low, agent ops fail with `AA21`. Ask P-1 to rerun ConfigureAgent, which tops it up.

## 1. Where the files are

| What | Path |
|---|---|
| AgentWallet ABI (full: agent and policy functions plus SimpleAccount `execute`, `executeBatch`, deposit) | `abi/AgentWallet.json` |
| IAgentWallet ABI (frozen agent and policy interface only) | `abi/IAgentWallet.json` |
| MockUSDC ABI | `abi/MockUSDC.json` |
| MockMerchant ABI | `abi/MockMerchant.json` |
| EntryPoint v0.7 ABI (`handleOps`, `getNonce`, `getUserOpHash`, events, errors) | `abi/EntryPoint.v0.7.0.json` |
| AgentWalletFactory ABI | `abi/AgentWalletFactory.json` |
| Every function selector, event topic and error selector, machine-readable | `abi/selectors.json` |
| Addresses, machine-readable (source of truth) | `contracts/deployments/84532.json` (Base Sepolia), `contracts/deployments/31337.json` (Anvil, written by Deploy) |
| Runnable viem examples | `integration/*.mjs` (see `integration/README.md`) |
| Error and debugging guide | `docs/PHASE11_DEBUGGING.md` |
| Regenerate the ABIs after a contract change | `contracts/export-abi.ps1` (Windows) or `contracts/export-abi.sh` |

## 2. Network and addresses

| | Value |
|---|---|
| Network | Base Sepolia |
| Chain ID | `84532` |
| Public RPC | `https://sepolia.base.org` (rate-limited. Use your own provider URL for heavy use.) |
| Explorer | https://sepolia.basescan.org |
| EntryPoint v0.7 (canonical) | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |
| AgentWallet (smart account, ERC-1967 proxy) | `0x74cD24BBaf39022155d2912923F4dC234D215c1A` |
| Wallet owner (EOA) | `0x815d211D2E85E2C2526f0CC3bB1DEE11513C7b64` |
| AgentWallet implementation | `0xec0de95c6C52d1AECCECde692c422c94987Bc262` |
| AgentWalletFactory | `0xAD5E19b7A292735b79D13e48A854BAf6baC96D51` |
| MockUSDC (`mUSDC`) | `0xC91a11d7096c0685590267C083Fd67A518D65C3F` |
| MockMerchant | `0x8D94CcD748a00C27Cc339aaE3A14F2965E8b4FC1` |
| Agent (session key) | `0xC74Ba823524Cbd1d889b5FD38785b9d293C6D8aD` |

**Token decimals.** mUSDC has **6 decimals**, so `1 mUSDC = 1_000_000` base units. Every amount in the contracts, in events and in this doc is in base units.

**Merchant price.** `pricePerCredit = 10_000`, which is 0.01 mUSDC. `quote(credits) = credits * 10_000`.

**Default policy** (set by ConfigureAgent):
- maxPerTx 1 mUSDC, dailyLimit 5 mUSDC per UTC day, valid for 7 days.
- Merchant allowance 10 mUSDC.
- 100 mUSDC in the wallet.

**Time.** Times are unix seconds (`uint48`). The daily limit resets at 00:00 UTC.

On local Anvil, run `forge script script/Deploy.s.sol --rpc-url anvil --broadcast --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` and read `contracts/deployments/31337.json`.

## 3. Function signatures

### AgentWallet (call at the wallet address)

| Function | Selector | Who can call |
|---|---|---|
| `addAgent(address agent, uint48 validAfter, uint48 validUntil)` | `0xe666ca1a` | owner |
| `setPolicy(address agent, address token, uint256 maxPerTx, uint256 dailyLimit)` | `0xf582b4df` | owner |
| `allowCall(address agent, address target, bytes4 selector, bool allowed)` | `0x6d8c9a37` | owner |
| `allowRecipient(address agent, address recipient, bool allowed)` | `0x7e858821` | owner |
| `revokeAgent(address agent)` | `0x7da6ac0d` | owner |
| `executeAsAgent(address agent, address target, uint256 value, bytes data)` | `0x6151bacc` | **EntryPoint only**, inside an agent-signed UserOp |
| `execute(address dest, uint256 value, bytes func)` | `0xb61d27f6` | owner, or EntryPoint with an owner-signed UserOp |
| `executeBatch(address[] dest, uint256[] value, bytes[] func)` | `0x47e1da2a` | owner, or EntryPoint with an owner-signed UserOp |
| `addDeposit()` payable | `0x4a58db19` | anyone (funds UserOp gas) |
| `withdrawDepositTo(address to, uint256 amount)` | `0x4d44560d` | owner |
| `getAgent(address) returns (AgentInfo)` | `0xfb3551ff` | view |
| `isAgentValid(address) returns (bool)` | `0x86049fc2` | view |
| `isCallAllowed(address agent, address target, bytes4 selector) returns (bool)` | `0x1cf1221c` | view |
| `isRecipientAllowed(address agent, address recipient) returns (bool)` | `0xa6f4899d` | view |
| `remainingDailyAllowance(address) returns (uint256)` | `0x956d1175` | view |
| `owner()`, `entryPoint()`, `getDeposit()`, `getNonce()` | `0x8da5cb5b` `0xb0d691fe` `0xc399ec88` `0xd087d288` | view |

`AgentInfo = (bool active, uint48 validAfter, uint48 validUntil, address token, uint256 maxPerTx, uint256 dailyLimit, uint256 spentToday)`

The owner functions also work through `execute`/`executeBatch` or an owner-signed UserOp, because SimpleAccount's `onlyOwner` accepts the wallet itself.

### MockUSDC

`balanceOf(address)` `0x70a08231` · `allowance(address,address)` `0xdd62ed3e` · `approve(address,uint256)` `0x095ea7b3` · `transfer(address,uint256)` `0xa9059cbb` · `decimals()` `0x313ce567` (returns 6) · `mint(address,uint256)` `0x40c10f19` (open faucet: anyone can mint test tokens).

### MockMerchant

`quote(uint256 credits) returns (uint256)` `0xed1bd76c` · `purchase(uint256 credits, uint256 payment) returns (uint256 purchaseId)` `0x70876c98` · `creditsOf(address) returns (uint256)` `0x245a45b5` · `purchaseCount()` `0x2b85ed9c` · `pricePerCredit()` `0xf3ab90c3` · `token()` `0xfc0c546a`.

`purchase` pulls exactly `quote(credits)` from `msg.sender` (the wallet) with `transferFrom`. It needs `payment == quote(credits)` and an allowance.

## 4. Events

| Emitter | Event | Topic 0 |
|---|---|---|
| wallet | `AgentAdded(address indexed agent, uint48 validAfter, uint48 validUntil)` | `0xbf561bc0…0c92` |
| wallet | `AgentRevoked(address indexed agent)` | `0x1d2ac3af…eba4` |
| wallet | `PolicySet(address indexed agent, address indexed token, uint256 maxPerTx, uint256 dailyLimit)` | `0xbebc4078…0003` |
| wallet | `CallPermissionSet(address indexed agent, address indexed target, bytes4 indexed selector, bool allowed)` | `0x794f6933…98c8` |
| wallet | `RecipientPermissionSet(address indexed agent, address indexed recipient, bool allowed)` | `0x5d7323b7…aab4` |
| wallet | `AgentSpent(address indexed agent, address indexed token, address indexed recipient, uint256 amount, uint256 spentToday)` | `0x0ba88a0f…2125` |
| wallet | `AgentExecuted(address indexed agent, address indexed target, bytes4 indexed selector, uint256 value)` | `0xdaddc454…1cc0` |
| merchant | `CreditsPurchased(uint256 indexed purchaseId, address indexed buyer, uint256 credits, uint256 amountPaid)` | `0x9791971a…6b8e` |
| EntryPoint | `UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)` | in `abi/selectors.json` |
| EntryPoint | `UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)` | in `abi/selectors.json` |

Full 32-byte topics are in `abi/selectors.json`. With viem, pass the ABI and use `parseEventLogs` or `getContractEvents`, so you never handle topics by hand.

What one successful agent purchase emits, in order:
1. `Approval`/`Transfer` (mUSDC)
2. `CreditsPurchased` (merchant)
3. `AgentSpent` (wallet)
4. `AgentExecuted` (wallet)
5. `UserOperationEvent{success: true}` (EntryPoint)

If the op fails during execution, you get `UserOperationRevertReason` and then `UserOperationEvent{success: false}`. The `handleOps` transaction itself still succeeds.

## 5. Example reads

cast (from `contracts/`, works the same in PowerShell):
```bash
cast call 0x74cD24BBaf39022155d2912923F4dC234D215c1A "getAgent(address)((bool,uint48,uint48,address,uint256,uint256,uint256))" 0xC74Ba823524Cbd1d889b5FD38785b9d293C6D8aD --rpc-url base_sepolia
cast call 0x74cD24BBaf39022155d2912923F4dC234D215c1A "remainingDailyAllowance(address)(uint256)" 0xC74Ba823524Cbd1d889b5FD38785b9d293C6D8aD --rpc-url base_sepolia
cast call 0xC91a11d7096c0685590267C083Fd67A518D65C3F "balanceOf(address)(uint256)" 0x74cD24BBaf39022155d2912923F4dC234D215c1A --rpc-url base_sepolia
cast call 0x8D94CcD748a00C27Cc339aaE3A14F2965E8b4FC1 "creditsOf(address)(uint256)" 0x74cD24BBaf39022155d2912923F4dC234D215c1A --rpc-url base_sepolia
```

viem: see `integration/read.mjs`. The core of it:
```js
const info = await publicClient.readContract({ address: addr.wallet, abi: abi.wallet, functionName: "getAgent", args: [agent] });
// info.spentToday is already zero after 00:00 UTC (the view rolls the day over). Display it as is.
```

## 6. Example writes

**Owner policy change** (P-3, signed by the owner's wallet):
```bash
cast send 0x74cD24BBaf39022155d2912923F4dC234D215c1A "setPolicy(address,address,uint256,uint256)" <agent> 0xC91a11d7096c0685590267C083Fd67A518D65C3F 2000000 8000000 --account deployer --rpc-url base_sepolia
```

viem: `integration/owner-configure.mjs`. It simulates, sends, waits for the receipt and parses `PolicySet`. In a browser, use `custom(window.ethereum)` as the transport so the owner signs in their own wallet.

**Agent purchase** (P-2): `integration/agent-purchase.mjs`. Section 7 has the exact format.

**Owner approval of an out-of-policy purchase** (P-3): `integration/owner-approve.mjs` and `script/OwnerApprovePurchase.s.sol`. See section 8.

## 7. UserOperation format for the agent (P-2)

EntryPoint v0.7 **packed** UserOperation, sent to `handleOps`:

| Field | Value for an agent purchase |
|---|---|
| `sender` | the AgentWallet address |
| `nonce` | `EntryPoint.getNonce(wallet, uint192(agentAddress))`. The key **must** be the agent's address. Key 0 belongs to the owner, and an agent op on key 0 is rejected (AA24). |
| `initCode` | `0x` (the wallet already exists) |
| `callData` | `executeAsAgent(agent, merchant, 0, purchase(credits, quote(credits)))`. `agent` must equal the signer, and `value` must be 0. |
| `accountGasLimits` | `bytes32(verificationGasLimit << 128 \| callGasLimit)`. The examples use 500k / 500k. |
| `preVerificationGas` | 60000 in the examples |
| `gasFees` | `bytes32(maxPriorityFeePerGas << 128 \| maxFeePerGas)` |
| `paymasterAndData` | `0x`. There is no paymaster: gas comes from the wallet's EntryPoint deposit. |
| `signature` | 65-byte `r‖s‖v` from `personal_sign` (EIP-191) over `EntryPoint.getUserOpHash(op)`. In viem: `account.signMessage({ message: { raw: userOpHash } })` |

`getUserOpHash` already includes the EntryPoint address and the chain ID, so a signature for Anvil never works on Base Sepolia.

**Submitting.** The tested path has no bundler. A funded EOA calls `handleOps([op], beneficiary)` with gas of at least `verification + call + preVerification + 200k` (1.26M here), otherwise you get AA95.
- `integration/lib.mjs` → `submitUserOp()` simulates first, which surfaces `FailedOp` reasons, then sends.
- It returns `UserOperationEvent.success` together with the decoded revert reason.

**Using a bundler** (Pimlico, Alchemy and others: untested here). Use the v0.7 *unpacked* RPC format:
- Send `callGasLimit`, `verificationGasLimit`, `maxFeePerGas`, `maxPriorityFeePerGas`, and `factory`/`factoryData` as null.
- Use EntryPoint `0x0000000071727De22E5E9d8BAf0edAc6f37da032`.
- For `eth_estimateUserOperationGas`, use this well-formed dummy signature. It fails softly instead of reverting, and the test suite covers it:
  `0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798` + `0000000000000000000000000000000000000000000000000000000000000001` + `1b`
- Some bundlers reject ops whose validation reads other contracts' storage. The agent validation reads only the wallet's own storage.

## 8. Owner approval flow (Step 11.3)

When the agent wants something outside its policy (for example, above maxPerTx), it must ask the owner. **A request stored in SQLite is only a proposal. The on-chain authorization is a transaction the owner signs.**

1. The agent backend stores a request such as `{credits, reason}`. It cannot execute it: the agent key can only sign `executeAsAgent`, and that path enforces the policy.
2. The frontend rebuilds the purchase from **on-chain** data (`quote(credits)`, current allowance), not from the agent's numbers. It then shows the owner the decoded calls, the price in mUSDC and the owner's own max price.
3. The owner explicitly signs `wallet.executeBatch` with the **owner** key. Two options:
   - a direct transaction from the owner EOA, or
   - an owner-signed UserOp on nonce key 0.

   The batch contains:
   - `mUSDC.approve(merchant, standingAllowance + price)`
   - `merchant.purchase(credits, price)`, after which the allowance is back to the standing value
4. The result is recorded: `CreditsPurchased(buyer = wallet)` and `creditsOf(wallet)` increase. The agent's `spentToday` and policy don't change, because this is an owner purchase and not an agent spend.

What the tests prove (`contracts/test/OwnerApproval.t.sol`, 8 tests):
- The agent's own out-of-policy purchase moves no funds.
- The owner path works both as a UserOp and as a direct transaction.
- The owner's signature binds the exact calldata: changing the credits after signing gives AA24.
- The agent can't sign or call the owner batch.
- The agent can't raise its own limits, allowlist new calls, add agents or change token approvals (all AA24).
- A wrong price rolls back the whole batch.
- The policy is still enforced after an approval.

Command line (P-1/owner): `APPROVE_CREDITS=1500 APPROVE_MAX_PRICE=15000000 forge script script/OwnerApprovePurchase.s.sol --rpc-url base_sepolia --account deployer --sender <owner>`. Run it once without `--broadcast` to review, then add `--broadcast`. It refuses if the quote exceeds the owner's max.

## 9. Frontend notes (P-3)

- **Spending counter.** Show `getAgent(agent).spentToday` and `remainingDailyAllowance(agent)` exactly as returned. Both already reset at 00:00 UTC without any transaction, so don't add a client-side reset. Format them with 6 decimals.
- **Validity.** Use `isAgentValid(agent)`. `validUntil` is a unix timestamp in seconds.
- **Transaction results.** For owner transactions, `receipt.status` is enough. For UserOps, a mined `handleOps` transaction is **not** proof of success. Read `UserOperationEvent.success` for your `userOpHash`, and if it is false, decode `UserOperationRevertReason.revertReason` with the combined ABIs (`readOpResult()` in `integration/lib.mjs`).
- **Event feed.** See `integration/events.mjs`. The UserOp nonce splits into the key (`nonce >> 64`, which equals the agent address for agent ops and 0 for the owner) and the sequence (`nonce & (2^64-1)`).
