import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PurchaseRequest } from '../src/api/types'
import { ProofBadge } from '../src/components/ProofBadge'
import { RequestDetailView } from '../src/components/requests/RequestDetailView'
import { RequestRow } from '../src/components/requests/RequestRow'
import { statusView } from '../src/lib/requestStatus'
import {
  IN_FLIGHT_POLL_MS, LIST_POLL_MS, PAGE_SIZE, listPollMs, mergeNewest, mergeOlder, nextBefore, parseStatusList,
} from '../src/lib/requestsList'

const TX = `0x${'ab'.repeat(32)}` as const
const XSS = '<img src=x onerror=alert(1)>'
let n = 0
const req = (over: Partial<PurchaseRequest> = {}): PurchaseRequest => ({
  id: `req_${(n++).toString(16).padStart(16, '0')}`, status: 'succeeded', path: 'agent', precheck: 'AGENT_OK', credits: 10,
  reason: 'user asked', price: { base: '100000', mUSDC: '0.1' }, amountPaid: { base: '100000', mUSDC: '0.1' }, purchaseId: '7',
  agent: '0xC74Ba823524Cbd1d889b5FD38785b9d293C6D8aD', nonce: '1157920892373161954235709850086879078532699846656405640394575840079131', userOpHash: `0x${'cd'.repeat(32)}`,
  txHash: TX, blockNumber: 12345670, actualGasCost: '123000000000', error: null, explorerUrl: `https://sepolia.basescan.org/tx/${TX}`,
  conversationId: 'default', expiresAt: null, createdAt: 1761317000, updatedAt: 1761317009, ...over,
})
const html = (el: React.ReactElement) => renderToStaticMarkup(el)
const row = (r: PurchaseRequest) => html(<table><tbody><RequestRow request={r} selected={false} /></tbody></table>)
const detail = (r: PurchaseRequest) => html(<RequestDetailView request={r} now={1761317100} errorText={null} />)

describe('paid badge rule', () => {
  it.each(['succeeded', 'fulfilled_by_owner'] as const)('%s with proofVerified true is paid', (status) => {
    const out = html(<ProofBadge request={{ status, proofVerified: true }} />)
    expect(out).toContain('data-proof="paid"')
    expect(statusView({ status, proofVerified: true }).paid).toBe(true)
  })

  it.each(['succeeded', 'fulfilled_by_owner'] as const)('%s with proofVerified false is a red warning, not paid', (status) => {
    const out = html(<ProofBadge request={{ status, proofVerified: false }} />)
    expect(out).toContain('data-proof="false"')
    expect(out).toContain('Proof does not hold')
    expect(out).not.toContain('Paid ·')
    expect(statusView({ status, proofVerified: false })).toMatchObject({ paid: false, tone: 'red' })
  })

  it.each(['succeeded', 'fulfilled_by_owner'] as const)('%s with proofVerified null or missing is grey "could not check", not paid', (status) => {
    for (const proofVerified of [null, undefined]) {
      const out = html(<ProofBadge request={{ status, proofVerified }} />)
      expect(out).toContain('data-proof="unknown"')
      expect(out).toContain('Could not check the chain')
      expect(statusView({ status, proofVerified })).toMatchObject({ paid: false, tone: 'grey' })
    }
  })

  it('never marks other statuses as paid, even with proofVerified true', () => {
    for (const status of ['received', 'precheck_failed', 'submitted', 'failed_onchain', 'needs_owner_approval', 'rejected', 'expired'] as const) {
      expect(html(<ProofBadge request={{ status, proofVerified: true }} />)).toBe('')
      expect(statusView({ status, proofVerified: true }).paid).toBe(false)
    }
  })

  it('rows and details show the paid wording only with proof', () => {
    expect(row(req({ proofVerified: true }))).toContain('Bought by agent')
    for (const proofVerified of [false, null, undefined]) {
      expect(row(req({ proofVerified })).toLowerCase()).not.toContain('bought')
      expect(detail(req({ proofVerified })).toLowerCase()).not.toContain('paid ·')
    }
  })
})

describe('list rows', () => {
  it('shows label, credits, price, path, created time, tx link and error code', () => {
    const out = row(req({ status: 'failed_onchain', proofVerified: undefined, amountPaid: null, error: { code: 'ExceedsDailyLimit', message: 'ExceedsDailyLimit(600000, 400000)' } }))
    for (const s of ['Failed on chain', '>10<', '0.1 mUSDC', '>agent<', 'ExceedsDailyLimit', `href="https://sepolia.basescan.org/tx/${TX}"`, '#/requests/req_']) expect(out, s).toContain(s)
  })
  it('owner request without a tx shows dashes and no link', () => {
    const out = row(req({ status: 'needs_owner_approval', path: 'owner', txHash: null, explorerUrl: null, price: null }))
    expect(out).toContain('Needs your signature')
    expect(out).not.toContain('basescan')
  })
})

describe('detail view', () => {
  it('shows the decoded error reason and its meaning', () => {
    const out = detail(req({ status: 'failed_onchain', proofVerified: undefined, error: { code: 'ExceedsDailyLimit', message: 'ExceedsDailyLimit(600000, 400000)' } }))
    expect(out).toContain('ExceedsDailyLimit(600000, 400000)')
    expect(out).toContain('Above what the agent may still spend today.')
  })
  it('shows userOpHash, nonce and gas for agent requests', () => {
    const out = detail(req({ proofVerified: true }))
    expect(out).toContain(`0x${'cd'.repeat(32)}`)
    expect(out).toContain('1157920892373161954235709850086879078532699846656405640394575840079131')
    expect(out).toContain('ETH')
  })
  it('shows expiresAt for owner requests and the approve link while waiting', () => {
    const r = req({ status: 'needs_owner_approval', path: 'owner', precheck: 'NEEDS_OWNER', expiresAt: 1761403400, txHash: null, userOpHash: null, nonce: null,
      ownerApproval: { wallet: '0x74cD24BBaf39022155d2912923F4dC234D215c1A', function: 'executeBatch', price: { base: '5000000', mUSDC: '5' }, standingAllowance: { base: '0', mUSDC: '0' },
        args: { dest: ['0x1', '0x2'] as never, value: [], func: ['0x', '0x'] }, calls: [] as never, signWith: 'owner wallet', readAt: 1761317090 } })
    const out = detail(r)
    expect(out).toContain('Expires')
    expect(out).toContain('expires in 23 h 58 min')
    expect(out).toContain('href="#/approve/')
    expect(out).not.toContain('UserOp hash')
  })
  it('lists proofChecks when present', () => {
    const out = detail(req({ proofVerified: false, proofChecks: [{ name: 'receipt_success', ok: true }, { name: 'credits_purchased', ok: false, detail: 'no CreditsPurchased event' }] }))
    expect(out).toContain('Proof checks')
    expect(out).toContain('receipt_success')
    expect(out).toContain('no CreditsPurchased event')
  })
  it('labels the reason as untrusted and shows HTML in it as text', () => {
    const out = detail(req({ reason: XSS, error: { code: 'UNKNOWN', message: XSS } }))
    expect(out).toContain("Agent&#x27;s reason (untrusted)")
    expect(out).not.toContain('<img')
    expect(out.split('&lt;img').length - 1).toBe(2)
  })
})

describe('list logic', () => {
  it('parses a comma status list and reports unknown values', () => {
    expect(parseStatusList(' succeeded, failed_onchain ,succeeded')).toEqual({ statuses: ['succeeded', 'failed_onchain'], unknown: [] })
    expect(parseStatusList('paid,submitted').unknown).toEqual(['paid'])
  })
  it('pages back from the oldest createdAt without losing rows from the same second', () => {
    const rows = [req({ createdAt: 300 }), req({ createdAt: 200 }), req({ createdAt: 200 })]
    expect(nextBefore(rows)).toBe(201)
    expect(nextBefore([])).toBeUndefined()
    const sameSecond = req({ createdAt: 200 })
    const page = [rows[1], rows[2], sameSecond, req({ createdAt: 100 })]
    const merged = mergeOlder(rows, page, 4)
    expect(merged.rows.map((r) => r.id)).toEqual([...rows, sameSecond, page[3]].map((r) => r.id))
    expect(merged.hasMore).toBe(true)
    expect(mergeOlder(merged.rows, page, 4).hasMore).toBe(false) // nothing new: stop
    expect(mergeOlder(rows, [req({ createdAt: 50 })], PAGE_SIZE).hasMore).toBe(false) // short page: the end
  })
  it('a refresh of the newest page updates rows in place and keeps older pages', () => {
    const a = req({ createdAt: 300, status: 'submitted' })
    const b = req({ createdAt: 200 })
    const old = req({ createdAt: 100 })
    const next = mergeNewest([a, b, old], [req({ createdAt: 400 }), { ...a, status: 'succeeded' }, b])
    expect(next.map((r) => r.createdAt)).toEqual([400, 300, 200, 100])
    expect(next[1].status).toBe('succeeded')
  })
  it('polls every 3 s while a row is received or submitted, else every 10 s', () => {
    expect(listPollMs([req({ status: 'submitted' })])).toBe(IN_FLIGHT_POLL_MS)
    expect(listPollMs([req({ status: 'received' })])).toBe(IN_FLIGHT_POLL_MS)
    expect(listPollMs([req(), req({ status: 'needs_owner_approval' })])).toBe(LIST_POLL_MS)
  })
})
