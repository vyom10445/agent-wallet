import { custom, decodeFunctionData, encodeFunctionResult, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { createChainReads } from '../src/chain/reads'
import { ABI } from '../src/config'
import { AGENT, BOOK } from './helpers/fixtures'

// A fake RPC: answers eth_call by decoding the call against the real ABIs and encoding a canned result.
function fakeRpc() {
  const calls: { to: string; functionName: string; args: readonly unknown[] }[] = []
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      if (method === 'eth_chainId') return '0x14a34'
      if (method !== 'eth_call') throw new Error(`unexpected ${method}`)
      const { to, data } = (params as [{ to: string; data: Hex }])[0]
      const abi = to.toLowerCase() === BOOK.wallet.toLowerCase() ? ABI.wallet : to.toLowerCase() === BOOK.merchant.toLowerCase() ? ABI.merchant : ABI.usdc
      const { functionName, args = [] } = decodeFunctionData({ abi, data })
      calls.push({ to, functionName, args })
      const result =
        functionName === 'owner' ? BOOK.owner
        : functionName === 'quote' ? (args[0] as bigint) * 10_000n
        : functionName === 'allowance' ? 9_800_000n
        : functionName === 'getAgent'
          ? { active: true, validAfter: 1761300000, validUntil: 1761904800, token: BOOK.usdc, maxPerTx: 1_000_000n, dailyLimit: 5_000_000n, spentToday: 100_000n }
          : undefined
      return encodeFunctionResult({ abi, functionName, result })
    },
  })
  return { transport, calls }
}

describe('chain reads', () => {
  it('reads owner, quote, allowance and getAgent from the deployment addresses', async () => {
    const rpc = fakeRpc()
    const reads = createChainReads(BOOK, rpc.transport)
    expect(reads.chain.id).toBe(84532)
    expect(await reads.owner()).toBe(BOOK.owner)
    expect(await reads.quote(150)).toBe(1_500_000n)
    expect(await reads.allowance()).toBe(9_800_000n)
    expect(await reads.getAgent(AGENT)).toEqual({
      active: true, validAfter: 1761300000, validUntil: 1761904800, token: BOOK.usdc,
      maxPerTx: 1_000_000n, dailyLimit: 5_000_000n, spentToday: 100_000n,
    })
    expect(rpc.calls.map((c) => [c.to.toLowerCase(), c.functionName, c.args])).toEqual([
      [BOOK.wallet.toLowerCase(), 'owner', []],
      [BOOK.merchant.toLowerCase(), 'quote', [150n]],
      [BOOK.usdc.toLowerCase(), 'allowance', [BOOK.wallet, BOOK.merchant]],
      [BOOK.wallet.toLowerCase(), 'getAgent', [AGENT]],
    ])
  })

  it('refuses zero credits and unsupported chains', async () => {
    const reads = createChainReads(BOOK, fakeRpc().transport)
    await expect(reads.quote(0)).rejects.toThrow('at least 1')
    expect(() => createChainReads({ ...BOOK, chainId: 1 })).toThrow('not supported')
  })
})
