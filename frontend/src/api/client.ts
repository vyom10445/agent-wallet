// Typed client for every endpoint in backend/docs/BACKEND_API.md v1. Every failure becomes an ApiError with a code and a
// readable message (lib/messages.ts): a backend ErrorBody keeps its code, a failed fetch is NETWORK (backend not running,
// or blocked by CORS: the browser cannot tell the two apart), a slow answer is TIMEOUT.
import { httpErrorText, type ClientErrorCode } from '../lib/messages'
import type {
  ChatRequest, ChatResponse, Check, ErrorBody, EventsQuery, EventsResponse, Hash, Health, HttpErrorCode,
  MessagesResponse, PurchaseRequest, RejectResponse, RequestsQuery, RequestsResponse, VerifyResponse, WalletStatus,
} from './types'

export class ApiError extends Error {
  readonly code: HttpErrorCode | ClientErrorCode | string
  /** HTTP status, or 0 when no response arrived. */
  readonly status: number
  /** The backend's own message (untrusted text, render as plain text). */
  readonly serverMessage: string | null
  readonly details: ErrorBody['error']['details'] | null

  constructor(code: string, status: number, serverMessage: string | null = null, details: ErrorBody['error']['details'] | null = null) {
    super(httpErrorText(code, status || undefined))
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.serverMessage = serverMessage
    this.details = details
  }

  /** details.checks from a failed verify (each with ok and detail). */
  get checks(): Check[] {
    return Array.isArray(this.details?.checks) ? this.details.checks : []
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError

const REQUEST_ID = /^req_[0-9a-f]{16}$/
const TX_HASH = /^0x[0-9a-fA-F]{64}$/
const CONVERSATION_ID = /^[a-zA-Z0-9_-]{1,64}$/

/** A chat turn can include a mined purchase, so it gets far longer than a read. */
export const TIMEOUTS = { read: 30_000, chat: 180_000, verify: 60_000 } as const

type Options = { baseUrl: string; fetch?: typeof fetch }
type Call = { method?: 'GET' | 'POST'; body?: unknown; query?: Record<string, string | number | undefined>; timeout?: number }

function parseErrorBody(body: unknown): ErrorBody['error'] | null {
  const e = (body as Partial<ErrorBody> | null)?.error
  return e && typeof e.code === 'string' ? e : null
}

export function createApiClient({ baseUrl, fetch: fetchImpl = globalThis.fetch.bind(globalThis) }: Options) {
  const base = baseUrl.replace(/\/+$/, '')

  async function call<T>(path: string, { method = 'GET', body, query, timeout = TIMEOUTS.read }: Call = {}): Promise<T> {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== '') params.set(k, String(v))
    const url = `${base}${path}${params.size ? `?${params}` : ''}`

    let res: Response
    try {
      res = await fetchImpl(url, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      })
    } catch (e) {
      const name = (e as { name?: string } | null)?.name
      throw new ApiError(name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', 0)
    }

    let data: unknown = null
    try {
      data = await res.json()
    } catch {
      // handled below: a non-JSON body is BAD_RESPONSE on success, or keeps the HTTP status on failure
    }
    if (!res.ok) {
      const err = parseErrorBody(data)
      throw err
        ? new ApiError(err.code, res.status, typeof err.message === 'string' ? err.message : null, err.details ?? null)
        : new ApiError('UNKNOWN_HTTP', res.status)
    }
    if (data === null || typeof data !== 'object') throw new ApiError('BAD_RESPONSE', res.status)
    return data as T
  }

  const requestPath = (id: string) => {
    if (!REQUEST_ID.test(id)) throw new ApiError('INVALID_INPUT', 0, 'Request ids look like req_ followed by 16 hex characters')
    return id
  }

  return {
    baseUrl: base,

    /** 4.1 */
    health: () => call<Health>('/health'),

    /** 4.2. One turn at a time: a second call while one runs gives BUSY. */
    chat: async ({ message, conversationId = 'default' }: ChatRequest) => {
      const text = message.trim()
      if (text.length < 1 || text.length > 2000) throw new ApiError('INVALID_INPUT', 0, 'The message must be 1 to 2000 characters')
      if (!CONVERSATION_ID.test(conversationId)) throw new ApiError('INVALID_INPUT', 0, 'Invalid conversation id')
      return call<ChatResponse>('/agent/chat', { method: 'POST', body: { message: text, conversationId }, timeout: TIMEOUTS.chat })
    },

    /** 4.3. Oldest first. */
    messages: ({ conversationId = 'default', limit }: { conversationId?: string; limit?: number } = {}) =>
      call<MessagesResponse>('/agent/messages', { query: { conversationId, limit } }),

    /** 4.4. Newest first; `before` is unix seconds (createdAt of the last row) for the next page. */
    requests: ({ status, limit, before }: RequestsQuery = {}) =>
      call<RequestsResponse>('/requests', { query: { status: status?.join(','), limit, before } }),

    /** 4.5. Includes ownerApproval (rebuilt from chain) while needs_owner_approval or expired. */
    request: async (id: string) => call<PurchaseRequest>(`/requests/${requestPath(id)}`),

    /** 4.6. Never retried automatically here: the caller decides (e.g. TX_NOT_FOUND while the tx is being mined). */
    verify: async (id: string, txHash: Hash) => {
      if (!TX_HASH.test(txHash)) throw new ApiError('INVALID_INPUT', 0, 'The tx hash must be 0x followed by 64 hex characters')
      return call<VerifyResponse>(`/approvals/${requestPath(id)}/verify`, { method: 'POST', body: { txHash }, timeout: TIMEOUTS.verify })
    },

    /** 4.7. Bookkeeping only: moves no funds, changes nothing on chain. */
    reject: async (id: string, note?: string) => {
      if (note !== undefined && note.length > 200) throw new ApiError('INVALID_INPUT', 0, 'The note can be at most 200 characters')
      return call<RejectResponse>(`/approvals/${requestPath(id)}/reject`, { method: 'POST', body: note === undefined ? {} : { note } })
    },

    /** 4.8. Fresh chain reads on every call. */
    walletStatus: () => call<WalletStatus>('/wallet/status'),

    /** 4.9. Newest first; `before` is a block number for the next page. */
    events: ({ type, limit, before }: EventsQuery = {}) =>
      call<EventsResponse>('/events', { query: { type: type?.join(','), limit, before } }),
  }
}

export type ApiClient = ReturnType<typeof createApiClient>
