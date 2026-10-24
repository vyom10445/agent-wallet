// Display helpers. Amounts are never converted to JavaScript numbers: mUSDC is shown exactly as the backend formatted it,
// and every comparison or calculation uses BigInt(Amount.base).
import { formatEther, formatUnits, parseUnits } from 'viem'
import type { Amount } from '../api/types'
import { USDC_DECIMALS } from '../config'

/** "1.5 mUSDC", from Amount.mUSDC as given. null/undefined -> "—". */
export const formatAmount = (a: Amount | null | undefined) => (a ? `${a.mUSDC} mUSDC` : '—')

/** The exact base units of an Amount. Throws on anything that is not a non-negative integer string. */
export function amountBase(a: Amount): bigint {
  if (!/^\d+$/.test(a.base)) throw new Error(`Not a base-unit amount: ${a.base}`)
  return BigInt(a.base)
}

/** -1, 0 or 1, like a sort comparator, on base units. */
export function compareAmounts(a: Amount, b: Amount): -1 | 0 | 1 {
  const x = amountBase(a)
  const y = amountBase(b)
  return x < y ? -1 : x > y ? 1 : 0
}

/** Builds an Amount from base units (for values the browser read on chain itself). */
export const amountFromBase = (base: bigint): Amount => ({ base: base.toString(), mUSDC: formatUnits(base, USDC_DECIMALS) })

/** Parses typed mUSDC ("1.5") to base units; null if it is not a valid non-negative amount with at most 6 decimals. */
export function parseMusdc(text: string): bigint | null {
  const t = text.trim()
  if (!/^\d+(\.\d{1,6})?$/.test(t)) return null
  return parseUnits(t, USDC_DECIMALS)
}

/** Whole percent of part/whole, clamped to 0..100; 0 when whole is 0. */
export function percent(part: Amount, whole: Amount): number {
  const w = amountBase(whole)
  if (w === 0n) return 0
  const p = (amountBase(part) * 100n) / w
  return Number(p > 100n ? 100n : p)
}

/** Wei (decimal string) as ETH, e.g. "0.00499 ETH". */
export function formatWei(wei: string | null | undefined): string {
  if (wei === null || wei === undefined || !/^\d+$/.test(wei)) return '—'
  return `${formatEther(BigInt(wei))} ETH`
}

/** Unix seconds -> local and UTC strings. */
export function formatTime(unixSeconds: number | null | undefined, locale?: string): { local: string; utc: string } | null {
  if (unixSeconds === null || unixSeconds === undefined || !Number.isFinite(unixSeconds)) return null
  const d = new Date(unixSeconds * 1000)
  return {
    local: d.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'medium' }),
    utc: `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`,
  }
}

/** "in 3 d 4 h" / "5 min ago" relative to now (unix seconds). */
export function formatRelative(unixSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const diff = unixSeconds - nowSeconds
  const s = Math.abs(diff)
  const parts =
    s < 60 ? `${s} s`
    : s < 3600 ? `${Math.floor(s / 60)} min`
    : s < 86400 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
    : `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`
  return diff >= 0 ? `in ${parts}` : `${parts} ago`
}

/** 0x74cD…5c1A (first 6, last 4). Anything that is not an address is returned unchanged. */
export const shortAddress = (address: string | null | undefined) =>
  !address ? '—' : /^0x[0-9a-fA-F]{40}$/.test(address) ? `${address.slice(0, 6)}…${address.slice(-4)}` : address

/** 0xabcd…1234 for a 32-byte hash. */
export const shortHash = (hash: string | null | undefined) =>
  !hash ? '—' : /^0x[0-9a-fA-F]{64}$/.test(hash) ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash

/** Case-insensitive address equality; false for missing values. */
export const sameAddress = (a: string | null | undefined, b: string | null | undefined) =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
