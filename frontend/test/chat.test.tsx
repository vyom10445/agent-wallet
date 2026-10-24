import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, createApiClient } from '../src/api/client'
import type { ChatResponse, PurchaseRequest } from '../src/api/types'
import { MessageBubble } from '../src/components/chat/MessageBubble'
import { RequestChipView } from '../src/components/chat/RequestChip'
import {
  MAX_MESSAGE, chatReducer, initialChatState, isValidConversationId, newConversationId, validateMessage, type UiMessage,
} from '../src/lib/chat'
import { statusView } from '../src/lib/requestStatus'
import { watchRequest } from '../src/lib/watchRequest'
import { mockFetch } from './helpers/fixtures'

const REQ = 'req_3f9a0c1b7d2e4a65'
const TX = `0x${'ab'.repeat(32)}`
const XSS = '<img src=x onerror=alert(1)>'
const NoChip = ({ id }: { id: string }) => <span data-chip={id} />

const request = (over: Partial<PurchaseRequest> = {}): PurchaseRequest => ({
  id: REQ, status: 'submitted', path: 'agent', precheck: 'AGENT_OK', credits: 10, reason: 'user asked',
  price: { base: '100000', mUSDC: '0.1' }, amountPaid: null, purchaseId: null, agent: '0xC74Ba823524Cbd1d889b5FD38785b9d293C6D8aD',
  nonce: null, userOpHash: null, txHash: null, blockNumber: null, actualGasCost: null, error: null, explorerUrl: null,
  conversationId: 'default', expiresAt: null, createdAt: 1761317000, updatedAt: 1761317000, ...over,
})
const reply = (over: Partial<ChatResponse> = {}): ChatResponse => ({
  conversationId: 'default', reply: 'Bought 10 credits', requestIds: [REQ],
  toolCalls: [{ name: 'buy_credits', args: { credits: 10, reason: 'user asked' }, result: { requestId: REQ, status: 'succeeded' } }],
  planner: 'fallback', ...over,
})

describe('message length check', () => {
  it('accepts 1 to 2000 characters after trim', () => {
    expect(validateMessage('buy 10 credits')).toBeNull()
    expect(validateMessage('x'.repeat(MAX_MESSAGE))).toBeNull()
    expect(validateMessage(`  ${'x'.repeat(MAX_MESSAGE)}  `)).toBeNull()
  })
  it('rejects empty, whitespace-only and too long messages', () => {
    expect(validateMessage('')).toMatch(/Type a message/)
    expect(validateMessage(' \n\t ')).toMatch(/Type a message/)
    expect(validateMessage('x'.repeat(MAX_MESSAGE + 1))).toMatch(/2001 characters; the limit is 2000/)
  })
  it('validates conversation ids like the backend', () => {
    expect(isValidConversationId('default')).toBe(true)
    expect(isValidConversationId(newConversationId(1761317000000))).toBe(true)
    for (const bad of ['', 'has space', 'a/b', 'x'.repeat(65), 'é']) expect(isValidConversationId(bad)).toBe(false)
  })
})

describe('turn state and BUSY', () => {
  it('is busy while a turn runs and ignores a second send', () => {
    const s1 = chatReducer(initialChatState(), { type: 'send', text: ' buy 10 credits ', at: 1000 })
    expect(s1.busy).toBe(true)
    expect(s1.messages).toMatchObject([{ role: 'user', content: 'buy 10 credits', pending: true }])
    expect(chatReducer(s1, { type: 'send', text: 'again', at: 2000 })).toBe(s1)
  })

  it('on 409 BUSY says the agent is still working on the last message and is ready again', async () => {
    const api = createApiClient({ baseUrl: 'http://127.0.0.1:8787', fetch: mockFetch({ '/agent/chat': [409, { error: { code: 'BUSY', message: 'A chat turn is already running' } }] }).fetch })
    let error: unknown
    await api.chat({ message: 'buy 10 credits' }).catch((e) => (error = e))
    const sent = chatReducer(initialChatState(), { type: 'send', text: 'buy 10 credits', at: 1000 })
    const s = chatReducer(sent, { type: 'failed', error })
    expect(s.busy).toBe(false)
    expect(s.error?.code).toBe('BUSY')
    expect(s.error?.text.toLowerCase()).toContain('the agent is still working on the last message')
    expect(s.messages).toEqual([]) // the unanswered bubble is removed; the text stays in the input box
  })

  it('adds the reply with planner, tool calls and request ids', () => {
    const sent = chatReducer(initialChatState(), { type: 'send', text: 'buy 10 credits', at: 1000 })
    const s = chatReducer(sent, { type: 'reply', response: reply(), at: 2000 })
    expect(s.busy).toBe(false)
    expect(s.messages.map((m) => [m.role, m.pending ?? false])).toEqual([['user', false], ['assistant', false]])
    expect(s.messages[1]).toMatchObject({ requestIds: [REQ], meta: { planner: 'fallback' } })
  })

  it('loads history oldest first, ignores a late answer for another conversation', () => {
    const msgs = [
      { id: 1, role: 'user' as const, content: 'hi', requestId: null, createdAt: 1 },
      { id: 2, role: 'assistant' as const, content: 'hello', requestId: REQ, createdAt: 2 },
    ]
    const s = chatReducer(initialChatState(), { type: 'historyLoaded', conversationId: 'default', messages: msgs })
    expect(s.messages.map((m) => m.content)).toEqual(['hi', 'hello'])
    expect(s.messages[1].requestIds).toEqual([REQ])
    const other = chatReducer(initialChatState('chat-x'), { type: 'historyLoaded', conversationId: 'default', messages: msgs })
    expect(other.messages).toEqual([])
    expect(chatReducer(s, { type: 'conversation', conversationId: 'chat-x' })).toEqual(initialChatState('chat-x'))
  })

  it('keeps network errors readable', () => {
    const s = chatReducer(chatReducer(initialChatState(), { type: 'send', text: 'x', at: 1 }), { type: 'failed', error: new ApiError('NETWORK', 0) })
    expect(s.error?.text).toMatch(/^Backend not reachable/)
  })
})

describe('plain text rendering', () => {
  const msg = (content: string, over: Partial<UiMessage> = {}): UiMessage => ({ key: 'a1', role: 'assistant', content, createdAt: 1761317000, requestIds: [], ...over })

  it('shows HTML in a reply as text and creates no element', () => {
    const html = renderToStaticMarkup(<MessageBubble message={msg(`Done ${XSS} <script>alert(2)</script>`)} Chip={NoChip} />)
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&lt;script&gt;')
  })

  it('shows HTML in user messages and tool-call arguments as text', () => {
    const toolCalls = [{ name: 'buy_credits' as const, args: { reason: XSS }, result: { error: XSS } }]
    const html = renderToStaticMarkup(<MessageBubble message={msg(XSS, { role: 'user', meta: { planner: 'llm', toolCalls } })} Chip={NoChip} />)
    expect(html).not.toContain('<img')
    expect(html.split('&lt;img').length - 1).toBe(3)
  })

  it('does not render Markdown', () => {
    const html = renderToStaticMarkup(<MessageBubble message={msg('**bold** [link](http://evil)')} Chip={NoChip} />)
    expect(html).toContain('**bold** [link](http://evil)')
    expect(html).not.toContain('<a ')
  })

  it('shows the planner, the tool calls and one chip per request id', () => {
    const r = reply({ requestIds: [REQ, 'req_0000000000000001'] })
    const html = renderToStaticMarkup(<MessageBubble message={msg(r.reply, { requestIds: r.requestIds, meta: { planner: r.planner, toolCalls: r.toolCalls } })} Chip={NoChip} />)
    expect(html).toContain('>fallback<')
    expect(html).toContain('Tool calls (1)')
    expect(html).toContain('buy_credits')
    expect(html).toContain(`data-chip="${REQ}"`)
    expect(html).toContain('data-chip="req_0000000000000001"')
  })
})

describe('request chips', () => {
  const chip = (r: PurchaseRequest | null) => renderToStaticMarkup(<RequestChipView id={REQ} request={r} errorText={null} />)

  it('says bought only for succeeded with proofVerified === true, whatever the reply says', () => {
    const proven = chip(request({ status: 'succeeded', proofVerified: true, txHash: TX as `0x${string}`, explorerUrl: `https://sepolia.basescan.org/tx/${TX}`, amountPaid: { base: '100000', mUSDC: '0.1' } }))
    expect(proven).toContain('Bought by agent')
    expect(proven).toContain(`href="https://sepolia.basescan.org/tx/${TX}"`)
    for (const proofVerified of [undefined, null, false]) {
      const html = chip(request({ status: 'succeeded', proofVerified, txHash: TX as `0x${string}` }))
      expect(html.toLowerCase()).not.toContain('bought')
      expect(statusView({ status: 'succeeded', proofVerified }).paid).toBe(false)
    }
    expect(chip(request({ status: 'succeeded', proofVerified: false }))).toContain('Proof does not hold')
  })

  it('links needs_owner_approval to the owner approval view, with no transaction', () => {
    const html = chip(request({ status: 'needs_owner_approval', path: 'owner', precheck: 'NEEDS_OWNER', credits: 500, price: { base: '5000000', mUSDC: '5' } }))
    expect(html).toContain('Needs your signature')
    expect(html).toContain(`href="#/approve/${REQ}"`)
    expect(html).not.toContain('tx ')
    expect(html.toLowerCase()).not.toContain('approved')
  })

  it('shows submitted, failures with their code, and a link only for a real BaseScan URL', () => {
    expect(chip(request())).toContain('Sent, waiting for the chain')
    expect(chip(request({ status: 'failed_onchain', error: { code: 'ExceedsPerTxLimit', message: 'ExceedsPerTxLimit(1010000, 1000000)' } }))).toContain("Above the agent&#x27;s per-purchase limit")
    expect(chip(request({ status: 'submitted', txHash: TX as `0x${string}`, explorerUrl: 'javascript:alert(1)' }))).not.toContain('javascript:')
    expect(chip(null)).toContain('loading')
  })
})

describe('watching a request', () => {
  afterEach(() => vi.useRealTimers())

  it('polls every 3 s while submitted, stops when final and reports it settled', async () => {
    vi.useFakeTimers()
    const answers = [request(), request(), request({ status: 'succeeded', proofVerified: true })]
    const api = { request: vi.fn(async () => answers.shift() ?? request({ status: 'succeeded', proofVerified: true })) }
    const states: string[] = []
    const settled = vi.fn()
    const stop = watchRequest(api, REQ, (s) => s.request && states.push(s.request.status), { onSettled: settled })
    await vi.advanceTimersByTimeAsync(0)
    expect(api.request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2_999)
    expect(api.request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(states).toEqual(['submitted', 'submitted', 'succeeded'])
    expect(settled).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(api.request).toHaveBeenCalledTimes(3) // final: no more polling
    stop()
  })

  it('does not poll a request that is already final, and does not call settled', async () => {
    vi.useFakeTimers()
    const api = { request: vi.fn(async () => request({ status: 'needs_owner_approval' })) }
    const settled = vi.fn()
    watchRequest(api, REQ, () => {}, { onSettled: settled })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(api.request).toHaveBeenCalledTimes(1)
    expect(settled).not.toHaveBeenCalled()
  })

  it('retries failed reads but not a 404, and stop() ends everything', async () => {
    vi.useFakeTimers()
    const failing = { request: vi.fn(async () => { throw new ApiError('RPC_ERROR', 502) }) }
    const stop = watchRequest(failing, REQ, () => {})
    await vi.advanceTimersByTimeAsync(10_000)
    expect(failing.request).toHaveBeenCalledTimes(3)
    stop()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(failing.request).toHaveBeenCalledTimes(3)
    const missing = { request: vi.fn(async () => { throw new ApiError('NOT_FOUND', 404) }) }
    watchRequest(missing, REQ, () => {})
    await vi.advanceTimersByTimeAsync(20_000)
    expect(missing.request).toHaveBeenCalledTimes(1)
  })
})
