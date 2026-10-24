import { describe, expect, it } from 'vitest'
import {
  amountBase, amountFromBase, compareAmounts, formatAmount, formatRelative, formatTime, formatWei, parseMusdc, percent,
  sameAddress, shortAddress, shortHash,
} from '../src/lib/format'

const a = (base: string, mUSDC: string) => ({ base, mUSDC })

describe('amounts', () => {
  it('shows mUSDC exactly as given', () => {
    expect(formatAmount(a('1500000', '1.5'))).toBe('1.5 mUSDC')
    expect(formatAmount(null)).toBe('—')
  })

  it('compares with BigInt base units, beyond float precision', () => {
    const big = a('9007199254740993000000', '9007199254740993')
    const bigger = a('9007199254740993000001', '9007199254740993.000001')
    expect(compareAmounts(big, bigger)).toBe(-1)
    expect(compareAmounts(bigger, big)).toBe(1)
    expect(compareAmounts(big, { ...big })).toBe(0)
    expect(amountBase(bigger)).toBe(9007199254740993000001n)
  })

  it('rejects non-integer base strings', () => {
    expect(() => amountBase(a('1.5', '0.0000015'))).toThrow()
    expect(() => amountBase(a('-1', '-0.000001'))).toThrow()
  })

  it('builds and parses mUSDC without floats', () => {
    expect(amountFromBase(1500000n)).toEqual(a('1500000', '1.5'))
    expect(parseMusdc('1.5')).toBe(1500000n)
    expect(parseMusdc(' 0.000001 ')).toBe(1n)
    expect(parseMusdc('0.1')).toBe(100000n)
    for (const bad of ['', '1.2345678', '-1', '1e6', 'abc', '1.']) expect(parseMusdc(bad)).toBeNull()
  })

  it('computes whole percent with BigInt, clamped', () => {
    expect(percent(a('100000', '0.1'), a('5000000', '5'))).toBe(2)
    expect(percent(a('5000000', '5'), a('5000000', '5'))).toBe(100)
    expect(percent(a('7000000', '7'), a('5000000', '5'))).toBe(100)
    expect(percent(a('1', '0.000001'), a('0', '0'))).toBe(0)
  })

  it('formats wei as ETH', () => {
    expect(formatWei('4990000000000000')).toBe('0.00499 ETH')
    expect(formatWei(null)).toBe('—')
  })
})

describe('times and addresses', () => {
  it('gives local and UTC strings for unix seconds', () => {
    const t = formatTime(1761904800)
    expect(t?.utc).toBe('2025-10-31 10:00:00 UTC')
    expect(t?.local.length).toBeGreaterThan(5)
    expect(formatTime(null)).toBeNull()
  })

  it('formats relative times', () => {
    expect(formatRelative(1000 + 90061, 1000)).toBe('in 1 d 1 h')
    expect(formatRelative(1000 - 300, 1000)).toBe('5 min ago')
    expect(formatRelative(1000 + 3720, 1000)).toBe('in 1 h 2 min')
  })

  it('shortens and compares addresses and hashes', () => {
    expect(shortAddress('0x74cD24BBaf39022155d2912923F4dC234D215c1A')).toBe('0x74cD…5c1A')
    expect(shortAddress('not an address')).toBe('not an address')
    expect(shortHash(`0x${'ab'.repeat(32)}`)).toBe('0xabab…abab')
    expect(sameAddress('0x74cd24bbaf39022155d2912923f4dc234d215c1a', '0x74cD24BBaf39022155d2912923F4dC234D215c1A')).toBe(true)
    expect(sameAddress(undefined, '0x0')).toBe(false)
  })
})
