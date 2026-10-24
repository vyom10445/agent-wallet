// Direct chain reads through viem's public RPC for the selected chain, never through the injected wallet (the wallet's
// RPC is the user's choice and may be on another network). Used to check the backend's claims independently:
// owner() for the connected account, quote() and allowance() to rebuild the owner approval (UI_SPEC §2.4).
import { createPublicClient, http, type PublicClient, type Transport } from 'viem'
import { ABI, SUPPORTED_CHAINS, type Deployment } from '../config'
import type { Address } from '../api/types'

/** AgentWallet.getAgent(agent) -> IAgentWallet.AgentInfo (abi/AgentWallet.json). Amounts in mUSDC base units. */
export type AgentInfo = {
  active: boolean
  validAfter: number
  validUntil: number
  token: Address
  maxPerTx: bigint
  dailyLimit: bigint
  spentToday: bigint
}

export type ChainReads = ReturnType<typeof createChainReads>

/** @param transport only for tests; the app uses the chain's public RPC (https://sepolia.base.org on Base Sepolia). */
export function createChainReads(deployment: Deployment, transport: Transport = http()) {
  const chain = SUPPORTED_CHAINS[deployment.chainId]
  if (!chain) throw new Error(`Chain ${deployment.chainId} is not supported (use 84532 Base Sepolia or 31337 Anvil)`)
  const client: PublicClient = createPublicClient({ chain, transport })
  const { wallet, merchant, usdc } = deployment

  return {
    chain,
    client,
    deployment,

    /** AgentWallet.owner(): the only EOA that can sign executeBatch directly. */
    owner: async () => (await client.readContract({ address: wallet, abi: ABI.wallet, functionName: 'owner' })) as Address,

    /** MockMerchant.quote(credits) in mUSDC base units. */
    quote: async (credits: number | bigint) => {
      const n = BigInt(credits)
      if (n < 1n) throw new Error('credits must be at least 1')
      return (await client.readContract({ address: merchant, abi: ABI.merchant, functionName: 'quote', args: [n] })) as bigint
    },

    /** MockUSDC.allowance(wallet, merchant) in base units: the standing allowance the owner batch returns to. */
    allowance: async () =>
      (await client.readContract({ address: usdc, abi: ABI.usdc, functionName: 'allowance', args: [wallet, merchant] })) as bigint,

    /** AgentWallet.getAgent(agent). */
    getAgent: async (agent: Address): Promise<AgentInfo> => {
      const info = (await client.readContract({ address: wallet, abi: ABI.wallet, functionName: 'getAgent', args: [agent] })) as {
        active: boolean; validAfter: number | bigint; validUntil: number | bigint; token: Address
        maxPerTx: bigint; dailyLimit: bigint; spentToday: bigint
      }
      return {
        active: info.active,
        validAfter: Number(info.validAfter),
        validUntil: Number(info.validUntil),
        token: info.token,
        maxPerTx: info.maxPerTx,
        dailyLimit: info.dailyLimit,
        spentToday: info.spentToday,
      }
    },
  }
}
