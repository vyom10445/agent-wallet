// App configuration. The only env value is VITE_API_URL: no keys, no RPC secrets (everything VITE_ ends up in the bundle).
// Addresses come from contracts/deployments/<chainId>.json and ABIs from abi/, both read at build time and never copied.
// The deployment is picked by the backend's chainId from GET /health (see lib/startup.ts).
import type { Abi, Chain } from 'viem'
import { anvil, baseSepolia } from 'viem/chains'
import agentWalletAbi from '../../abi/AgentWallet.json'
import mockMerchantAbi from '../../abi/MockMerchant.json'
import mockUsdcAbi from '../../abi/MockUSDC.json'
import type { Address } from './api/types'

export const DEFAULT_API_URL = 'http://127.0.0.1:8787'

/** Trims trailing slashes; falls back to the default for an empty or non-http(s) value. */
export function resolveApiUrl(raw: string | undefined): string {
  const value = raw?.trim().replace(/\/+$/, '')
  return value && /^https?:\/\/[^\s/]+/i.test(value) ? value : DEFAULT_API_URL
}

export const API_URL = resolveApiUrl(import.meta.env.VITE_API_URL)

export type Deployment = {
  chainId: number
  entryPoint: Address
  factory: Address
  implementation: Address
  merchant: Address
  owner: Address
  usdc: Address
  wallet: Address
}

// A glob, not static imports: 31337.json exists only after a local deploy, and a missing static import breaks the build.
const files = import.meta.glob<Deployment>('../../contracts/deployments/*.json', { eager: true, import: 'default' })

export const DEPLOYMENTS: Readonly<Record<number, Deployment>> = Object.fromEntries(
  Object.values(files).map((d) => [d.chainId, d]),
)

export const SUPPORTED_CHAINS: Readonly<Record<number, Chain>> = { [baseSepolia.id]: baseSepolia, [anvil.id]: anvil }

const EXPLORERS: Readonly<Record<number, string>> = { [baseSepolia.id]: 'https://sepolia.basescan.org' }

/** BaseScan links exist for Base Sepolia only; on Anvil there is no explorer. */
export const explorerTxUrl = (chainId: number, hash: string) =>
  EXPLORERS[chainId] && /^0x[0-9a-fA-F]{64}$/.test(hash) ? `${EXPLORERS[chainId]}/tx/${hash}` : null
export const explorerAddressUrl = (chainId: number, address: string) =>
  EXPLORERS[chainId] && /^0x[0-9a-fA-F]{40}$/.test(address) ? `${EXPLORERS[chainId]}/address/${address}` : null

// JSON imports are typed loosely, so viem cannot infer names or return types: chain/reads.ts types each result itself.
export const ABI = {
  wallet: agentWalletAbi as Abi,
  usdc: mockUsdcAbi as Abi,
  merchant: mockMerchantAbi as Abi,
} as const

export const USDC_DECIMALS = 6
