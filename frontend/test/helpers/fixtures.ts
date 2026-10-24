// Backend responses shaped exactly like backend/docs/BACKEND_API.md v1, using the live Base Sepolia addresses.
import type { Health, WalletStatus } from '../../src/api/types'
import { DEPLOYMENTS } from '../../src/config'

export const BOOK = DEPLOYMENTS[84532]
export const AGENT = '0xC74Ba823524Cbd1d889b5FD38785b9d293C6D8aD'

const amount = (base: string, mUSDC: string) => ({ base, mUSDC })

export const health = (over: Partial<Health> = {}): Health => ({
  ok: true, apiVersion: '1', chainId: 84532, wallet: BOOK.wallet, agent: AGENT, llm: 'fallback', dbPath: 'data/agent.sqlite',
  events: { indexedToBlock: 12345678, lastError: null, polling: true },
  ...over,
})

export const walletStatus = (addresses: Partial<WalletStatus['addresses']> = {}): WalletStatus => ({
  chainId: 84532, blockNumber: 12345678, readAt: 1761317000,
  addresses: { wallet: BOOK.wallet, owner: BOOK.owner, entryPoint: BOOK.entryPoint, usdc: BOOK.usdc, merchant: BOOK.merchant, agent: AGENT, ...addresses },
  agent: {
    active: true, validNow: true, validAfter: 1761300000, validUntil: 1761904800, validUntilIso: '2026-10-31T10:00:00Z',
    token: BOOK.usdc,
    maxPerTx: amount('1000000', '1'), dailyLimit: amount('5000000', '5'),
    spentToday: amount('100000', '0.1'), remainingDailyAllowance: amount('4900000', '4.9'),
    canPurchase: true, merchantAllowed: true, nonceKey: AGENT.toLowerCase(), nextNonce: '0',
  },
  wallet: { balance: amount('99800000', '99.8'), merchantAllowance: amount('9800000', '9.8'), entryPointDeposit: '4990000000000000', credits: 20 },
  merchant: { pricePerCredit: amount('10000', '0.01'), purchaseCount: 3 },
  submitter: { address: '0x1111111111111111111111111111111111111111', ethBalance: '20000000000000000' },
  warnings: ['DEPOSIT_LOW'],
})

/** A fetch mock: routes[path] returns [status, body] (body undefined -> empty response). Records every call. */
export function mockFetch(routes: Record<string, [number, unknown] | (() => never)>) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const path = new URL(url).pathname
    const route = routes[path]
    if (!route) return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'No such endpoint' } }), { status: 404 })
    if (typeof route === 'function') return route()
    const [status, body] = route
    return new Response(body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }
  return { fetch: fn as typeof fetch, calls }
}
