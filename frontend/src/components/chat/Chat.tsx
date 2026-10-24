// Agent chat (docs/UI_SPEC.md §2.2): history from GET /agent/messages, one turn at a time with POST /agent/chat.
import { useEffect, useReducer, useRef, useState } from 'react'
import { api } from '../../api'
import {
  DEFAULT_CONVERSATION, MAX_MESSAGE, SUGGESTED_PROMPTS, chatReducer, initialChatState, isValidConversationId,
  newConversationId, validateMessage,
} from '../../lib/chat'
import { requestWalletRefresh } from '../../lib/refresh'
import { MessageBubble } from './MessageBubble'
import './chat.css'

const STORAGE_KEY = 'agent-wallet.conversationId'

function savedConversation(): string {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v && isValidConversationId(v) ? v : DEFAULT_CONVERSATION
  } catch {
    return DEFAULT_CONVERSATION
  }
}

export function Chat() {
  const [state, dispatch] = useReducer(chatReducer, undefined, () => initialChatState(savedConversation()))
  const [text, setText] = useState('')
  const [touched, setTouched] = useState(false)
  const [newId, setNewId] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const { conversationId } = state

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, conversationId)
    } catch {
      // private window: the conversation id just isn't remembered
    }
    api.messages({ conversationId, limit: 200 }).then(
      (r) => dispatch({ type: 'historyLoaded', conversationId, messages: r.messages }),
      (error) => dispatch({ type: 'historyFailed', conversationId, error }),
    )
  }, [conversationId])

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [state.messages.length])

  const invalid = validateMessage(text)
  const send = async () => {
    setTouched(true)
    if (invalid || state.busy) return
    dispatch({ type: 'send', text, at: Date.now() })
    try {
      const response = await api.chat({ message: text, conversationId })
      dispatch({ type: 'reply', response, at: Date.now() })
      setText('')
      setTouched(false)
    } catch (error) {
      dispatch({ type: 'failed', error })
    } finally {
      requestWalletRefresh() // a turn may have bought something, or changed nothing: either way read the wallet again
    }
  }

  const startConversation = (id: string) => {
    if (!isValidConversationId(id) || state.busy) return
    setNewId('')
    dispatch({ type: 'conversation', conversationId: id })
  }

  return (
    <section className="chat">
      <div className="chat-bar">
        <h2>Agent chat</h2>
        <span className="muted">Conversation <code>{conversationId}</code></span>
        <form
          className="new-conv"
          onSubmit={(e) => {
            e.preventDefault()
            startConversation(newId.trim() || newConversationId())
          }}
        >
          <input
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            placeholder="new id (optional)"
            aria-label="New conversation id"
            maxLength={64}
            aria-invalid={newId !== '' && !isValidConversationId(newId.trim())}
          />
          <button type="submit" disabled={state.busy || (newId.trim() !== '' && !isValidConversationId(newId.trim()))}>New conversation</button>
          {conversationId !== DEFAULT_CONVERSATION && (
            <button type="button" onClick={() => startConversation(DEFAULT_CONVERSATION)} disabled={state.busy}>Back to default</button>
          )}
        </form>
        {newId.trim() !== '' && !isValidConversationId(newId.trim()) && (
          <div className="field-error">Use 1 to 64 letters, digits, - or _.</div>
        )}
      </div>

      <p className="muted note">The agent's reply is its own text. The chips under it show the real on-chain result.</p>

      {state.historyLoading && <p className="muted">Loading the conversation…</p>}
      {state.historyError && <div className="banner red" role="alert">Could not load the history: {state.historyError.text}</div>}
      {!state.historyLoading && !state.messages.length && !state.historyError && <p className="muted">No messages yet. Try one of the prompts below.</p>}

      <ol className="messages">
        {state.messages.map((m) => <MessageBubble key={m.key} message={m} />)}
      </ol>
      {state.busy && <p className="working" role="status">Agent is working (a purchase can take up to a minute while it is mined)…</p>}
      <div ref={endRef} />

      {state.error && (
        <div className={`banner ${state.error.code === 'BUSY' ? 'yellow' : 'red'}`} role="alert" data-error={state.error.code}>
          {state.error.text}
          {state.error.detail && <div className="muted">{state.error.detail}</div>}
          <button className="link" onClick={() => dispatch({ type: 'dismissError' })}>Dismiss</button>
        </div>
      )}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          rows={3}
          placeholder="Ask the agent, e.g. buy 10 credits"
          aria-label="Message"
          aria-invalid={touched && invalid !== null}
        />
        <div className="composer-row">
          <span className={`counter${text.trim().length > MAX_MESSAGE ? ' over' : ''}`}>{text.trim().length} / {MAX_MESSAGE}</span>
          {touched && invalid && <span className="field-error">{invalid}</span>}
          <button type="submit" disabled={state.busy || invalid !== null}>{state.busy ? 'Working…' : 'Send'}</button>
        </div>
        <div className="prompts">
          {SUGGESTED_PROMPTS.map((p) => (
            <button type="button" key={p} onClick={() => setText(p)} disabled={state.busy}>{p}</button>
          ))}
        </div>
      </form>
    </section>
  )
}
