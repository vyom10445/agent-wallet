# Phase 10: Base Sepolia deployment

Nothing has been deployed to Base Sepolia yet. You run every command below on your own PC, with a fresh testnet wallet.
All scripts were rehearsed end to end on a local chain configured as Base Sepolia (details at the end).

## What the scripts do

| Script | Sends | What it does |
|---|---|---|
| `script/Deploy.s.sol` | up to 4 txs | Uses the canonical EntryPoint v0.7, CREATE2-deploys AgentWalletFactory (plus AgentWallet implementation), MockUSDC and MockMerchant, creates your AgentWallet owned by the sender. Writes `deployments/84532.json`. |
| `script/ConfigureAgent.s.sol` | up to 7 txs | As the owner: `addAgent`, `setPolicy`, `allowCall(merchant.purchase)`, `allowRecipient(merchant)`, approve the merchant, mint test mUSDC, add the EntryPoint gas deposit. |
| `script/SmokeTest.s.sol` | 1 tx | The real agent purchase: agent-signed UserOperation, then `EntryPoint.handleOps`, validation, restricted execution, the merchant pulls mUSDC, purchase recorded. It also simulates (never sends) a wrong-signer op and an over-limit op. |
| `script/Status.s.sol` | nothing | Read-only check of what is live on chain. |

Safety built in:
- Every script refuses any chain except Anvil (31337) and Base Sepolia (84532).
- Deploy refuses if the canonical EntryPoint v0.7 or the CREATE2 deployer is missing.
- ConfigureAgent refuses if the sender is not the wallet owner.
- SmokeTest aborts before broadcasting if any check fails in simulation.
- Reruns are safe: existing contracts are reused, and finished steps are skipped.
- No dependency versions changed, and no wallet logic changed. Only scripts, config and one test file were added.

## Keys: where they live

| Key | Where | Needs ETH |
|---|---|---|
| Deployer, which is also the wallet owner | Encrypted Foundry keystore `deployer` in `%USERPROFILE%\.foundry\keystores`, created with a password. It is never printed and never stored in the project. | Yes, about 0.02 Base Sepolia ETH |
| Agent (session key) | `AGENT_PRIVATE_KEY` in `contracts\.env` (git-ignored). Make a new throwaway key that is used only here. | No |

Never use a wallet that holds real funds. `.env`, `cache/` and `out/` are git-ignored, so don't change that.

## 0. One-time setup (PowerShell, in `agent-wallet\contracts`)

```powershell
# deployer/owner: brand-new key written straight into an encrypted keystore (you choose a password)
New-Item -ItemType Directory -Force "$HOME\.foundry\keystores" | Out-Null
cast wallet new "$HOME\.foundry\keystores" deployer
$D = cast wallet address --account deployer      # asks for the password
$D                                               # fund this address from a Base Sepolia faucet (~0.02 ETH)

# agent: throwaway key, no funds needed
cast wallet new                                  # copy Address and Private key into .env below
Copy-Item .env.example .env
notepad .env                                     # set AGENT_ADDRESS, AGENT_PRIVATE_KEY, ETHERSCAN_API_KEY
Clear-Host

# checks
cast chain-id --rpc-url base_sepolia             # must print 84532
cast balance $D --rpc-url base_sepolia --ether
cast code 0x0000000071727De22E5E9d8BAf0edAc6f37da032 --rpc-url base_sepolia   # must NOT be 0x
forge test                                       # 169 tests pass
```

`ETHERSCAN_API_KEY` is a free key from etherscan.io. With Etherscan API V2, one key also covers BaseScan.
If `https://sepolia.base.org` rate-limits you, put your own Base Sepolia RPC URL in `BASE_SEPOLIA_RPC_URL`.

## 1. Deploy

```powershell
# rehearsal against the live chain, sends nothing
forge script script/Deploy.s.sol --rpc-url base_sepolia --account deployer --sender $D
# real deployment
forge script script/Deploy.s.sol --rpc-url base_sepolia --account deployer --sender $D --broadcast --slow
Get-Content deployments\84532.json
```

Expected addresses: the factory, mUSDC and merchant should match the dry run (factory `0xAD5E19b7A292735b79D13e48A854BAf6baC96D51`, mUSDC `0xC91a11d7096c0685590267C083Fd67A518D65C3F`, merchant `0x8D94CcD748a00C27Cc339aaE3A14F2965E8b4FC1`). If your source files have different line endings, these can differ, which is harmless. The wallet address depends on your owner address. `deployments\84532.json` is always the authoritative record.

## 2. Initialize (configure the agent policy)

Defaults: maxPerTx 1 mUSDC, daily 5 mUSDC, valid 7 days, merchant allowance 10 mUSDC, 100 mUSDC minted, 0.005 ETH deposit. Override any of them in `.env`.

```powershell
forge script script/ConfigureAgent.s.sol --rpc-url base_sepolia --account deployer --sender $D --broadcast --slow
```

You can change the policy later the same way: edit `.env` and rerun the script, or call the owner functions directly.
For example:

```powershell
$J = Get-Content deployments\84532.json | ConvertFrom-Json
cast send $J.wallet "setPolicy(address,address,uint256,uint256)" $env:AGENT $J.usdc 2000000 8000000 --account deployer --rpc-url base_sepolia
cast send $J.wallet "revokeAgent(address)" $env:AGENT --account deployer --rpc-url base_sepolia   # emergency stop
```

(Set `$env:AGENT` to your agent address first.)

## 3. Verify source on BaseScan

```powershell
$J = Get-Content deployments\84532.json | ConvertFrom-Json
forge verify-contract $J.usdc src/MockUSDC.sol:MockUSDC --chain base-sepolia --watch
forge verify-contract $J.merchant src/MockMerchant.sol:MockMerchant --chain base-sepolia --watch --constructor-args (cast abi-encode "constructor(address,uint256)" $J.usdc 10000)
forge verify-contract $J.factory src/AgentWalletFactory.sol:AgentWalletFactory --chain base-sepolia --watch --constructor-args (cast abi-encode "constructor(address)" $J.entryPoint)
forge verify-contract $J.implementation src/AgentWallet.sol:AgentWallet --chain base-sepolia --watch --constructor-args (cast abi-encode "constructor(address)" $J.entryPoint)
```

- The wallet itself is an ERC1967 proxy. On BaseScan, open the wallet address, go to Contract, then More options, then "Is this a proxy?", to link it to the implementation.
- If the Etherscan route fails, Blockscout needs no key. Add `--verifier blockscout --verifier-url https://base-sepolia.blockscout.com/api/` to each command.
- The EntryPoint is the canonical one and is already verified.

## 4. Smoke test (the full agent purchase on testnet)

```powershell
forge script script/SmokeTest.s.sol --rpc-url base_sepolia --account deployer --sender $D --broadcast --slow
forge script script/Status.s.sol --rpc-url base_sepolia          # reads the live chain afterwards
```

Pass looks like this: six `PASS` lines and `SMOKE TEST: PASS`. Then Status shows `credits purchased 10`, `merchant purchaseCount 1`, `spentToday 100000`, and all the `ok` lines `true`.
Your deployer submits the `handleOps` transaction as the bundler, and the wallet's EntryPoint deposit refunds it.
Each run buys `SMOKE_CREDITS` again, so the totals grow.

## 5. Record the addresses

Commit `contracts/deployments/84532.json` (it holds addresses only). Then fill in this table:

| Contract | Base Sepolia address |
|---|---|
| EntryPoint v0.7 (canonical) | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |
| AgentWalletFactory | |
| AgentWallet implementation | |
| AgentWallet (yours) | |
| MockUSDC | |
| MockMerchant | |
| Agent address | |
| Smoke test tx hash | |

## Checks against the Phase 10 brief

| Check | How it's covered |
|---|---|
| EntryPoint v0.7 compatibility | Deploy requires code at the canonical v0.7 address. Status checks the v0.7 ERC-165 id and `wallet.entryPoint()`. `DeployScriptTest` runs the 84532 path in tests. |
| Network and chain id | `cast chain-id` returns 84532. The scripts refuse every other chain, and tests cover chains 1, 8453 and 11155111. |
| Owner initialization | `factory.createAccount(sender, 0)`, so the owner is the deployer. Status prints `wallet owner ok`. A zero owner is rejected. |
| Agent policy configurable after deploy | ConfigureAgent, plus the `cast send` examples. Every call is `onlyOwner`. |
| MockUSDC and merchant connected | The merchant is constructed with the mUSDC address. Status prints `merchant token ok`, and the smoke test makes a real purchase. |
| Addresses available | `deployments/84532.json` plus the table above. |
| No secrets committed | The tracked files hold no keys. `.env` is git-ignored, and the owner key stays in an encrypted keystore. |

## Dry run done here (not Base Sepolia)

Base Sepolia RPCs are blocked from my sandbox, so a fork wasn't possible. Instead I ran a local Anvil with `--chain-id 84532` and put EntryPoint v0.7 at the canonical address. I then ran the same commands, using `--rpc-url base_sepolia` and `--account deployer` with a keystore. Results:
- Deploy succeeded.
- Configure succeeded.
- SmokeTest showed 6/6 PASS.
- Status confirmed the result on chain: 10 credits, purchaseCount 1, spentToday 100000, and all checks true.
- Reruns of Deploy and Configure sent 0 transactions.
- An over-limit `SMOKE_CREDITS` aborted before sending anything.

Gas used: about 7.4M for deploy, 0.65M for configure and 1.26M (limit) for the smoke test. On Base Sepolia that costs a few cents of testnet ETH.

Not tested here: the live Base Sepolia RPC, BaseScan/Blockscout verification, and the public faucet.
