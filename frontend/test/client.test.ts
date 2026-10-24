import { describe, expect, it } from 'vitest'
import { ApiError, createApiClient } from '../src/api/client'
import { HTTP_ERROR_TEXT } from '../src/lib/messages'
import { health, mockFetch, walletStatus } from './helpers/fixtures'

const BASE = 'http://127.0.0.1:8787'
const REQ = 'req_3f9a0c1b7d2e4a65'
const TX = `0x${'ab'.repeat(32)}` as const

const client = (routes: Parameters<typeof mockFetch>[0]) => {
  const m = mockFetch(routes)
  return { api: createApiClient({ baseUrl: `${BASE}/`, fetch: m.fetch }), calls: m.calls }
}
const rejection = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e as ApiError
  }
  throw new Error('expected a rejection')
}

describe('requests and responses', () => {
  it('GET /health returns the typed body and trims the base URL', async () => {
    const { api, calls } = client({ '/health': [200, health()] })
    expect(api.baseUrl).toBe(BASE)
    const h = await api.health()
    expect(h.chainId).toBe(84532)
    expect(calls[0].url).toBe(`${BASE}/health`)
    expect(calls[0].init?.method).toBe('GET')
  })

  it('GET /wallet/status keeps amounts as Amount objects', async () => {
    const { api } = client({ '/wallet/status': [200, walletStatus()] })
    const s = await api.walletStatus()
    expect(s.agent.maxPerTx).toEqual({ base: '1000000', mUSDC: '1' })
  })

  it('POST /agent/chat sends trimmed JSON with the default conversation', async () => {
    const reply = { conversationId: 'default', reply: 'ok', requestIds: [], toolCalls: [], planner: 'fallback' }
    const { api, calls } = client({ '/agent/chat': [200, reply] })
    await expect(api.chat({ message: '  buy 50 API credits  ' })).resolves.toEqual(reply)
    expect(calls[0].init?.method).toBe('POST')
    expect(new Headers(calls[0].init?.headers).get('content-type')).toBe('application/json')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ message: 'buy 50 API credits', conversationId: 'default' })
  })

  it('builds query strings for messages, requests and events, skipping empty values', async () => {
    const { api, calls } = client({
      '/agent/messages': [200, { conversationId: 'default', messages: [] }],
      '/requests': [200, { requests: [] }],
      '/events': [200, { fromBlock: null, toBlock: null, indexedToBlock: 5, events: [] }],
    })
    await api.messages({ limit: 200 })
    await api.requests({ status: ['needs_owner_approval', 'expired'], limit: 50, before: 1761317000 })
    await api.requests()
    await api.events({ type: ['CreditsPurchased', 'UserOperationEvent'], before: 12345670 })
    const q = calls.map((c) => new URL(c.url))
    expect(Object.fromEntries(q[0].searchParams)).toEqual({ conversationId: 'default', limit: '200' })
    expect(Object.fromEntries(q[1].searchParams)).toEqual({ status: 'needs_owner_approval,expired', limit: '50', before: '1761317000' })
    expect(q[2].search).toBe('')
    expect(Object.fromEntries(q[3].searchParams)).toEqual({ type: 'CreditsPurchased,UserOperationEvent', before: '12345670' })
  })

  it('GET /requests/:id, verify and reject use the right paths and bodies', async () => {
    const { api, calls } = client({
      [`/requests/${REQ}`]: [200, { id: REQ, status: 'needs_owner_approval' }],
      [`/approvals/${REQ}/verify`]: [200, { request: { id: REQ, status: 'fulfilled_by_owner' }, checks: [] }],
      [`/approvals/${REQ}/reject`]: [200, { request: { id: REQ, status: 'rejected' } }],
    })
    await api.request(REQ)
    await api.verify(REQ, TX)
    await api.reject(REQ, 'too expensive')
    await api.reject(REQ)
    expect(calls.map((c) => [c.init?.method, new URL(c.url).pathname])).toEqual([
      ['GET', `/requests/${REQ}`],
      ['POST', `/approvals/${REQ}/verify`],
      ['POST', `/approvals/${REQ}/reject`],
      ['POST', `/approvals/${REQ}/reject`],
    ])
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ txHash: TX })
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({ note: 'too expensive' })
    expect(JSON.parse(String(calls[3].init?.body))).toEqual({})
  })
})

describe('errors', () => {
  it('an ErrorBody keeps its code, status and server message, with the readable text as message', async () => {
    const { api } = client({ '/agent/chat': [409, { error: { code: 'BUSY', message: 'A chat turn is already running' } }] })
    const e = await rejection(api.chat({ message: 'hi' }))
    expect(e).toBeInstanceOf(ApiError)
    expect(e.code).toBe('BUSY')
    expect(e.status).toBe(409)
    expect(e.message).toBe(HTTP_ERROR_TEXT.BUSY)
    expect(e.serverMessage).toBe('A chat turn is already running')
  })

  it('a failed verify exposes details.checks', async () => {
    const checks = [
      { name: 'request_status', ok: true },
      { name: 'tx_unused', ok: true },
      { name: 'receipt_success', ok: true, detail: 'block 5, status success' },
      { name: 'owner_authorized', ok: false, detail: 'direct call execute from 0x1, owner is 0x2' },
    ]
    const { api } = client({ [`/approvals/${REQ}/verify`]: [422, { error: { code: 'NOT_OWNER_TX', message: 'not owner', details: { checks } } }] })
    const e = await rejection(api.verify(REQ, TX))
    expect(e.code).toBe('NOT_OWNER_TX')
    expect(e.message).toBe(HTTP_ERROR_TEXT.NOT_OWNER_TX)
    expect(e.checks).toEqual(checks)
  })

  it.each([
    ['RPC_ERROR', 502], ['LLM_ERROR', 502], ['INTERNAL', 500], ['NOT_FOUND', 404], ['WRONG_STATUS', 409],
    ['TX_ALREADY_USED', 409], ['TX_NOT_FOUND', 422], ['TX_TOO_OLD', 422], ['INVALID_INPUT', 405],
  ])('maps %s (%i) to its text', async (code, status) => {
    const { api } = client({ '/wallet/status': [status, { error: { code, message: 'server text' } }] })
    const e = await rejection(api.walletStatus())
    expect([e.code, e.status, e.message]).toEqual([code, status, HTTP_ERROR_TEXT[code as keyof typeof HTTP_ERROR_TEXT]])
  })

  it('an unknown code still gets a readable message with the code in it', async () => {
    const { api } = client({ '/health': [418, { error: { code: 'TEAPOT', message: 'x' } }] })
    const e = await rejection(api.health())
    expect(e.code).toBe('TEAPOT')
    expect(e.message).toContain('HTTP 418')
    expect(e.message).toContain('TEAPOT')
  })

  it('a non-JSON error body keeps the HTTP status', async () => {
    const { api } = client({ '/health': [500, '<html>oops</html>'] })
    const e = await rejection(api.health())
    expect([e.code, e.status]).toEqual(['UNKNOWN_HTTP', 500])
  })

  it('a 200 that is not a JSON object is BAD_RESPONSE', async () => {
    const { api } = client({ '/health': [200, 'not json'] })
    expect((await rejection(api.health())).code).toBe('BAD_RESPONSE')
  })

  it('backend not running (fetch rejects) is NETWORK with "Backend not reachable"', async () => {
    const api = createApiClient({ baseUrl: BASE, fetch: async () => { throw new TypeError('Failed to fetch') } })
    const e = await rejection(api.health())
    expect([e.code, e.status]).toEqual(['NETWORK', 0])
    expect(e.message).toMatch(/^Backend not reachable/)
  })

  it('a timeout is TIMEOUT', async () => {
    const api = createApiClient({ baseUrl: BASE, fetch: async () => { throw new DOMException('timed out', 'TimeoutError') } })
    expect((await rejection(api.health())).code).toBe('TIMEOUT')
  })

  it('rejects bad input locally without calling the backend', async () => {
    const { api, calls } = client({})
    expect((await rejection(api.request('req_123'))).code).toBe('INVALID_INPUT')
    expect((await rejection(api.verify(REQ, '0x1234'))).code).toBe('INVALID_INPUT')
    expect((await rejection(api.chat({ message: '   ' }))).code).toBe('INVALID_INPUT')
    expect((await rejection(api.chat({ message: 'x'.repeat(2001) }))).code).toBe('INVALID_INPUT')
    expect((await rejection(api.chat({ message: 'hi', conversationId: 'bad id!' }))).code).toBe('INVALID_INPUT')
    expect((await rejection(api.reject(REQ, 'n'.repeat(201)))).code).toBe('INVALID_INPUT')
    expect(calls).toHaveLength(0)
  })
})
