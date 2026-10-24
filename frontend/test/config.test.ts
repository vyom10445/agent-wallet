import { describe, expect, it } from 'vitest'
import { ABI, DEPLOYMENTS, DEFAULT_API_URL, explorerTxUrl, resolveApiUrl } from '../src/config'

describe('config', () => {
  it('loads the Base Sepolia address book from contracts/deployments', () => {
    expect(DEPLOYMENTS[84532]).toMatchObject({ chainId: 84532, wallet: '0x74cD24BBaf39022155d2912923F4dC234D215c1A' })
  })

  it('loads the ABIs from abi/', () => {
    const names = (abi: readonly { type: string; name?: string }[]) => abi.filter((x) => x.type === 'function').map((x) => x.name)
    expect(names(ABI.wallet)).toEqual(expect.arrayContaining(['executeBatch', 'owner', 'getAgent']))
    expect(names(ABI.merchant)).toEqual(expect.arrayContaining(['quote', 'purchase']))
    expect(names(ABI.usdc)).toEqual(expect.arrayContaining(['allowance', 'approve']))
  })

  it('uses VITE_API_URL or the default', () => {
    expect(resolveApiUrl(undefined)).toBe(DEFAULT_API_URL)
    expect(resolveApiUrl('  ')).toBe(DEFAULT_API_URL)
    expect(resolveApiUrl('http://127.0.0.1:9000/')).toBe('http://127.0.0.1:9000')
    expect(resolveApiUrl('javascript:alert(1)')).toBe(DEFAULT_API_URL)
  })

  it('links BaseScan only on Base Sepolia and only for real hashes', () => {
    const tx = `0x${'ab'.repeat(32)}`
    expect(explorerTxUrl(84532, tx)).toBe(`https://sepolia.basescan.org/tx/${tx}`)
    expect(explorerTxUrl(31337, tx)).toBeNull()
    expect(explorerTxUrl(84532, '0x12"><script>')).toBeNull()
  })
})
