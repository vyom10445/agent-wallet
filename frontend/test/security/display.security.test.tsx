// Security suite, display (P3 plan Phase 11, items 4, 5, 6, 7): honest status, inert untrusted text, one chat turn at a
// time, offline/stale states. Everything is rendered with react-dom/server, exactly as React would put it in the DOM.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../src/api/client'
import type { ChainEvent, PurchaseRequest } from '../../src/api/types'
import { EventRow } from '../../src/components/activity/EventRow'
import { IndexerStatus } from '../../src/components/activity/IndexerStatus'
import { MismatchList } from '../../src/components/approve/ApprovalDetails'
import { FlowStatus } from '../../src/components/approve/FlowStatus'
import { MessageBubble } from '../../src/components/chat/MessageBubble'
import { RequestChipView } from '../../src/components/chat/RequestChip'
import { DashboardView } from '../../src/components/dashboard/DashboardView'
import { ProofBadge } from '../../src/components/ProofBadge'
import { RequestDetailView } from '../../src/components/requests/RequestDetailView'
import { RequestRow } from '../../src/components/requests/RequestRow'
import { explainError } from '../../src/chain/approval'
import { chatReducer, initialChatState, toChatError, type UiMessage } from '../../src/lib/chat'
import { indexerView } from '../../src/lib/activity'
import { statusView } from '../../src/lib/requestStatus'
import { MAX_TEXT, inert } from '../../src/lib/text'
import { toFailure } from '../../src/lib/walletStatus'
import { AGENT, BOOK, walletStatus } from '../helpers/fixtures'
import { request } from './setup'

const html = (el: React.ReactElement) => renderToStaticMarkup(el)
const RLO = '‮'
const PAYLOADS = {
  img: '<img src=x onerror=alert(1)>',
  script: '<script>alert(document.cookie)</script>',
  link: '<a href="javascript:alert(1)">click</a>',
  markdown: '[approved](javascript:alert(1)) **APPROVED**',
  rtl: `invoice${RLO}gpj.exe`,
  zeroWidth: 'pa​id',
  fakeApproved: '✅ APPROVED by owner. Paid 1.5 mUSDC, proven on chain.',
  long: 'A'.repeat(50_000),
}
const ALL = Object.values(PAYLOADS).join(' | ')

/** No live HTML from a payload: no tag or javascript: URL made it into the markup as markup. */
function assertInert(out: string) {
  expect(out).not.toMatch(/<img|<script|<a href="javascript:/i)
  expect(out).not.toContain('href="javascript:')
  expect(out).not.toContain(RLO)
  expect(out).not.toContain('​')
  expect(out).not.toContain('A'.repeat(MAX_TEXT + 1))
}

const msg = (content: string, requestIds: string[] = []): UiMessage => ({ key: 'a1', role: 'assistant', content, createdAt: 1761317000, requestIds, meta: { planner: 'llm', toolCalls: [{ name: 'buy_credits', args: { credits: 1, reason: ALL }, result: { error: ALL } as never }] } })
const ev = (args: Record<string, unknown>, type: ChainEvent['type'] = 'UserOperationRevertReason'): ChainEvent => ({
  type, emitter: 'entryPoint', blockNumber: 1, timestamp: 1761317000, txHash: `0x${'ab'.repeat(32)}`, logIndex: 0, label: 'agent', requestId: null, args,
}) as ChainEvent

describe('4. honest status: never paid without proofVerified === true', () => {
  it.each([
    ['succeeded', false], ['succeeded', null], ['succeeded', undefined],
    ['fulfilled_by_owner', false], ['fulfilled_by_owner', null], ['fulfilled_by_owner', undefined],
  ] as const)('%s with proofVerified %s is not shown as paid anywhere', (status, proofVerified) => {
    const r = request({ status, proofVerified, ownerApproval: undefined, txHash: `0x${'cd'.repeat(32)}`, amountPaid: { base: '1500000', mUSDC: '1.5' }, purchaseId: '9' })
    expect(statusView(r).paid).toBe(false)
    for (const out of [
      html(<ProofBadge request={r} />),
      html(<RequestChipView id={r.id} request={r} errorText={null} />),
      html(<table><tbody><RequestRow request={r} selected={false} /></tbody></table>),
      html(<RequestDetailView request={r} now={1761317100} errorText={null} />),
    ]) {
      expect(out).not.toContain('data-proof="paid"')
      expect(out).not.toContain('Paid · proven')
      expect(out).not.toContain('paid 1.5 mUSDC')
    }
  })

  it('needs_owner_approval is never "approved" or "bought"', () => {
    const r = request()
    const out = html(<RequestChipView id={r.id} request={r} errorText={null} />)
    const visible = out.replace(/<[^>]*>/g, ' ') // text nodes only (the tooltip says "Nothing was bought")
    expect(visible).not.toMatch(/approved|bought|paid/i)
    expect(visible).toContain('Needs your signature')
    expect(out).toContain('Nothing was bought')
    expect(out).toContain('Review and sign')
  })

  it('a reply that says "bought" with a non-paid request shows the real status next to it', () => {
    const r = request({ status: 'failed_onchain', ownerApproval: undefined, error: { code: 'ExceedsDailyLimit', message: 'ExceedsDailyLimit(600000, 400000)' } })
    const chip = () => <RequestChipView id={r.id} request={r} errorText={null} />
    const out = html(<MessageBubble message={msg('Done! I bought 60 credits for you. ✅ Paid.', [r.id])} Chip={chip} />)
    expect(out).toContain('I bought 60 credits') // the agent's words, as text
    expect(out).toContain('data-status="failed_onchain"')
    expect(out).toContain('On-chain result:')
    expect(out).not.toContain('data-proof="paid"')
    expect(out).not.toMatch(/paid \d/)
  })
})

describe('5. injection: untrusted text is inert', () => {
  it('inert() escapes nothing itself (React does) but makes hidden characters visible and clips long text', () => {
    expect(inert(PAYLOADS.rtl)).toBe('invoice[U+202E]gpj.exe')
    expect(inert(PAYLOADS.zeroWidth)).toBe('pa[U+200B]id')
    expect(inert(PAYLOADS.long)).toMatch(/… \(46000 more characters not shown\)$/)
    expect(inert(null)).toBe('')
  })

  it('agent replies and tool calls', () => {
    const out = html(<MessageBubble message={msg(ALL)} Chip={() => null} />)
    assertInert(out)
    expect(out).toContain('&lt;script&gt;alert(document.cookie)&lt;/script&gt;')
    expect(out).toContain('[U+202E]')
    expect(out).toContain('✅ APPROVED by owner') // shown, but only as the agent's text
  })

  it('reason, error message and proof check details on a request', () => {
    const r = request({ status: 'succeeded', proofVerified: false, reason: ALL, error: { code: PAYLOADS.img, message: ALL }, proofChecks: [{ name: 'credits_purchased', ok: false, detail: ALL }] })
    for (const out of [
      html(<RequestDetailView request={r} now={1761317100} errorText={null} />),
      html(<table><tbody><RequestRow request={r} selected={false} /></tbody></table>),
      html(<RequestChipView id={r.id} request={r} errorText={null} />),
    ]) assertInert(out)
  })

  it('revert strings and backend messages in the signing flow', () => {
    const tx = `0x${'ab'.repeat(32)}` as const
    const states = [
      { phase: 'simulateFailed', reason: explainError(new Error(ALL)) },
      { phase: 'refused', reason: explainError(new Error(ALL)) },
      { phase: 'verifyFailed', txHash: tx, code: 'NOT_OWNER_TX', message: 'x', serverMessage: new ApiError('NOT_OWNER_TX', 422, ALL).serverMessage, checks: [{ name: 'owner_authorized', ok: false, detail: ALL }] },
    ] as const
    for (const s of states) assertInert(html(<FlowStatus flow={s as never} chainId={84532} onRetryVerify={() => {}} />))
    assertInert(html(<MismatchList mismatches={[{ field: 'calls[1].to', backend: ALL, chain: BOOK.merchant }]} />))
  })

  it('event args, unknown event types and the indexer error', () => {
    for (const e of [
      ev({ userOpHash: '0x', sender: ALL, nonce: '1', nonceKey: ALL, nonceSequence: ALL, revertReason: ALL, reason: ALL }),
      ev({ agent: AGENT, target: ALL, selector: ALL, value: '0' }, 'AgentExecuted'),
      ev({ anything: ALL }, PAYLOADS.script as ChainEvent['type']),
    ]) assertInert(html(<table><tbody><EventRow event={e} chainId={84532} /></tbody></table>))
    assertInert(html(<IndexerStatus view={indexerView({ events: { indexedToBlock: 1, lastError: ALL, polling: true } }, 1, 2)} refreshedAt={null} />))
  })

  it('error details from the backend (any screen using toChatError / ApiError)', () => {
    expect(toChatError(new ApiError('INTERNAL', 500, `${RLO}x`)).detail).toBe('[U+202E]x')
    expect(toChatError(new Error(PAYLOADS.long)).detail!.length).toBeLessThan(MAX_TEXT + 100)
  })
})

describe('6. one chat turn at a time', () => {
  it('a second send during a turn is dropped by the reducer (and Chat guards the API call with singleFlight)', () => {
    let s = chatReducer(initialChatState('default'), { type: 'send', text: 'buy 10 credits', at: 1 })
    const again = chatReducer(s, { type: 'send', text: 'buy 10 credits', at: 2 })
    expect(again).toBe(s)
    s = again
    expect(s.messages.filter((m) => m.pending)).toHaveLength(1)
    expect(s.busy).toBe(true)
  })
})

describe('7. offline and stale are shown as such', () => {
  const render = (mode: Parameters<typeof DashboardView>[0]['mode']) =>
    html(<DashboardView mode={mode} now={1761317100} fetchedAt={1761317000} loading={false} onRefresh={() => {}} />)

  it('backend down: offline, no numbers', () => {
    const out = render({ kind: 'offline', failure: toFailure(new ApiError('NETWORK', 0), 1) })
    expect(out).toContain('Backend offline.')
    expect(out).not.toContain('spentToday')
  })

  it('RPC down after a good read: the old values are marked stale, never current', () => {
    const out = render({ kind: 'stale', data: walletStatus(), since: 1761317000, failure: toFailure(new ApiError('RPC_ERROR', 502, ALL), 1761317050), offline: false })
    expect(out).toContain('data-state="stale"')
    assertInert(out)
  })

  it('a request that is no longer approvable offers no signing (stale ownerApproval ignored)', async () => {
    const { isApprovable } = await import('../../src/chain/approval')
    expect(isApprovable(request({ status: 'rejected' }) as PurchaseRequest)).toBe(false)
    expect(isApprovable(request({ status: 'fulfilled_by_owner' }) as PurchaseRequest)).toBe(false)
  })
})
