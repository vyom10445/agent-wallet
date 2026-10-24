// Shared harness for the security suite: the real API client over a mocked fetch (backend), the real chain reads over
// a fake JSON-RPC transport (public RPC), and the real owner wallet store over a mocked EIP-1193 provider.
import { custom, decodeFunctionData, encodeFunctionData, encodeFunctionResult, type Hex } from 'viem'
import { createApiClient } from '../../src/api/client'
import type { OwnerApproval, PurchaseRequest } from '../../src/api/types'
import { createChainReads } from '../../src/chain/reads'
import { createOwnerWallet } from '../../src/chain/wallet'
import { ABI } from '../../src/config'
import { mockProvider } from '../helpers/eip1193'
import { AGENT, BOOK, mockFetch } from '../helpers/fixtures'

export const PRICE = 1_500_000n
export const STANDING = 9_800_000n
export const OTHER = '0x1111111111111111111111111111111111111111' as const
export const REQ = 'req_00000000000000aa'
const amt = (v: bigint) => ({ base: v.toString(), mUSDC: (Number(v) / 1e6).toString() })

export function honestApproval(credits = 150n, price = PRICE, standing = STANDING): OwnerApproval {
  return {
    wallet: BOOK.wallet, function: 'executeBatch', price: amt(price), standingAllowance: amt(standing),
    args: {
      dest: [BOOK.usdc, BOOK.merchant], value: [],
      func: [
        encodeFunctionData({ abi: ABI.usdc, functionName: 'approve', args: [BOOK.merchant, standing + price] }),
        encodeFunctionData({ abi: ABI.merchant, functionName: 'purchase', args: [credits, price] }),
      ],
    },
    calls: [
      { to: BOOK.usdc, function: 'approve', args: { spender: BOOK.merchant, value: amt(standing + price) } },
      { to: BOOK.merchant, function: 'purchase', args: { credits: Number(credits), payment: amt(price) } },
    ],
    signWith: 'script/OwnerApprovePurchase.s.sol', readAt: 1761317000,
  }
}

export const request = (over: Partial<PurchaseRequest> = {}): PurchaseRequest => ({
  id: REQ, status: 'needs_owner_approval', path: null, precheck: 'NEEDS_OWNER', credits: 150, reason: 'user asked', price: amt(PRICE),
  amountPaid: null, purchaseId: null, agent: AGENT, nonce: null, userOpHash: null, txHash: null, blockNumber: null, actualGasCost: null,
  error: null, explorerUrl: null, conversationId: 'default', expiresAt: null, createdAt: 1761317000, updatedAt: 1761317000,
  ownerApproval: honestApproval(), ...over,
})

/** A fake public RPC. `chain.price` can be changed mid-test; `chain.pauseSimulate` holds the executeBatch eth_call. */
export function fakeChain() {
  const chain = {
    price: PRICE, standing: STANDING, rpcDown: false, calls: [] as string[],
    pauseSimulate: null as null | Promise<void>,
  }
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      chain.calls.push(method)
      if (chain.rpcDown) throw new Error('fetch failed: RPC unreachable')
      if (method === 'eth_chainId') return '0x14a34'
      if (method === 'eth_blockNumber') return '0x100'
      if (method === 'eth_getTransactionReceipt') {
        return { transactionHash: (params as [Hex])[0], blockHash: `0x${'11'.repeat(32)}`, blockNumber: '0x100', status: '0x1', logs: [], from: BOOK.owner, to: BOOK.wallet,
          gasUsed: '0x1', cumulativeGasUsed: '0x1', effectiveGasPrice: '0x1', transactionIndex: '0x0', type: '0x2', logsBloom: `0x${'00'.repeat(256)}`, contractAddress: null }
      }
      if (method === 'eth_getTransactionByHash') return null
      if (method !== 'eth_call') throw new Error(`unexpected ${method}`)
      const { to, data } = (params as [{ to: string; data: Hex }])[0]
      const t = to.toLowerCase()
      const abi = t === BOOK.wallet.toLowerCase() ? ABI.wallet : t === BOOK.merchant.toLowerCase() ? ABI.merchant : ABI.usdc
      const { functionName, args = [] } = decodeFunctionData({ abi, data })
      chain.calls.push(functionName)
      if (functionName === 'executeBatch') {
        if (chain.pauseSimulate) await chain.pauseSimulate
        return '0x'
      }
      const result = functionName === 'owner' ? BOOK.owner
        : functionName === 'quote' ? ((args[0] as bigint) * chain.price) / 150n
        : functionName === 'allowance' ? chain.standing : undefined
      return encodeFunctionResult({ abi, functionName, result })
    },
  })
  return { chain, transport }
}

export async function setup(opts: { req?: PurchaseRequest; requestRoute?: [number, unknown]; accounts?: string[]; chainId?: number } = {}) {
  const { chain, transport } = fakeChain()
  const reads = createChainReads(BOOK, transport)
  const backend = mockFetch({
    [`/requests/${REQ}`]: opts.requestRoute ?? [200, opts.req ?? request()],
    [`/approvals/${REQ}/verify`]: [200, { request: { id: REQ, status: 'fulfilled_by_owner', txHash: `0x${'ab'.repeat(32)}`, purchaseId: '9', amountPaid: amt(PRICE) }, checks: [] }],
  })
  const api = createApiClient({ baseUrl: 'http://127.0.0.1:8787', fetch: backend.fetch })
  const eth = mockProvider({ accounts: opts.accounts ?? [BOOK.owner], chainId: opts.chainId ?? 84532 })
  const wallet = createOwnerWallet({ provider: eth.provider, expectedChainId: 84532, readOwner: reads.owner, storage: null })
  await wallet.connect()
  return { chain, reads, api, backend, eth, wallet }
}
