# Phase 11: backend security suite

Run on Anvil (Deploy + ConfigureAgent with agent = Anvil #1, as in the H12 runbook's fallback section):

```powershell
cd agent-wallet\backend
npm run test:security     # test/security.anvil.test.mjs + test/security-secrets.anvil.test.mjs (17 tests)
npm run test:anvil        # everything, 107 tests
```

All tests pass; none is skipped. Every test runs inside `evm_snapshot` / `evm_revert`. In the tests the model is a
script that obeys every injected instruction (the worst case), so what is tested is the code and the contract, not
the model's good behaviour.

## The nine requirements

| # | Requirement | Tests (`security.anvil.test.mjs` unless noted) |
|---|---|---|
| 1 | Prompt injection in the user message, a merchant response, a chain-read string | `1a` user message (fake system/tool text, address); `1d` injection riding on a real buy request: exactly one purchase inside maxPerTx, no policy change; `1b` merchant revert text with instructions and an address; `1c` RPC/chain error string with instructions, plus a real `Error(string)` revert decoded |
| 2 | Agent raising its limit, adding a recipient, approving its own request | `2a` model calls `set_policy`, `allow_recipient`, `approve_request`, `verify_approval`, `add_agent`, extra fields: all `INVALID_INPUT`; fallback refuses; `2b` the agent key signing `setPolicy`, `allowRecipient`, `addAgent`, `usdc.transfer/approve`, `value != 0`, `executeBatch`: all AA24 at validation; `2c` the agent's own purchase cannot verify its pending owner request (`NOT_OWNER_TX`) |
| 3 | Negative, zero, huge, non-integer, string credits | `3`: 21 bad values plus smuggled fields (`recipient`, `to`, `__proto__`, `target`) through the tool layer, the quote tool, the purchaser and chat (model and fallback); no request with a tx, no chain change |
| 4 | Ten parallel requests: no AA25, daily limit never exceeded | `4`: ten parallel chats buying 0.6 mUSDC each (6 > 5 daily): exactly `floor(remaining / 0.6)` succeed, the rest are refused before sending (`ExceedsDailyLimit`, no tx), distinct nonces, one handleOps per success; ten parallel direct purchases; an op beyond the budget sent by hand fails on chain with `ExceedsDailyLimit` |
| 5 | Replay rejected (AA25), no double record | `5`: same signed op again: AA25 in simulation, nothing sent, credits unchanged; the same signed Ethereum tx re-broadcast is refused; a second request cannot store the same tx hash (`UNIQUE`) |
| 6 | An op hashed on Anvil is never sent to Base Sepolia | `6`: CHAIN_ID 84532 against the Anvil RPC: start-up refuses and the purchaser returns `CHAIN_MISMATCH` before signing or sending; the userOpHash formula binds the chain id (matches the EntryPoint), and an op signed for 84532 is rejected with AA24 |
| 7 | After revokeAgent every request is BLOCKED or AA24, and the agent says so | `7a`: 1, 50 and 500 credits all `BLOCKED` with "not registered or was revoked" in the reply; a stale OK pre-check gets AA24 from the chain, nothing mined, the reply says `nothing was sent (AA24 …)`; `7b`: outside the validity window: `BLOCKED`, and the EntryPoint refuses with **AA22** (expiry is AA22, not AA24, by the EntryPoint's design) |
| 8 | Keys never in logs, API responses, the database or LLM prompts | `security-secrets.anvil.test.mjs`: the real `startServer` with the Anthropic adapter against a local mock API; every endpoint, errors, an LLM 401 that echoes the API key, a user pasting each key; then greps all console output, every response body, every LLM request body and header, and the SQLite file with its WAL/SHM side files, for the agent, submitter and LLM keys in any case, with or without `0x` |
| 9 | A mined handleOps with `success == false` reported as a failure | `9`: the pre-check bypassed so a 1.01 mUSDC op is really mined; receipt status `success` but `UserOperationEvent.success == false`; stored `failed_onchain` with `ExceedsPerTxLimit`; the model's "Success! I bought…" is removed and the fixed line says the purchase failed |

## Changes the suite drove

Writing the suite found five gaps, now fixed in `src/` (each is tested above):

1. **One purchase per message, only when the user asked** (`agent/agent.js`). `buy_credits` runs only if this user
   message contains a buy word or a confirmation (`buy`, `purchase`, `get`, `need`, `yes`, `ok`, …) or the exact credit
   count, and at most once per message. Text injected through a tool result can no longer start purchases or loop them.
2. **Chain and merchant text is sanitized** (`agent/tools.js` `chainText`). Revert reasons and RPC errors reach the model
   and the user with addresses replaced by `[address]`, no control characters, at most 200 characters, and a note that
   it is data. Error codes are reduced to a plain identifier. Before, a revert like `ERC20InsufficientAllowance(0x…)`
   or a `SUBMITTER_LOW` message showed the model an address.
3. **Daily budget re-checked inside the per-agent queue** (`chain/userop.js`). Ten parallel requests all passed the
   pre-check at once; the later ones were mined and failed on chain, wasting gas. Now each op re-reads
   `remainingDailyAllowance` right before signing and is not sent if it would exceed it (skipped for an invalid agent, so
   the chain's exact AA24/AA22 reason is reported).
4. **Chain guard before signing** (`chain/userop.js`). The purchaser checks `eth_chainId == CHAIN_ID` before every op
   (`CHAIN_MISMATCH`), on top of the start-up check.
5. **A pasted key is refused cleanly** (`db/index.js`, `server.js`). The secret guard now uses the same env as the
   server, and a chat message containing a configured key returns `400 INVALID_INPUT` without storing it or sending it
   to the LLM (it was a `500`).

Also fixed: a timing flake in the Phase 9 expiry test (two requests created a second apart).

## PHASE11_DEBUGGING.md failure modes that apply to the agent

| Failure mode | Covered by |
|---|---|
| AA24 wrong signer, or agent not registered / revoked | `userop.anvil` "wrong key"; security `7a` |
| AA24 raw hash signed (no EIP-191) | security "debug guide: raw-hash … AA24" |
| AA24 nonce key not the agent address | `userop.anvil` "nonce key 0 … AA24" |
| AA24 policy broken at validation (target, wallet/EntryPoint target, `value != 0`, token call, recipient) | security `2b` |
| AA24 hash for another chain or EntryPoint | security `6` |
| AA23 64-byte signature (`ECDSAInvalidSignatureLength`) | security "debug guide: … 64-byte … AA23" |
| AA23 high-s signature | security "debug guide: … high-s … AA23" (the backend signs with viem, which only produces low-s) |
| AA22 expired or not due | security `7b` |
| AA25 nonce reused | `userop.anvil` "reusing a nonce"; security `5` |
| AA21 prefund | `userop.anvil` "deposit below the op's prefund" (refused before sending) |
| AA95 handleOps gas too low | `userop.anvil` "AA95" |
| Mined but `UserOperationEvent.success == false` | security `9`; `userop.anvil` "over-limit purchase … failed_onchain" |
| Gas estimation reverts with a dummy signature | Not applicable: the backend never estimates UserOp gas; it uses the fixed limits from `integration/lib.mjs` (`userop.test` "gas limits") |
| `UnauthorizedCaller` (executeAsAgent called directly) | security "debug guide: executeAsAgent called directly" |
| Wrong callData shape | security "debug guide: … callData has the documented shape" (decodes a real handleOps) |
| `ExceedsPerTxLimit` | security `9` |
| `ExceedsDailyLimit` | security `4` (refused before sending, and on chain for a hand-built op) |
| `RecipientNotAllowed` | Not reachable from the backend: it only ever calls `merchant.purchase`, whose recipient is the allowlisted merchant (`2b` shows any other target or recipient fails at validation). On chain: `contracts/test/SecuritySuite.t.sol` |
| `IncorrectPayment` | Not reachable in normal use: the purchaser pays `quote(credits)` read in the same queued job; a price change between read and send would show as `failed_onchain` with this code (`errorCode` unit test maps custom errors) |
| `ERC20InsufficientAllowance` / `ERC20InsufficientBalance` | `precheck.anvil` "merchant allowance or wallet balance too low -> NEEDS_OWNER_TOPUP" (nothing is sent) |
| `ZeroCredits` | security `3` (credits 0 refused at every layer; never reaches the chain) |

## What the suite does not claim

- Someone who can type into the chat can buy credits within the on-chain limits; that is the product. The guarantee is
  that nothing gets past `maxPerTx`, `dailyLimit`, the call and recipient allowlists, and the one-purchase-per-message rule.
- The LLM API key necessarily travels in the provider's auth header; the test checks it is there and nowhere else.
