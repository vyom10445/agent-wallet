// Shared setup for Anvil tests. Anvil's published dev keys only: never use them on a real network.
import { existsSync } from "node:fs";

// #0 = owner/deployer, #1 = agent (ConfigureAgent), #2 = submitter, #3 = not an agent.
export const ANVIL_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
];
export const ANVIL_RPC = process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:8545";
export const anvilEnv = { CHAIN_ID: "31337", RPC_URL: ANVIL_RPC, AGENT_PRIVATE_KEY: ANVIL_KEYS[1], SUBMITTER_PRIVATE_KEY: ANVIL_KEYS[2] };

/** false when Anvil + deployments/31337.json are ready, else the skip reason. */
export async function anvilSkipReason() {
  if (!existsSync(new URL("../../../contracts/deployments/31337.json", import.meta.url))) return "contracts/deployments/31337.json missing (run Deploy.s.sol on Anvil)";
  try {
    const r = await fetch(ANVIL_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }) });
    const { result } = await r.json();
    return Number(result) === 31337 ? false : `RPC at ${ANVIL_RPC} is chain ${Number(result)}, not 31337`;
  } catch {
    return `Anvil not running at ${ANVIL_RPC}`;
  }
}
