# Agent Wallet

**An ERC-4337 smart wallet that lets an AI agent spend on its own, inside limits the owner sets on chain, and asks the owner to sign anything bigger.**

![Base Sepolia](https://img.shields.io/badge/network-Base%20Sepolia-0052FF)
![ERC-4337](https://img.shields.io/badge/ERC--4337-EntryPoint%20v0.7-6E56CF)
![Tests](https://img.shields.io/badge/tests-529%20passing-2EA44F)

| Chat | Owner approval |
|---|---|
| ![Agent chat](docs/screenshots/chat.png) | ![Owner approval](docs/screenshots/approve.png) |

<sub>Frontend running against a mock backend.</sub>

## Why

Giving an AI agent a private key means one prompt injection can drain the wallet. Approving every payment by hand
means the agent isn't autonomous. Agent Wallet puts the limits **in the wallet contract**: the agent buys freely within
policy (1 mUSDC per purchase, 5 per UTC day by default), and anything over it waits for the owner's signature.

## How it works

```mermaid
flowchart LR
    U(["User"]) --> FE["Web app<br/>(React + viem)"]
    FE --> BE["Agent backend<br/>(LLM + pre-check)"]
    BE -- "within limits:<br/>agent-signed UserOp" --> EP["EntryPoint v0.7"]
    EP --> W["AgentWallet<br/>(policy enforced on chain)"]
    W -- "purchase()" --> M["MockMerchant"]
    BE -. "over limits:<br/>needs owner approval" .-> FE
    O(["Owner<br/>(MetaMask)"]) -- "executeBatch(approve, purchase)" --> W
```

- **contracts/**: `AgentWallet` = eth-infinitism `SimpleAccount` v0.7.0 plus per-agent policy (token, max per tx,
  daily limit, validity window, allowlisted targets, selectors and recipients).
- **backend/**: chat agent with four typed tools; builds, signs and submits UserOps to `EntryPoint.handleOps`; verifies
  owner approvals on chain.
- **frontend/**: dashboard, chat, owner approval, activity feed, owner controls.

## Security model

- **The contract is the authority.** Limits are checked in validation and again in execution. The LLM, backend and UI
  can be wrong or compromised; the agent key still can't exceed its limits, reach unlisted contracts, change its own
  policy, or act after revocation or expiry.
- **Owner approval:** the backend never holds the owner key. The web app rebuilds the over-limit transaction from the
  chain, refuses on any byte of difference, and the owner signs it in MetaMask. The backend verifies it with six on-chain checks.
- **`proofVerified`:** a request shows as paid only after the backend proves it on chain, never from the agent's words.
- Tested heavily, **not audited**. Testnet only.

## Deployed on Base Sepolia (84532)

| Contract | Address |
|---|---|
| AgentWallet | [`0x74cD24BBaf39022155d2912923F4dC234D215c1A`](https://sepolia.basescan.org/address/0x74cD24BBaf39022155d2912923F4dC234D215c1A) |
| AgentWalletFactory | [`0xAD5E19b7A292735b79D13e48A854BAf6baC96D51`](https://sepolia.basescan.org/address/0xAD5E19b7A292735b79D13e48A854BAf6baC96D51) |
| MockUSDC | [`0xC91a11d7096c0685590267C083Fd67A518D65C3F`](https://sepolia.basescan.org/address/0xC91a11d7096c0685590267C083Fd67A518D65C3F) |
| MockMerchant | [`0x8D94CcD748a00C27Cc339aaE3A14F2965E8b4FC1`](https://sepolia.basescan.org/address/0x8D94CcD748a00C27Cc339aaE3A14F2965E8b4FC1) |
| EntryPoint v0.7 | [`0x0000000071727De22E5E9d8BAf0edAc6f37da032`](https://sepolia.basescan.org/address/0x0000000071727De22E5E9d8BAf0edAc6f37da032) |

All addresses: [`contracts/deployments/84532.json`](contracts/deployments/84532.json). Deployed and configured, and the
Foundry smoke test (agent UserOp → EntryPoint → merchant) passed live. The backend and web-app end-to-end runs have been
rehearsed on Anvil and against a mock backend; their live Base Sepolia runs are still to do.

## Quickstart (Windows, PowerShell)

Needs Git, [Foundry](https://book.getfoundry.sh/getting-started/installation) and Node.js 22.13+.

```powershell
git clone --recurse-submodules https://github.com/vyom10445/agent-wallet.git
cd agent-wallet\contracts; forge test                      # 187 passed
# start `anvil` in a second window, then:
forge script script/H12Demo.s.sol --rpc-url anvil --broadcast   # full local flow, ends "H12: GO"
```

Backend and web app: copy `backend\.env.example` to `backend\.env` (testnet keys only), then `npm install; npm start`
in `backend\` and `npm ci; npm run dev` in `frontend\`, and open **http://localhost:5173**. Full steps, including the
Anvil setup: [backend/docs/BACKEND_FINAL.md](backend/docs/BACKEND_FINAL.md) §4 and
[frontend/docs/FRONTEND_FINAL.md](frontend/docs/FRONTEND_FINAL.md) §2.

## Demo

1. **Dashboard:** the on-chain policy and today's spend.
2. **Chat** `buy 10 credits`: the agent buys by itself via a UserOp; open the tx on BaseScan.
3. **Chat** `buy 150 credits`: over the limit, nothing sent, "Needs your signature".
4. **Approve:** review the decoded calls, sign in MetaMask, verified on chain.
5. **Chat** a prompt injection: shown as plain text, no purchase.
6. **Activity:** agent and owner purchases, each badged and linked.

## Tests

| Part | Command | Result |
|---|---|---|
| Contracts | `forge test` | 187 passed, 100% coverage of `src/`, fuzz + invariants |
| Backend | `npm run test:anvil` | 107 passed |
| Frontend | `npm test` | 235 passed |

## Known limitations

Testnet mocks, not audited. No public bundler (the backend calls `handleOps` directly). Daily limits are UTC days, so up
to 2× is possible across midnight. The backend is local-only with no auth. Full lists:
[contracts](docs/PHASE12_FINAL.md) §7, [backend](backend/docs/BACKEND_FINAL.md) §7, [frontend](frontend/docs/FRONTEND_FINAL.md) §3.

## Repo layout

```
contracts/   Foundry: AgentWallet, factory, mocks, tests, deploy and demo scripts
backend/     Node 22 agent service (viem, SQLite)
frontend/    Vite + React + TypeScript web app
abi/         exported ABIs shared by backend and frontend
docs/        design, interface, deployment and security reports
```
