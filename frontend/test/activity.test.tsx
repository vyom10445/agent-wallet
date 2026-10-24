import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChainEvent, Health } from '../src/api/types'
import { EventRow } from '../src/components/activity/EventRow'
import { IndexerStatus } from '../src/components/activity/IndexerStatus'
import {
  EVENT_TYPES, LAG_BLOCKS, eventKey, eventParts, indexerView, labelView, mergeNewest, mergeOlder, nextBefore, nonceKeyText, safeRequestId, toggleType,
} from '../src/lib/activity'
import { parseRoute } from '../src/lib/routes'
import { AGENT, BOOK } from './helpers/fixtures'

const XSS = '<img src=x onerror=alert(1)>'
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`
const amt = (base: string, mUSDC: string) => ({ base, mUSDC })
const AGENT_KEY = AGENT.toLowerCase()

const ev = (over: Partial<ChainEvent> & Pick<ChainEvent, 'type' | 'args'>): ChainEvent => ({
  emitter: 'merchant', blockNumber: 100, timestamp: 1761317000, txHash: tx(1), logIndex: 0, label: 'agent', requestId: null, ...over,
}) as ChainEvent

// The two Phase 8 purchases: the agent's 10 credits (UserOp) and the owner's 150 credits (direct executeBatch).
const agentPurchase = ev({ type: 'CreditsPurchased', label: 'agent', blockNumber: 120, txHash: tx(10), logIndex: 4, requestId: 'req_0000000000000010',
  args: { purchaseId: '8', buyer: BOOK.wallet, credits: '10', amountPaid: amt('100000', '0.1') } })
const agentOp = ev({ type: 'UserOperationEvent', emitter: 'entryPoint', label: 'agent', blockNumber: 120, txHash: tx(10), logIndex: 5, requestId: 'req_0000000000000010',
  args: { userOpHash: tx(99), sender: BOOK.wallet, paymaster: `0x${'0'.repeat(40)}`, nonce: '1', nonceKey: AGENT_KEY, nonceSequence: '3', success: true, actualGasCost: '123000000000', actualGasUsed: '456' } })
const ownerPurchase = ev({ type: 'CreditsPurchased', label: 'owner', blockNumber: 130, txHash: tx(20), logIndex: 2, requestId: 'req_0000000000000150',
  args: { purchaseId: '9', buyer: BOOK.wallet, credits: '150', amountPaid: amt('1500000', '1.5') } })
const revert = ev({ type: 'UserOperationRevertReason', emitter: 'entryPoint', label: 'agent', blockNumber: 110, txHash: tx(5), logIndex: 1,
  args: { userOpHash: tx(98), sender: BOOK.wallet, nonce: '2', nonceKey: AGENT_KEY, nonceSequence: '2', revertReason: '0xdeadbeef', reason: 'ExceedsPerTxLimit(1010000, 1000000)' } })

const row = (e: ChainEvent, chainId = 84532) => renderToStaticMarkup(<table><tbody><EventRow event={e} chainId={chainId} /></tbody></table>)

describe('event rows', () => {
  it('the agent purchase is labelled agent and the owner purchase owner, each linked to its request and BaseScan', () => {
    const a = row(agentPurchase)
    expect(a).toContain('data-who="agent"')
    expect(a).toContain('href="#/requests/req_0000000000000010"')
    expect(a).toContain(`href="https://sepolia.basescan.org/tx/${tx(10)}"`)
    expect(a).toContain('0.1 mUSDC')
    const o = row(ownerPurchase)
    expect(o).toContain('data-who="owner"')
    expect(o).toContain('href="#/requests/req_0000000000000150"')
    expect(o).toContain(`href="https://sepolia.basescan.org/tx/${tx(20)}"`)
    expect(o).toContain('150')
    expect(o).toContain('1.5 mUSDC')
  })

  it('key args per type', () => {
    expect(eventParts(agentPurchase)).toEqual([
      { label: 'credits', value: '10' }, { label: 'amountPaid', value: '0.1 mUSDC' }, { label: 'purchase', value: '#8' },
    ])
    const op = eventParts(agentOp)
    expect(op.find((p) => p.label === 'success')?.value).toBe('true')
    expect(op.find((p) => p.label === 'nonceKey')?.value).toContain('(agent key)')
    expect(op.find((p) => p.label === 'gas cost')?.value).toBe('0.000000123 ETH')
    expect(eventParts(revert)[0]).toMatchObject({ label: 'reason', value: 'ExceedsPerTxLimit(1010000, 1000000)' })
    const undecodable = eventParts({ ...revert, args: { ...revert.args, reason: null } } as ChainEvent)
    expect(undecodable[0].value).toBe('undecodable (0xdeadbeef)')
    expect(nonceKeyText('0x0')).toBe('0x0 (owner)')
    const failed = row({ ...agentOp, args: { ...agentOp.args, success: false } } as ChainEvent)
    expect(failed).toContain('FALSE')
    expect(failed).toContain('class="failed"')
  })

  it('every type renders, and an unknown type shows its raw args', () => {
    const others: ChainEvent[] = [
      ev({ type: 'AgentSpent', emitter: 'wallet', args: { agent: AGENT, token: BOOK.usdc, recipient: BOOK.merchant, amount: amt('100000', '0.1'), spentToday: amt('200000', '0.2') } }),
      ev({ type: 'AgentExecuted', emitter: 'wallet', args: { agent: AGENT, target: BOOK.merchant, selector: '0x70876c98', value: '0' } }),
      ev({ type: 'AgentRevoked', emitter: 'wallet', label: 'owner', args: { agent: AGENT } }),
      ev({ type: 'PolicySet', emitter: 'wallet', label: 'owner', args: { agent: AGENT, token: BOOK.usdc, maxPerTx: amt('1000000', '1'), dailyLimit: amt('5000000', '5') } }),
    ]
    expect(row(others[0])).toContain('0.2 mUSDC')
    expect(row(others[1])).toContain('0x70876c98')
    expect(row(others[3])).toContain('5 mUSDC')
    const unknown = row(ev({ type: 'Mystery' as ChainEvent['type'], args: { foo: 'bar' } as never }))
    expect(unknown).toContain('Mystery')
    expect(unknown).toContain('bar')
  })

  it('all args are text: HTML in args is escaped, bad request ids and tx hashes are not links', () => {
    const evil = ev({ type: 'UserOperationRevertReason', txHash: XSS as `0x${string}`, requestId: `req_${XSS}`, label: XSS as 'agent',
      args: { userOpHash: tx(1), sender: XSS, nonce: '1', nonceKey: XSS, nonceSequence: XSS, revertReason: XSS, reason: XSS } as never })
    const out = row(evil)
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(out).not.toContain('data-link="request"')
    expect(out).not.toContain('data-link="tx"')
    expect(out).toContain('data-who')
    expect(safeRequestId('req_0000000000000010')).toBe('req_0000000000000010')
    expect(safeRequestId('javascript:alert(1)')).toBeNull()
  })

  it('no BaseScan link on Anvil, the hash is still shown', () => {
    const out = row(agentPurchase, 31337)
    expect(out).not.toContain('basescan')
    expect(out).toContain('0x0000')
  })

  it('label badges: agent blue, owner purple, anything else grey', () => {
    expect(labelView('agent').tone).toBe('blue')
    expect(labelView('owner').tone).toBe('purple')
    expect(labelView('other').tone).toBe('grey')
    expect(labelView('weird')).toEqual({ text: 'weird', tone: 'grey' })
  })
})

describe('paging and filter', () => {
  it('before = oldest block + 1 so a block cut by the page limit is not skipped; rows already shown are dropped', () => {
    const page1 = [ownerPurchase, agentOp, agentPurchase]
    expect(nextBefore(page1)).toBe(121)
    expect(nextBefore(page1, false)).toBe(120)
    expect(nextBefore([])).toBeUndefined()
    const sameBlock = ev({ type: 'AgentSpent', blockNumber: 120, txHash: tx(10), logIndex: 3, args: {} as never })
    const merged = mergeOlder(page1, [agentOp, agentPurchase, sameBlock, revert], 4)
    expect(merged.rows.map(eventKey)).toEqual([...page1, sameBlock, revert].map(eventKey))
    expect(merged.added).toBe(2)
    expect(merged.hasMore).toBe(true)
    expect(mergeOlder(page1, [revert], 50).hasMore).toBe(false)
  })

  it('a refresh replaces the newest page and keeps the older pages', () => {
    const shown = [ownerPurchase, agentOp, agentPurchase, revert]
    const newer = ev({ type: 'CreditsPurchased', blockNumber: 140, txHash: tx(30), args: { purchaseId: '10', buyer: BOOK.wallet, credits: '1', amountPaid: amt('10000', '0.01') } })
    const out = mergeNewest(shown, [newer, ownerPurchase])
    expect(out.map(eventKey)).toEqual([newer, ownerPurchase, agentOp, agentPurchase, revert].map(eventKey))
    expect(mergeNewest(shown, [])).toEqual([])
  })

  it('type filter toggles, keeps the seven types in order, empty means all', () => {
    expect(EVENT_TYPES).toHaveLength(7)
    let s = toggleType([], 'UserOperationEvent')
    s = toggleType(s, 'CreditsPurchased')
    expect(s).toEqual(['CreditsPurchased', 'UserOperationEvent'])
    expect(toggleType(s, 'CreditsPurchased')).toEqual(['UserOperationEvent'])
  })

  it('#/activity is a route', () => {
    expect(parseRoute('#/activity')).toEqual({ tab: 'activity' })
  })
})

describe('indexer status', () => {
  const health = (events: Health['events']) => ({ events }) as Pick<Health, 'events'>

  it('up to date, lagging, not polling, error, missing', () => {
    expect(indexerView(health({ indexedToBlock: 1000, lastError: null, polling: true }), 1000, 1005)).toMatchObject({ tone: 'green', behind: 5 })
    const lag = indexerView(health({ indexedToBlock: 1000, lastError: null, polling: true }), 1000, 1000 + LAG_BLOCKS + 1)
    expect(lag).toMatchObject({ tone: 'yellow', behind: LAG_BLOCKS + 1 })
    expect(lag.text).toContain('behind')
    expect(indexerView(health({ indexedToBlock: 1000, lastError: null, polling: false }), 1000, 1000).tone).toBe('yellow')
    const err = indexerView(health({ indexedToBlock: 900, lastError: 'RPC timeout', polling: true }), 900, 1000)
    expect(err).toMatchObject({ tone: 'red', lastError: 'RPC timeout' })
    expect(indexerView(health(undefined), 5, null).tone).toBe('red')
    expect(indexerView(null, 5, null)).toMatchObject({ tone: 'grey', indexedToBlock: 5 })
  })

  it('shows indexedToBlock, the head and the error as text', () => {
    const out = renderToStaticMarkup(<IndexerStatus view={indexerView(health({ indexedToBlock: 900, lastError: XSS, polling: true }), 900, 1000)} refreshedAt={1761317000} />)
    expect(out).toContain('Indexed to block 900')
    expect(out).toContain('chain head 1000 (100 behind)')
    expect(out).toContain('&lt;img')
    expect(out).not.toContain('<img')
  })
})
