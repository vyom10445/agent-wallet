# AgentWallet interface (draft for H2 freeze)

**Status:** DRAFT. Needs sign-off from P-1 (contracts), P-2 (agent) and P-3 (frontend). After sign-off, any change needs all three.
**Source of truth:** `contracts/src/interfaces/IAgentWallet.sol`. ABI: `abi/IAgentWallet.json` (agent functions) and
`abi/SimpleAccount.v0.7.0.json` (inherited functions). `test/InterfaceFreeze.t.sol` fails if a signature changes.

## Basics

- AgentWallet = eth-infinitism **SimpleAccount v0.7.0** + an agent-permission layer. One owner, many agents.
- **EntryPoint v0.7.** Base Sepolia (84532): `0x0000000071727De22E5E9d8BAf0edAc6f37da032`. Local Anvil: deployed by our script (address TBD).
- **Amounts** are token base units. MockUSDC has **6 decimals**: `1 USDC = 1_000_000`, `$0.25 = 250_000`.
- **Times** are unix seconds (`uint48`). The daily limit resets at **00:00 UTC** (`block.timestamp / 86400`).
- **Signatures** (owner and agents): EIP-191 `personal_sign` over `entryPoint.getUserOpHash(userOp)`. Same as SimpleAccount.

## Deployment addresses

| Contract | Anvil (31337) | Base Sepolia (84532) |
|---|---|---|
| EntryPoint v0.7 | TBD (deployed by script) | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |
| AgentWalletFactory | TBD | TBD |
| MockUSDC | TBD | TBD |
| MockMerchant | TBD | TBD |

## Authorization rules

| Who | Can call |
|---|---|
| Owner EOA, directly | `execute`, `executeBatch`, all admin functions, `withdrawDepositTo`, `upgradeToAndCall` |
| Owner, via UserOp | `execute` / `executeBatch` directly; admin functions as `execute(wallet, 0, abi.encodeCall(addAgent, ...))` |
| Agent, directly (agent pays gas) | `executeAsAgent(agent = itself, ...)` only |
| Agent, via UserOp (signed by agent) | UserOp `callData` must be `executeAsAgent(agent = signer, ...)`. Any other callData is rejected in validation |
| Anyone | read functions, `addDeposit`, sending ETH/tokens to the wallet |

An agent can never: call the wallet itself or the EntryPoint, send ETH (`value` must be 0), call `approve`/`transferFrom`
on its policy token, or act outside `[validAfter, validUntil]` or after `revokeAgent`.

## Administrative functions (owner only)

| Function | Parameters |
|---|---|
| `addAgent(address agent, uint48 validAfter, uint48 validUntil)` | `agent`: the agent's signing address (not 0, not owner, not wallet). Window is inclusive. Starts with no policy and no permissions. Reverts `AgentAlreadyActive`, `InvalidAgent`, `InvalidValidityWindow`. |
| `setPolicy(address agent, address token, uint256 maxPerTx, uint256 dailyLimit)` | `token`: the one ERC20 the agent may spend (MockUSDC). `maxPerTx`, `dailyLimit` in base units. |
| `allowCall(address agent, address target, bytes4 selector, bool allowed)` | Allow a **non-spending** call, e.g. `MockMerchant.someFunction.selector`. Ignored for the policy token. |
| `allowRecipient(address agent, address recipient, bool allowed)` | Allow a destination for the agent's `transfer`s (e.g. the merchant). |
| `revokeAgent(address agent)` | Immediate. Clears policy, permissions and counters. Re-adding starts fresh. |

## Execution

| Function | Rules |
|---|---|
| `execute(address dest, uint256 value, bytes func)` | Inherited from SimpleAccount, unchanged. Owner or EntryPoint. |
| `executeBatch(address[] dest, uint256[] value, bytes[] func)` | Inherited, unchanged. Owner or EntryPoint. |
| `executeAsAgent(address agent, address target, uint256 value, bytes data)` | Caller = EntryPoint (UserOp signed by `agent`) or `agent` itself. Agent must be valid. `value == 0`. `target` ≠ wallet, ≠ EntryPoint. **If `target` == policy token:** `data` must be `transfer(recipient, amount)`, recipient allowed, `amount <= maxPerTx`, `amount <= remainingDailyAllowance`. **Otherwise:** `(target, selector)` must be allowed. |

**Paying a merchant (the main flow for P-2):**

```
data     = abi.encodeCall(IERC20.transfer, (merchant, 2_500_000))       // 2.50 USDC
callData = abi.encodeCall(IAgentWallet.executeAsAgent, (agent, usdc, 0, data))
userOp.nonce = entryPoint.getNonce(wallet, uint192(uint160(agent)))      // agent's own nonce key
userOp.signature = agentKey.signMessage(entryPoint.getUserOpHash(userOp))
```

## Read functions

| Function | Returns |
|---|---|
| `getAgent(address agent)` | `AgentInfo { bool active; uint48 validAfter; uint48 validUntil; address token; uint256 maxPerTx; uint256 dailyLimit; uint256 spentToday; }` (`spentToday` is 0 on a new UTC day) |
| `isAgentValid(address agent)` | `active && validAfter <= now <= validUntil` |
| `isCallAllowed(address agent, address target, bytes4 selector)` | bool |
| `isRecipientAllowed(address agent, address recipient)` | bool |
| `remainingDailyAllowance(address agent)` | `dailyLimit - spentToday`, 0 if agent not valid |
| `owner()`, `entryPoint()`, `getNonce()`, `getDeposit()` | Inherited. `getNonce()` is key 0 (owner); agents use `entryPoint.getNonce(wallet, key)` |

There is no on-chain list of all agents or allowed targets. The frontend builds those lists from the events below.

## Events

| Event | When |
|---|---|
| `AgentAdded(address indexed agent, uint48 validAfter, uint48 validUntil)` | `addAgent` |
| `PolicySet(address indexed agent, address indexed token, uint256 maxPerTx, uint256 dailyLimit)` | `setPolicy` |
| `CallPermissionSet(address indexed agent, address indexed target, bytes4 indexed selector, bool allowed)` | `allowCall` |
| `RecipientPermissionSet(address indexed agent, address indexed recipient, bool allowed)` | `allowRecipient` |
| `AgentRevoked(address indexed agent)` | `revokeAgent` |
| `AgentSpent(address indexed agent, address indexed token, address indexed recipient, uint256 amount, uint256 spentToday)` | successful agent token transfer |
| `AgentExecuted(address indexed agent, address indexed target, bytes4 indexed selector, uint256 value)` | every successful `executeAsAgent` |
| `SimpleAccountInitialized(address indexed entryPoint, address indexed owner)` | inherited, on wallet creation |
| `Upgraded(address indexed implementation)` | inherited (OZ ERC1967), on upgrade |

## Errors

`InvalidAgent(address)`, `AgentAlreadyActive(address)`, `AgentNotValid(address)`, `InvalidValidityWindow(uint48,uint48)`,
`UnauthorizedCaller(address)`, `ForbiddenTarget(address)`, `NativeValueNotAllowed(uint256)`,
`CallNotAllowed(address,address,bytes4)`, `RecipientNotAllowed(address,address)`, `InvalidTokenCall(bytes4)`,
`ExceedsPerTxLimit(uint256,uint256)`, `ExceedsDailyLimit(uint256,uint256)`.
Inherited SimpleAccount checks still use `require` strings (`"account: not Owner or EntryPoint"`, `"only owner"`).

## Open questions for P-2 / P-3

1. One spend token per agent (MockUSDC) is enough for the demo?
2. Agents sending via UserOps (needs a bundler/paymaster on Base Sepolia) or directly from the agent EOA (needs ETH for gas)? Both are supported.
3. Is a UTC-day limit acceptable, or do you need a rolling 24h window?
