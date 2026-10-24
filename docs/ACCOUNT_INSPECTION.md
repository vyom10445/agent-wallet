# Phase 2: SimpleAccount and EntryPoint v0.7 inspection

Inspected on 2026-10-24. Nothing here was modified; AgentWallet is not implemented yet.

## Exact versions inspected

| Dependency | Version | Commit | Path |
|---|---|---|---|
| eth-infinitism/account-abstraction | v0.7.0 | 7af70c8993a6f42973f520ae0752386a5032abe7 | `contracts/lib/account-abstraction` |
| OpenZeppelin contracts | v5.0.2 | dbb6104ce834628e473d2173bbc9d47f81a9eec3 | `contracts/lib/openzeppelin-contracts` |
| solc | 0.8.23 | | `contracts/foundry.toml` |

**EntryPoint version confirmed: v0.7.** `EntryPoint.sol` at this tag uses `PackedUserOperation`
and `IAccountExecute` (`core/EntryPoint.sol:7`, `:101`), which only exist from v0.7.
Canonical address on Base Sepolia: `0x0000000071727De22E5E9d8BAf0edAc6f37da032`
(not checked on-chain from the build sandbox; `forge script script/Deploy.s.sol --rpc-url base_sepolia` prints whether code exists there).

Paths below are relative to `contracts/lib/account-abstraction/contracts/` unless they start with `oz/`
(= `contracts/lib/openzeppelin-contracts/contracts/`).

---

## 1. Inheritance structure

```
SimpleAccount                                   samples/SimpleAccount.sol:22
├── BaseAccount (abstract)                      core/BaseAccount.sol:16
│   └── IAccount                                interfaces/IAccount.sol:6
├── TokenCallbackHandler (abstract)             samples/callback/TokenCallbackHandler.sol:14
│   ├── IERC721Receiver
│   └── IERC1155Receiver (→ IERC165)
├── UUPSUpgradeable (abstract, OZ 5.0.2)        oz/proxy/utils/UUPSUpgradeable.sol
│   └── IERC1822Proxiable
└── Initializable (abstract, OZ 5.0.2)          oz/proxy/utils/Initializable.sol
```

Storage: `address public owner` (`SimpleAccount.sol:23`); `IEntryPoint private immutable _entryPoint` (`:25`, in bytecode, not storage).
Accounts are deployed as ERC1967 proxies by `SimpleAccountFactory` (`samples/SimpleAccountFactory.sol:34`), which hard-codes
`new SimpleAccount(_entryPoint)` as the implementation (`:19`). **AgentWallet needs its own factory** following the same pattern.

## 2. Relevant functions and visibility

| Function | Defined at | Visibility | virtual? | Access |
|---|---|---|---|---|
| `validateUserOp(PackedUserOperation,bytes32,uint256)` | `core/BaseAccount.sol:35` | external | **yes** | EntryPoint only (`_requireFromEntryPoint`) |
| `_validateSignature(...)` | `samples/SimpleAccount.sol:105` | internal | **yes** | n/a |
| `_validateNonce(uint256)` | `core/BaseAccount.sol:91` | internal view | **yes** (empty) | n/a |
| `_payPrefund(uint256)` | `core/BaseAccount.sol:103` | internal | **yes** | n/a |
| `_requireFromEntryPoint()` | `core/BaseAccount.sol:49` | internal view | yes | |
| `execute(address,uint256,bytes)` | `samples/SimpleAccount.sol:58` | external | **no** | owner or EntryPoint |
| `executeBatch(address[],uint256[],bytes[])` | `samples/SimpleAccount.sol:70` | external | **no** | owner or EntryPoint |
| `_requireFromEntryPointOrOwner()` | `samples/SimpleAccount.sol:100` | internal view | no | |
| `_onlyOwner()` / `onlyOwner` | `samples/SimpleAccount.sol:47`, `:29` | internal view | no | `owner` **or `address(this)`** |
| `_call(address,uint256,bytes)` | `samples/SimpleAccount.sol:113` | internal | no | bubbles revert data |
| `initialize(address)` | `samples/SimpleAccount.sol:90` | public | yes | `initializer` (once, proxy only) |
| `_initialize(address)` | `samples/SimpleAccount.sol:94` | internal | yes | |
| `entryPoint()` | `samples/SimpleAccount.sol:35` | public view | yes | |
| `getNonce()` | `core/BaseAccount.sol:24` | public view | yes | key 0 only |
| `getDeposit()` / `addDeposit()` | `samples/SimpleAccount.sol:125`, `:132` | public | no | anyone (`addDeposit` is payable) |
| `withdrawDepositTo(address,uint256)` | `samples/SimpleAccount.sol:141` | public | no | `onlyOwner` |
| `_authorizeUpgrade(address)` | `samples/SimpleAccount.sol:145` | internal view | **no** (override, not virtual) | `_onlyOwner` |
| `upgradeToAndCall(address,bytes)` | `oz/proxy/utils/UUPSUpgradeable.sol:86` | public payable | yes | `onlyProxy` + `_authorizeUpgrade` |
| `receive()` | `samples/SimpleAccount.sol:40` | external payable | no | anyone |
| `onERC721Received`, `onERC1155Received`, `onERC1155BatchReceived`, `supportsInterface` | `samples/callback/TokenCallbackHandler.sol:16,25,35,45` | external | `supportsInterface` only | anyone (pure) |

## 3. How `validateUserOp` works in this version

`core/BaseAccount.sol:35-44`:

1. `_requireFromEntryPoint()`: reverts unless `msg.sender == entryPoint()`.
2. `validationData = _validateSignature(userOp, userOpHash)`. SimpleAccount (`SimpleAccount.sol:105-111`) does
   `ECDSA.recover(toEthSignedMessageHash(userOpHash), userOp.signature)` and returns `SIG_VALIDATION_FAILED` (1)
   if the signer is not `owner`, else `SIG_VALIDATION_SUCCESS` (0). It returns no time range.
   `ECDSA.recover` **reverts** on a malformed signature (wrong length, invalid `s`), which the EntryPoint reports as `AA23 reverted`.
3. `_validateNonce(userOp.nonce)`: empty. The EntryPoint itself enforces nonce uniqueness after validation
   (`core/EntryPoint.sol:650`, `core/NonceManager.sol:36-41`): nonce = `key (192 bits) << 64 | seq (64 bits)`, one sequence per key.
4. `_payPrefund(missingAccountFunds)`: sends ETH to the EntryPoint if the deposit is short.

`userOpHash` = `keccak256(abi.encode(userOp.hash(), entryPoint, chainid))` (`core/EntryPoint.sol:363-368`), so signatures
are bound to this EntryPoint and chain. Signers sign it with EIP-191 `personal_sign`.

The return value packs `aggregator|sigFailed (160 bits) | validUntil (48) | validAfter (48)` (`core/Helpers.sol:74-84`).
The EntryPoint checks the time range itself (`core/EntryPoint.sol:597-606`) and rejects with `AA22 expired or not due`,
or `AA24 signature error` when sigFailed is set.

## 4. How owner-authorized execution works

Two paths, both ending in `_call(dest, value, data)` (`SimpleAccount.sol:113`), a plain `call` that bubbles the revert:

- **Direct:** the owner EOA calls `execute` / `executeBatch`. `_requireFromEntryPointOrOwner` (`:100`) accepts `msg.sender == owner`.
- **Via ERC-4337:** an owner-signed UserOp passes `validateUserOp`; the EntryPoint then calls `execute` with `msg.sender == entryPoint`.

`onlyOwner` functions (`withdrawDepositTo`, `_authorizeUpgrade`) accept `owner` **or `address(this)`** (`:47-50`), so the
owner reaches them through a UserOp as `execute(address(this), 0, abi.encodeCall(...))`.

## 5. How the EntryPoint invokes account execution

`handleOps` → `_validatePrepayment` (validation phase, `core/EntryPoint.sol:616`) for every op, then `_executeUserOp` per op (`:76`):

- If `userOp.callData` starts with `IAccountExecute.executeUserOp.selector`, the EntryPoint calls
  `executeUserOp(userOp, userOpHash)` on the account (`:101-103`). **SimpleAccount does not implement this**, and has no fallback,
  so such ops revert in execution.
- Otherwise it calls the account with `userOp.callData` as-is (`:106`, `innerHandleOp` → `Exec.call(sender, 0, callData, callGasLimit)` at `:341`).

So **the account executes whatever function the signed `callData` selects**, with `msg.sender == entryPoint`. A revert in
execution does not undo validation: gas is still charged to the account's deposit (`UserOperationRevertReason`, `:343-352`).

## 6. Inherited execution methods

- `execute(address,uint256,bytes)` (`SimpleAccount.sol:58`)
- `executeBatch(address[],uint256[],bytes[])` (`:70`)
- `upgradeToAndCall(address,bytes)` (`oz/proxy/utils/UUPSUpgradeable.sol:86`): can delegatecall arbitrary code in the new implementation.
- `withdrawDepositTo(address,uint256)` (`SimpleAccount.sol:141`): moves the EntryPoint deposit.
- `receive()` and the token callbacks only receive, they do not execute.

## 7. What can be overridden

Overridable (`virtual`): `validateUserOp`, `_validateSignature`, `_validateNonce`, `_payPrefund`, `_requireFromEntryPoint`,
`entryPoint`, `getNonce`, `initialize`, `_initialize`, `upgradeToAndCall`, `proxiableUUID`, `supportsInterface`.

**Not** overridable: `execute`, `executeBatch`, `_call`, `_onlyOwner`, `_requireFromEntryPointOrOwner`, `withdrawDepositTo`,
`_authorizeUpgrade` (declared `override` without `virtual`), `getDeposit`, `addDeposit`, `receive`.

Consequence: we cannot change what `execute` / `executeBatch` accept. Agent restrictions must be enforced by (a) a new function,
`executeAsAgent`, and (b) an override of `_validateSignature` that only accepts an agent signature when the UserOp calls `executeAsAgent`.

## 8. Can the intended restrictions be bypassed through inherited functions?

Yes, unless each of these is closed. The recommended design closes all of them; Phase 3 must have a test for each.

| # | Bypass | Why it works in the base code | Required mitigation |
|---|---|---|---|
| B1 | Agent signs a UserOp whose callData is `execute` / `executeBatch` | EntryPoint calls whatever callData selects (§5); `execute` accepts the EntryPoint | `_validateSignature`: an agent signature is valid **only** if `callData` selector is `executeAsAgent` **and** the encoded `agent` argument equals the recovered signer. Everything else returns `SIG_VALIDATION_FAILED`. |
| B2 | Agent signs `upgradeToAndCall` / `withdrawDepositTo` / admin functions | Same as B1 | Same selector check as B1 |
| B3 | `executeAsAgent(target = wallet itself, ...)` | `onlyOwner` accepts `msg.sender == address(this)` (`SimpleAccount.sol:49`), so a self-call reaches `withdrawDepositTo`, `upgradeToAndCall` and every `onlyOwner` admin function | Revert `ForbiddenTarget` when `target == address(this)` |
| B4 | `executeAsAgent(target = EntryPoint, ...)` | The account could call `withdrawTo` (drains its deposit, `core/StakeManager.sol:134`), `incrementNonce` (nonce griefing, `core/NonceManager.sol:26`), `addStake` | Revert `ForbiddenTarget` when `target == entryPoint()` |
| B5 | Agent calls `approve` / `increaseAllowance` / `transferFrom` on the policy token | An allowance lets a third party pull funds later, outside the spend counters | Calls to the policy token accept **only** `transfer(address,uint256)` with exact 68-byte calldata; anything else reverts `InvalidTokenCall`. `allowCall` entries for the policy token are ignored. |
| B6 | Agent sends native ETH via `value` | ETH is not covered by the token limits | Revert `NativeValueNotAllowed` when `value != 0` |
| B7 | Agent calls `executeAsAgent` passing another agent's address | Direct calls don't go through signature validation | Direct path requires `msg.sender == agent`; EntryPoint path is bound by B1's signer check |
| B8 | Revoked agent re-added inherits old allowlists | Mappings are not cleared by `delete` of a struct | Key permissions by a per-agent generation counter that `revokeAgent` increments |
| B9 | Agent's ops pass validation, then fail in execution (limit exceeded) | Validation can't check daily limits without `TIMESTAMP` (see §9), so gas is still charged | Accepted risk for the hackathon. Cheap mitigation: also check `maxPerTx` and `isAgentActive` in validation (no timestamp needed). Owner can revoke. |
| B10 | Ops with the `executeUserOp` selector | EntryPoint routes them to `executeUserOp` (§5) | Not implemented by SimpleAccount → reverts; B1's selector check rejects them anyway |

Not bypasses: `addDeposit` and `receive` (anyone can add funds), token callbacks (pure), `initialize` (one-time,
`_disableInitializers` in constructor `SimpleAccount.sol:44`).

## 9. ERC-4337 / ERC-7562 validation rules that affect the design

Applies to code that runs inside `validateUserOp` (bundlers simulate and drop ops that break these):

- **No `TIMESTAMP`, `NUMBER`, `BLOCKHASH`, `GASPRICE`, `BALANCE`, `SELFBALANCE`, `ORIGIN`, `COINBASE`, `CREATE`, etc.** in validation.
  So agent validity windows must be returned as `validAfter`/`validUntil` in `validationData` (`core/Helpers.sol:74`),
  and daily-limit checks (which need the current day) must happen in **execution**, inside `executeAsAgent`. See also the
  comment in `core/BaseAccount.sol:68`.
- **Storage:** an unstaked account may read/write its **own** storage and storage "associated" with it in other contracts.
  Agent records live in the wallet's own storage, so reading them in validation is allowed. Don't read the token or other contracts' state in validation.
- **Signature failure must return 1, not revert** (`interfaces/IAccount.sol:10-12`). Keep using the base `ECDSA.recover`
  behaviour (reverts only on malformed signatures, same as SimpleAccount) and return `SIG_VALIDATION_FAILED` for wrong signers.
- **Gas:** validation must stay under `verificationGasLimit` (`AA26`, `core/EntryPoint.sol:654-657`). Decoding the
  `executeAsAgent` header and two `SLOAD`s is cheap.
- **Nonces:** the EntryPoint supports 2D nonces (`core/NonceManager.sol:17-41`). Recommend agents use
  `key = uint192(uint160(agent))` so agent ops never block the owner's key-0 sequence. `getNonce()` only reads key 0; use
  `entryPoint.getNonce(wallet, key)` for agents.

---

## Recommendation: the smallest safe extension

```solidity
contract AgentWallet is SimpleAccount, IAgentWallet {
    constructor(IEntryPoint ep) SimpleAccount(ep) {}

    // + agent storage (own storage only), keyed by agent and generation
    // + admin functions: onlyOwner (inherited modifier)
    // + executeAsAgent: caller check, B3-B6 checks, spend rules, then inherited _call(target, 0, data)
    // + override _validateSignature:
    //     signer == owner           -> SIG_VALIDATION_SUCCESS               (unchanged behaviour)
    //     signer is active agent
    //       && selector == executeAsAgent
    //       && decoded agent == signer -> _packValidationData(false, validUntil, validAfter)
    //     otherwise                -> SIG_VALIDATION_FAILED
}
```

Plus `AgentWalletFactory`, a copy of `SimpleAccountFactory` that uses `AgentWallet` as the implementation.

Kept unchanged: owner signature scheme, `validateUserOp` flow, nonce handling (EntryPoint), prefund, `execute`/`executeBatch`,
UUPS upgrade path, `initialize`. Only **one** virtual hook (`_validateSignature`) is overridden. No API used here is absent
from v0.7.0 / OZ 5.0.2: `_packValidationData(bool,uint48,uint48)` and `SIG_VALIDATION_*` are in `core/Helpers.sol`.
