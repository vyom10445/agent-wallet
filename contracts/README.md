# Agent Wallet contracts (P-1)

Foundry project for the AI Agent Wallet smart contract workstream. Phase 1 is complete: the environment builds,
the account implementation is chosen and pinned, and the planned files exist as placeholders.

## Pinned versions (Phase 1 record)

| Component | Version | Notes |
|---|---|---|
| Foundry (forge, anvil, cast) | 1.5.1-stable (b0a9dd9c) | Any 1.x should work |
| solc | 0.8.23 | Same compiler as account-abstraction v0.7.0 upstream |
| EVM version | shanghai | Highest target supported by solc 0.8.23; Base Sepolia supports it |
| eth-infinitism/account-abstraction | v0.7.0 (7af70c89) | EntryPoint v0.7, SimpleAccount, SimpleAccountFactory |
| OpenZeppelin contracts | v5.0.2 (dbb6104c) | AA v0.7.0 requires OZ 5.x. OZ 4.x is incompatible |
| forge-std | v1.9.4 (1eea5bae) | |

Exact pins are also in `foundry.lock` and `../.gitmodules`.

**Account implementation:** `AgentWallet` extends `SimpleAccount` from account-abstraction v0.7.0 without
changing its signature, nonce, or ERC-4337 validation logic.

**EntryPoint:** v0.7. On Base Sepolia (chain 84532) use the canonical deployment at
`0x0000000071727De22E5E9d8BAf0edAc6f37da032`. Local tests deploy their own EntryPoint.

## Layout

```
contracts/
├── src/        AgentWallet.sol, MockUSDC.sol, MockMerchant.sol   (placeholders)
├── test/       Setup.t.sol (Phase 1 acceptance tests) + per-contract placeholders
├── script/     Deploy.s.sol (placeholder, checks EntryPoint presence)
├── lib/        forge-std, account-abstraction, openzeppelin-contracts (vendored)
├── foundry.toml
└── remappings.txt
```

## Commands

Run from this `contracts/` folder:

```bash
forge --version
forge build
forge test -vv
anvil                                   # local chain on 127.0.0.1:8545, chain id 31337
forge script script/Deploy.s.sol --rpc-url anvil
forge script script/Deploy.s.sol --rpc-url base_sepolia   # needs .env, read-only
```

If `lib/` is empty (for example after a fresh git clone), restore the pinned dependencies with:

```bash
git submodule update --init --recursive
```

or, outside git, re-run `forge install` with the tags above.

## Phase 2 (interface freeze)

- `docs/ACCOUNT_INSPECTION.md`: how SimpleAccount v0.7.0 and EntryPoint v0.7 work, bypass analysis, recommended extension.
- `docs/INTERFACE.md`: the AgentWallet interface for P-2 and P-3 (draft until signed off).
- `src/interfaces/IAgentWallet.sol` + `test/InterfaceFreeze.t.sol` (fails if a frozen signature changes).
- `../abi/`: exported ABIs.

## Keys

Use Anvil's built-in dev accounts locally. For Base Sepolia, use a throwaway testnet account stored in an
encrypted Foundry keystore (`cast wallet import deployer --interactive`, then `--account deployer`).
Never commit `.env`, and never use a real wallet's private key or seed phrase.

## Phase 1 acceptance

- [x] Foundry available
- [x] Project compiles (`forge build`)
- [x] Acceptance tests pass (`forge test`)
- [x] Anvil starts (chain id 31337)
- [x] Account implementation and EntryPoint version chosen (SimpleAccount / EntryPoint v0.7)
- [x] Dependency versions recorded (this file)
