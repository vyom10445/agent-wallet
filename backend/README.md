# Agent backend (P-2)

The AI agent backend for the AgentWallet contracts. **Phase 1: setup only.** No backend logic yet.

Addresses come from `../contracts/deployments/<chainId>.json` and ABIs from `../abi/`. Nothing is hard-coded,
and nothing in `contracts/`, `abi/` or `integration/` is changed.

## Choices (recorded in Phase 1)

| What | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 LTS, **22.13 or later** | `node:sqlite` works without a flag from 22.13. `--env-file-if-exists` needs 22.9 or later. |
| viem | **2.57.11** (exact, no `^`) | Same pin as `integration/package.json`, so code ported from `integration/lib.mjs` behaves the same. `npm run check` fails if they drift. |
| SQLite | **`node:sqlite`** (built into Node) | No install, no native build, no prebuilt binary to download. Fallback: `better-sqlite3@13.0.3`, which ships a `win32-x64` prebuild. |
| `.env` loading | Node's `--env-file-if-exists` | No `dotenv` dependency. |
| LLM SDK | Chosen in Phase 7 | Not needed yet. |

`node:sqlite` is still marked experimental, so Node prints an `ExperimentalWarning`. The npm scripts hide it with
`--disable-warning=ExperimentalWarning`.

## Setup (PowerShell)

```powershell
node --version        # v22.13.0 or later
npm --version
cd agent-wallet\backend
npm install
Copy-Item .env.example .env   # then fill in .env in VS Code (testnet throwaway keys only)
npm run check
```

`npm run check` is offline and read-only. It should end with `Setup OK`.

If PowerShell says `npm.ps1 cannot be loaded because running scripts is disabled`, run this once:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

## Verify the live P-1 setup (Step 1.4)

```powershell
cd agent-wallet\integration
npm install
$env:AGENT_ADDRESS = "0xC74Ba823524Cbd1d889b5FD38785b9d293C6D8aD"
node read.mjs
cd ..\contracts
forge script script/Status.s.sol --rpc-url base_sepolia
```

Expect `EntryPoint is v0.7 true` and `agent valid now true`. If the agent has expired, revoke it and rerun
ConfigureAgent as in `docs/PHASE12_FINAL.md` §8.

## Keys

- `.env` holds the **agent** key and a separate **submitter** key (a funded Base Sepolia EOA). Testnet throwaway keys only.
- The backend never holds the **owner** key. `npm run check` fails if `OWNER_PRIVATE_KEY` is set.
- Keys never go into SQLite, logs, API responses or prompts.

## Planned layout (later phases)

```
backend/
├── scripts/check-setup.mjs   (Phase 1)
├── src/
│   ├── config.js             (Phase 3: env, chain, addresses, ABIs)
│   ├── chain/                (Phase 3-4: reads, UserOp builder, submitter, decoder; ported from integration/lib.mjs)
│   ├── policy/               (Phase 5: off-chain pre-check)
│   ├── db/                   (Phase 6: node:sqlite schema and queries)
│   ├── agent/                (Phase 7: LLM loop and typed tools)
│   ├── approvals/            (Phase 9: owner approval requests and on-chain verification)
│   └── server.js             (HTTP API)
├── test/
└── data/                     (SQLite file, git-ignored)
```
