// Chat state (docs/UI_SPEC.md §2.2), pure so it can be tested without a browser. One turn at a time: while a turn runs,
// sending is disabled, and a 409 BUSY from the backend keeps the user's text and says the agent is still working.
import { isApiError } from '../api/client'
import type { ChatMessage, ChatResponse, ToolCall } from '../api/types'

export const MAX_MESSAGE = 2000
export const CONVERSATION_ID = /^[a-zA-Z0-9_-]{1,64}$/
export const DEFAULT_CONVERSATION = 'default'
export const SUGGESTED_PROMPTS = ['buy 10 credits', 'buy 500 credits', "what's my status?"] as const

/** null when the message can be sent, else why not. Same rule as the backend: 1 to 2000 characters after trim. */
export function validateMessage(text: string): string | null {
  const t = text.trim()
  if (t.length === 0) return 'Type a message first.'
  if (t.length > MAX_MESSAGE) return `The message is ${t.length} characters; the limit is ${MAX_MESSAGE}.`
  return null
}

export const isValidConversationId = (id: string) => CONVERSATION_ID.test(id)

/** A fresh id like "chat-lx3k9a2b" (matches ^[a-zA-Z0-9_-]{1,64}$). */
export const newConversationId = (now = Date.now()) => `chat-${now.toString(36)}`

export type UiMessage = {
  key: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  requestIds: string[]
  /** Only for replies received in this session: GET /agent/messages does not return planner or tool calls. */
  meta?: { planner: ChatResponse['planner']; toolCalls: ToolCall[] }
  pending?: boolean
}

export type ChatError = { code: string; text: string; detail: string | null }

export type ChatState = {
  conversationId: string
  messages: UiMessage[]
  historyLoading: boolean
  historyError: ChatError | null
  busy: boolean
  error: ChatError | null
}

export type ChatAction =
  | { type: 'conversation'; conversationId: string }
  | { type: 'historyLoaded'; conversationId: string; messages: ChatMessage[] }
  | { type: 'historyFailed'; conversationId: string; error: unknown }
  | { type: 'send'; text: string; at: number }
  | { type: 'reply'; response: ChatResponse; at: number }
  | { type: 'failed'; error: unknown }
  | { type: 'dismissError' }

export const initialChatState = (conversationId = DEFAULT_CONVERSATION): ChatState => ({
  conversationId, messages: [], historyLoading: true, historyError: null, busy: false, error: null,
})

export function toChatError(error: unknown): ChatError {
  if (isApiError(error)) return { code: String(error.code), text: error.message, detail: error.serverMessage }
  return { code: 'UNKNOWN', text: 'Something went wrong.', detail: error instanceof Error ? error.message : String(error) }
}

const fromHistory = (m: ChatMessage): UiMessage => ({
  key: `h${m.id}`, role: m.role, content: m.content, createdAt: m.createdAt, requestIds: m.requestId ? [m.requestId] : [],
})

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'conversation':
      return initialChatState(action.conversationId)
    case 'historyLoaded':
      if (action.conversationId !== state.conversationId) return state // a late answer for a conversation we left
      return { ...state, historyLoading: false, historyError: null, messages: [...action.messages.map(fromHistory), ...state.messages.filter((m) => !m.key.startsWith('h'))] }
    case 'historyFailed':
      if (action.conversationId !== state.conversationId) return state
      return { ...state, historyLoading: false, historyError: toChatError(action.error) }
    case 'send':
      if (state.busy) return state
      return {
        ...state,
        busy: true,
        error: null,
        messages: [...state.messages, { key: `u${action.at}-${state.messages.length}`, role: 'user', content: action.text.trim(), createdAt: Math.floor(action.at / 1000), requestIds: [], pending: true }],
      }
    case 'reply': {
      const r = action.response
      const messages = state.messages.map((m) => (m.pending ? { ...m, pending: false } : m))
      messages.push({
        key: `a${action.at}-${messages.length}`, role: 'assistant', content: r.reply, createdAt: Math.floor(action.at / 1000),
        requestIds: r.requestIds, meta: { planner: r.planner, toolCalls: r.toolCalls },
      })
      return { ...state, busy: false, error: null, messages }
    }
    case 'failed':
      // The user's text was not answered: take the pending bubble out (the input box still holds the text).
      return { ...state, busy: false, error: toChatError(action.error), messages: state.messages.filter((m) => !m.pending) }
    case 'dismissError':
      return { ...state, error: null }
  }
}
