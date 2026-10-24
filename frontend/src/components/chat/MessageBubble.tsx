// One chat message. Every piece of text from the user, the agent or the backend is a React text node: no
// dangerouslySetInnerHTML, no Markdown, so HTML in a reply is shown as characters and runs nothing.
import type { ReactNode } from 'react'
import type { ToolCall } from '../../api/types'
import { formatTime } from '../../lib/format'
import type { UiMessage } from '../../lib/chat'
import { RequestChip } from './RequestChip'

export function MessageBubble({ message, Chip = RequestChip }: { message: UiMessage; Chip?: (p: { id: string }) => ReactNode }) {
  const t = formatTime(message.createdAt)
  return (
    <li className={`msg ${message.role}${message.pending ? ' pending' : ''}`} data-role={message.role}>
      <div className="msg-head">
        <span>{message.role === 'user' ? 'You' : 'Agent'}</span>
        <span className="muted" title={t?.utc}>{t?.local}</span>
        {message.meta && (
          <span className={`badge ${message.meta.planner}`} title={message.meta.planner === 'fallback' ? 'Deterministic planner, no LLM' : 'Answered by the LLM'}>
            {message.meta.planner}
          </span>
        )}
      </div>
      <div className="msg-text">{message.content}</div>
      {message.meta && message.meta.toolCalls.length > 0 && <ToolCalls calls={message.meta.toolCalls} />}
      {message.requestIds.length > 0 && (
        <div className="chips">
          {message.role === 'assistant' && <span className="muted">On-chain result:</span>}
          {message.requestIds.map((id) => <Chip key={id} id={id} />)}
        </div>
      )}
    </li>
  )
}

function ToolCalls({ calls }: { calls: ToolCall[] }) {
  return (
    <details className="tools">
      <summary>Tool calls ({calls.length})</summary>
      <ol>
        {calls.map((c, i) => (
          <li key={i}>
            <code>{c.name}</code>(<code>{JSON.stringify(c.args)}</code>) → <code>{JSON.stringify(c.result)}</code>
          </li>
        ))}
      </ol>
    </details>
  )
}
