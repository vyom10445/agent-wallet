# H12 live run on Base Sepolia (PowerShell)

Goal: one real ERC-4337 purchase through the backend on Base Sepolia, then an over-limit request that sends nothing.
`npm run h12` drives the running backend through `POST /agent/chat` and checks every stage **directly on chain**
(not from the backend's own database). It uses no keys itself.

Rehearsed on Anvil: 19/19 checks, `H12: GO`.

## 0. Before you start (once)

```powershell
cd agent-wallet\contracts
forge script script/Status.s.sol --rpc-url base_sepolia
```

Need `EntryPoint is v0.7 true`, `agent valid now true`, `remaining today` of at least 0.1 mUSDC, merchant allowance
at least 0.1 mUSDC. If the agent expired: revoke and rerun ConfigureAgent (`docs/PHASE12_FINAL.md` §8). Rerunning
ConfigureAgent also tops up the gas deposit, mUSDC and allowance.

**Submitter key** (pays the `handleOps` gas; must not be the deployer/owner). If you don't have one yet:

```powershell
cast wallet new                       # copy the address and private key into backend\.env below
$D = cast wallet address --account deployer
cast send <SUBMITTER_ADDRESS> --value 0.003ether --account deployer --rpc-url base_sepolia
```

**`backend\.env`** (git-ignored; testnet throwaway keys only):

```
CHAIN_ID=84532
RPC_URL=https://sepolia.base.org
AGENT_ADDRESS=0xC74Ba823524Cbd1d889b5FD38785b9d293C6D8aD
AGENT_PRIVATE_KEY=<the agent key from contracts\.env>
SUBMITTER_PRIVATE_KEY=<the submitter key>
LLM_PROVIDER=none
PORT=8787
```

`LLM_PROVIDER=none` keeps H12 deterministic. Switch the LLM on after H12 passes.

```powershell
cd agent-wallet\backend
npm install
npm run check          # Setup OK
npm run status         # same values as Status.s.sol, startup checks pass
```

## 1. Run

Window 1 (leave it running):

```powershell
cd agent-wallet\backend
npm start
```

Expect `Agent backend on http://127.0.0.1:8787 {"chainId":84532,...} llm=none (fallback planner)`.

Window 2:

```powershell
cd agent-wallet\backend
npm run h12
```

Stages it prints:

| # | Stage | Checks |
|---|---|---|
| 1 | Backend health | backend is up on chain 84532 with the deployment's wallet |
| 2 | Before | agent active and valid, purchase allowed, quote(10) within maxPerTx and remaining today |
| 3 | `POST /agent/chat "buy 10 credits"` | one request created; the reply text |
| 4 | `GET /requests/:id` | status `succeeded`; prints **userOpHash**, **txHash** and the **BaseScan link** |
| 5 | On-chain proof | receipt success; tx `to` = EntryPoint and calls `handleOps` (**not a bypass**); `UserOperationEvent.success == true` for our userOpHash; sender = wallet; nonce key = agent; `CreditsPurchased` (buyer wallet, 10 credits, paid quote); `AgentSpent` from the wallet |
| 6 | After | **spentToday rose by exactly quote(10)** (0.1 mUSDC); credits +10 |
| 7 | `POST /agent/chat "buy 500 credits"` | `needs_owner_approval`, no tx/userOp hash, **submitter sent no tx**, agent nonce, balance, spentToday and credits unchanged |

It ends with `H12: GO` or `H12: NO-GO` and the first failing stage. Open the BaseScan link and check the Logs tab
for `UserOperationEvent` with `success: true`.

You can also call the API by hand:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/agent/chat -ContentType application/json -Body '{"message":"buy 10 credits"}'
Invoke-RestMethod http://127.0.0.1:8787/requests/<request id>
Invoke-RestMethod http://127.0.0.1:8787/wallet/status
```

## 2. If it says NO-GO

Find the first failing stage before changing any code.

1. Read the request's `error.code` (printed in stage 4) and look it up in `docs/PHASE11_DEBUGGING.md`:
   `AA21` deposit too low (rerun ConfigureAgent), `AA22` agent expired, `AA24` wrong signer or nonce key,
   `AA25` nonce reused, `SUBMITTER_LOW` fund the submitter, `ERC20InsufficientAllowance` rerun ConfigureAgent,
   `ExceedsDailyLimit` wait for 00:00 UTC.
2. Run the P-1 reference purchase with the **same** `.env` (no keys typed; `--env-file` reads backend\.env):

   ```powershell
   cd agent-wallet\integration
   $env:CREDITS = "10"
   node --env-file=..\backend\.env agent-purchase.mjs
   Remove-Item Env:CREDITS
   ```

   - It prints `PURCHASE OK` but the backend failed: the bug is in the backend. Keep the window 1 log, the
     `npm run h12` output and `Invoke-RestMethod http://127.0.0.1:8787/requests/<id>` for the fix.
   - It fails too: the problem is chain state or config, not the backend. Run `Status.s.sol` and follow the
     debugging table.
3. "spentToday rose by exactly the quote" can only fail on its own if another purchase ran at the same time, or
   the UTC day rolled over mid-run (the script detects the rollover).

## 3. Demo fallback: Anvil

If Base Sepolia is the blocker (RPC down, faucet empty), run the same check locally. This is still a real
ERC-4337 flow, but through the **local** EntryPoint that Deploy.s.sol puts on Anvil; don't present it as Base Sepolia.

```powershell
# window 1
anvil
# window 2
cd agent-wallet\contracts
forge script script/Deploy.s.sol --rpc-url anvil --broadcast --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
$env:AGENT_ADDRESS="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
forge script script/ConfigureAgent.s.sol --rpc-url anvil --broadcast --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
cd ..\backend
$env:CHAIN_ID="31337"; $env:RPC_URL="http://127.0.0.1:8545"; $env:DB_PATH="data/anvil.sqlite"
$env:AGENT_PRIVATE_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"      # Anvil #1 (public test key)
$env:SUBMITTER_PRIVATE_KEY="0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"  # Anvil #2 (public test key)
npm start
# window 3
cd agent-wallet\backend
$env:CHAIN_ID="31337"; $env:RPC_URL="http://127.0.0.1:8545"
npm run h12
```

On Anvil there is no BaseScan link; the script prints the tx hash instead (`cast run <txhash> --rpc-url anvil`
shows the full trace).
