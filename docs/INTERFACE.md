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
| Agent, via UserOp (signed by agent) | UserOp `callData` must be `executeAsAgent(agent = signer, ...)`. Any other callData is rejected in validation. This is the **only** way an agent can act (Phase 7): direct calls to `executeAsAgent` revert, and owner-signed `executeAsAgent` ops are rejected |
| Anyone | read functions, `addDeposit`, sending ETH/tokens to the wallet |

An agent can never: call the wallet itself or the EntryPoint, send ETH (`value` must be 0), call `approve`/`transferFrom`
on its policy token, or act outside `[validAfter, validUntil]` or after `revokeAgent`.

## Administrative functions (owner only)

| Function | Parameters |
|---|---|
| `addAgent(address agent, uint48 validAfter, uint48 validUntil)` | `agent`: the agent's signing address (not 0, not owner, not wallet). Window is inclusive. Starts with no policy and no permissions. Reverts `AgentAlreadyActive`, `InvalidAgent`, `InvalidValidityWindow`. |
| `setPolicy(address agent, address token, uint256 maxPerTx, uint256 dailyLimit)` | `token`: the one ERC20 the agent may spend (MockUSDC). `maxPerTx`, `dailyLimit` in base units. |
| `allowCall(address agent, address target, bytes4 selector, bool allowed)` | Allow a call such as `MockMerchant.purchase`. Ignored for the policy token. Any policy-token decrease it causes counts against the agent's limits (see below). |
| `allowRecipient(address agent, address recipient, bool allowed)` | Allow a destination for the agent's `transfer`s (e.g. the merchant). |
| `revokeAgent(address agent)` | Immediate. Clears policy, permissions and counters. Re-adding starts fresh. |

## Execution

| Function | Rules |
|---|---|
| `execute(address dest, uint256 value, bytes func)` | Inherited from SimpleAccount, unchanged. Owner or EntryPoint. |
| `executeBatch(address[] dest, uint256[] value, bytes[] func)` | Inherited, unchanged. Owner or EntryPoint. |
| `executeAsAgent(address agent, address target, uint256 value, bytes data)` | Caller = EntryPoint only (UserOp signed by `agent`). Agent must be valid. `value == 0`. `target` ≠ wallet, ≠ EntryPoint. **If `target` == policy token:** `data` must be `transfer(recipient, amount)`, recipient allowed, `amount <= maxPerTx`, `amount <= remainingDailyAllowance`. **Otherwise:** `(target, selector)` must be allowed. **Always:** the wallet's policy-token balance is measured before and after; any decrease is checked against `maxPerTx` and the daily limit and, for non-token targets, the target must be an allowed recipient. |

**Paying a merchant (the main flow for P-2).** MockMerchant pulls payment with `transferFrom` (see "MockMerchant" below):

```
// once, by the owner (agents cannot approve): cap what the merchant may pull
owner: wallet.execute(usdc, 0, abi.encodeCall(IERC20.approve, (merchant, 20_000_000)))   // 20 USDC
owner: wallet.allowCall(agent, merchant, MockMerchant.purchase.selector, true)
owner: wallet.allowRecipient(agent, merchant, true)                     // merchant is the payee

// each purchase, by the agent
cost     = merchant.quote(500)                                            // 5_000_000 = 5 USDC
callData = abi.encodeCall(IAgentWallet.executeAsAgent,
             (agent, merchant, 0, abi.encodeCall(MockMerchant.purchase, (500, cost))))
userOp.nonce = entryPoint.getNonce(wallet, uint192(uint160(agent)))      // agent's own nonce key
userOp.signature = agentKey.signMessage(entryPoint.getUserOpHash(userOp))
```

Plain transfers to an allowed recipient still work: `executeAsAgent(agent, usdc, 0, transfer(recipient, amount))`.

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

## MockMerchant (API-credit store)

| Item | Definition |
|---|---|
| `constructor(IERC20 token, uint256 pricePerCredit)` | Demo: MockUSDC, `10_000` (0.01 USDC per credit) |
| `quote(uint256 credits) view returns (uint256)` | `credits * pricePerCredit`, in base units |
| `purchase(uint256 credits, uint256 payment) returns (uint256 purchaseId)` | Pulls exactly `payment` from `msg.sender` via `transferFrom`. Reverts `IncorrectPayment(expected, provided)` if `payment != quote(credits)`, `ZeroCredits()` if `credits == 0`. Ids start at 1. |
| `creditsOf(address buyer) view returns (uint256)` | Total credits bought |
| `purchaseCount() view returns (uint256)` | Last purchase id |
| `token()`, `pricePerCredit()` | Immutable config |
| `event CreditsPurchased(uint256 indexed purchaseId, address indexed buyer, uint256 credits, uint256 amountPaid)` | One per successful purchase |

**Pull (allowance) vs push (direct transfer).** The merchant **pulls** with `transferFrom(msg.sender, merchant, payment)`.
A push design (buyer transfers first, then claims credits) can't link a plain ERC20 transfer to a buyer and order without
two calls, and `executeAsAgent` makes one call. ERC-1363 `transferAndCall` would fix that but is not in OZ 5.0.2.

Security implications of pull:
- **Standing allowance is spendable without the agent.** Whatever the wallet approves, the merchant contract can pull at any time.
  Mitigations: only the owner can approve (agents are blocked from `approve`, bypass B5); approve small caps; the merchant
  only ever pulls from `msg.sender`, never an arbitrary `from`, so nobody else can use the wallet's allowance through it (tested).
- **Agent limits must still apply.** `purchase` is reached through `allowCall`, not the token `transfer` path, so the
  AgentWallet must measure the policy token balance before and after every agent call and count the decrease against
  `maxPerTx` and the daily limit (reverting if exceeded). This catches allowance-based spending generically, not just this merchant.
- **Exact amount.** The buyer states `payment`; a mismatch reverts, so a price change can't make it pay more than it signed.
- **Atomic.** If the transfer fails (no allowance, low balance, token returns false) the whole call reverts and no credits or
  purchase id are recorded (tested). `SafeERC20` handles tokens that return `false`.

## Open questions for P-2 / P-3

1. One spend token per agent (MockUSDC) is enough for the demo?
2. ~~UserOps or direct calls?~~ Decided in Phase 7: UserOps through the EntryPoint only (needs a bundler on Base Sepolia, or the agent backend calls `handleOps` itself).
3. Is a UTC-day limit acceptable, or do you need a rolling 24h window?
4. ~~Pull-based limits?~~ Implemented in Phase 7: the balance change during `executeAsAgent` is what counts. For a purchase, also call `allowRecipient(agent, merchant, true)`.
