// Backend configuration: env (backend/.env), chain, addresses from ../contracts/deployments/<chainId>.json, ABIs from ../abi/.
// Same sources as integration/lib.mjs. Keys are turned into viem accounts here and the key strings are never kept,
// returned or put into an error message.
import { readFileSync } from "node:fs";
import { getAddress, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, anvil } from "viem/chains";

export const SUPPORTED_CHAINS = { 84532: baseSepolia, 31337: anvil };
export const USDC_DECIMALS = 6; // mUSDC base units: 1_000_000 = 1 mUSDC
export const PURCHASE_SELECTOR = "0x70876c98"; // MockMerchant.purchase(uint256,uint256), abi/selectors.json
// type(IEntryPoint).interfaceId ^ type(IStakeManager).interfaceId ^ type(INonceManager).interfaceId, as in Status.s.sol.
export const ENTRYPOINT_V07_INTERFACE_ID = "0x60fc6b6e";

const ADDRESS_KEYS = ["entryPoint", "factory", "implementation", "merchant", "owner", "usdc", "wallet"];

export class ConfigError extends Error {
  name = "ConfigError";
}

const json = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));

export const abi = {
  wallet: json("../../abi/AgentWallet.json"),
  factory: json("../../abi/AgentWalletFactory.json"),
  usdc: json("../../abi/MockUSDC.json"),
  merchant: json("../../abi/MockMerchant.json"),
  entryPoint: json("../../abi/EntryPoint.v0.7.0.json"),
};
// Every error/event the flow can produce, for decoding receipts and reverts in one place.
export const allAbi = [...abi.wallet, ...abi.usdc, ...abi.merchant, ...abi.entryPoint];

function required(env, name) {
  const v = env[name]?.trim();
  if (!v) throw new ConfigError(`${name} is missing. Set it in backend/.env (see .env.example).`);
  return v;
}

/** Builds an account from a key without ever echoing the key. */
function accountFrom(env, name) {
  const key = required(env, name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new ConfigError(`${name} is not a 0x-prefixed 32-byte hex private key.`);
  try {
    return privateKeyToAccount(key);
  } catch {
    throw new ConfigError(`${name} is not a valid secp256k1 private key.`);
  }
}

export function loadDeployment(chainId) {
  let d;
  try {
    d = json(`../../contracts/deployments/${chainId}.json`);
  } catch (e) {
    const hint = chainId === 31337 ? " Run Deploy.s.sol and ConfigureAgent.s.sol on Anvil first." : "";
    throw new ConfigError(`Cannot read contracts/deployments/${chainId}.json (${e.code ?? e.message}).${hint}`);
  }
  if (Number(d.chainId) !== chainId) throw new ConfigError(`contracts/deployments/${chainId}.json says chainId ${d.chainId}.`);
  const out = { chainId };
  for (const k of ADDRESS_KEYS) {
    if (!isAddress(d[k] ?? "", { strict: false })) throw new ConfigError(`contracts/deployments/${chainId}.json: "${k}" is missing or not an address.`);
    out[k] = getAddress(d[k]);
  }
  return Object.freeze(out);
}

function optionalInt(env, name, { min, max, def }) {
  const raw = env[name]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be a whole number from ${min} to ${max}, got "${raw}".`);
  return n;
}

/**
 * Reads and validates the env. Throws ConfigError with a readable message on the first problem.
 * Returns a frozen object with no key strings: only viem accounts (address + signing functions).
 */
export function loadConfig(env = process.env) {
  const chainId = Number(env.CHAIN_ID?.trim() || 84532);
  const chain = SUPPORTED_CHAINS[chainId];
  if (!chain) throw new ConfigError(`CHAIN_ID must be 84532 (Base Sepolia) or 31337 (Anvil), got "${env.CHAIN_ID}".`);
  const rpcUrl = required(env, "RPC_URL");
  if (!/^https?:\/\//.test(rpcUrl)) throw new ConfigError("RPC_URL must start with http:// or https://.");

  if (env.OWNER_PRIVATE_KEY) throw new ConfigError("OWNER_PRIVATE_KEY is set. The backend must never hold the owner key: remove it from backend/.env.");
  const agent = accountFrom(env, "AGENT_PRIVATE_KEY");
  const submitter = accountFrom(env, "SUBMITTER_PRIVATE_KEY");

  if (env.AGENT_ADDRESS?.trim()) {
    if (!isAddress(env.AGENT_ADDRESS.trim(), { strict: false })) throw new ConfigError("AGENT_ADDRESS is not an address.");
    if (getAddress(env.AGENT_ADDRESS.trim()) !== agent.address) {
      throw new ConfigError(`AGENT_PRIVATE_KEY belongs to ${agent.address}, but AGENT_ADDRESS is ${getAddress(env.AGENT_ADDRESS.trim())}. Wrong agent key.`);
    }
  }
  if (agent.address === submitter.address) throw new ConfigError("AGENT_PRIVATE_KEY and SUBMITTER_PRIVATE_KEY must be different keys.");

  const addresses = loadDeployment(chainId);
  if (agent.address === addresses.owner) throw new ConfigError("AGENT_PRIVATE_KEY is the wallet owner's key. Use a separate agent key.");
  if (submitter.address === addresses.owner) throw new ConfigError("SUBMITTER_PRIVATE_KEY is the wallet owner's key. Use a separate funded throwaway key.");

  const approvalTtlSeconds = Number(env.APPROVAL_TTL_SECONDS?.trim() || 86_400);
  if (!Number.isSafeInteger(approvalTtlSeconds) || approvalTtlSeconds < 60 || approvalTtlSeconds > 30 * 86_400) {
    throw new ConfigError(`APPROVAL_TTL_SECONDS must be a whole number of seconds from 60 to 2592000 (30 days), got "${env.APPROVAL_TTL_SECONDS}".`);
  }

  const events = Object.freeze({
    // First block to index when the database has no indexer state yet. Default: the Deploy.s.sol broadcast block.
    startBlock: optionalInt(env, "EVENTS_START_BLOCK", { min: 0, max: Number.MAX_SAFE_INTEGER, def: null }),
    chunkSize: optionalInt(env, "EVENTS_CHUNK_SIZE", { min: 1, max: 100_000, def: 5000 }),
    pollMs: optionalInt(env, "EVENTS_POLL_MS", { min: 0, max: 600_000, def: 4000 }), // 0 = no background polling
    confirmations: optionalInt(env, "EVENTS_CONFIRMATIONS", { min: 0, max: 1000, def: chainId === 31337 ? 0 : 2 }),
  });

  return Object.freeze({
    chainId,
    chain,
    rpcUrl,
    addresses,
    agent,
    submitter,
    dbPath: env.DB_PATH?.trim() || "data/agent.sqlite",
    port: Number(env.PORT?.trim() || 8787),
    approvalTtlSeconds, // owner approvals expire this long after the request is created
    events,
    // Safe summary for logs: addresses only.
    toJSON() {
      return { chainId, wallet: addresses.wallet, agent: agent.address, submitter: submitter.address };
    },
  });
}
