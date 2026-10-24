# Integration examples (viem)

Runnable examples against the deployed contracts. Addresses are read from `../contracts/deployments/<chainId>.json`
and ABIs from `../abi/`, so nothing is hard-coded. See `../docs/PHASE11_INTEGRATION.md` for the full guide.

```bash
cd integration
npm install
# Base Sepolia is the default (CHAIN_ID=84532). For a local Anvil run, set CHAIN_ID=31337 first.
node read.mjs                 # AGENT_ADDRESS optional
node events.mjs               # FROM_BLOCK optional
node owner-configure.mjs      # OWNER_PRIVATE_KEY, AGENT_ADDRESS, MAX_PER_TX, DAILY_LIMIT
node agent-purchase.mjs       # AGENT_PRIVATE_KEY, SUBMITTER_PRIVATE_KEY, CREDITS
node owner-approve.mjs        # OWNER_PRIVATE_KEY, CREDITS, MAX_PRICE
```

Only use private keys for testnet or Anvil. In a browser, sign with the user's injected wallet instead:
`createWalletClient({ chain, transport: custom(window.ethereum) })`.
