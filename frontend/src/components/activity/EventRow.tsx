// One on-chain event (docs/UI_SPEC.md §2.5). All values are the indexer's and are rendered as plain text.
import type { ChainEvent } from '../../api/types'
import { explorerTxUrl } from '../../config'
import { EVENT_TYPE_LABEL, eventParts, labelView, safeRequestId } from '../../lib/activity'
import { formatTime, shortHash } from '../../lib/format'
import { requestHref } from '../../lib/routes'

export function EventRow({ event, chainId }: { event: ChainEvent; chainId: number }) {
  const label = labelView(event.label)
  const time = formatTime(event.timestamp)
  const tx = typeof event.txHash === 'string' ? event.txHash : ''
  const txUrl = explorerTxUrl(chainId, tx)
  const requestId = safeRequestId(event.requestId)
  const failed = (event.type === 'UserOperationEvent' && event.args?.success === false) || event.type === 'UserOperationRevertReason'
  return (
    <tr data-type={event.type} data-label={label.text} className={failed ? 'failed' : undefined}>
      <td>
        <strong>{EVENT_TYPE_LABEL[event.type] ?? String(event.type)}</strong>
        <div className="muted mono">{String(event.type)}</div>
      </td>
      <td><span className={`who ${label.tone}`} data-who={label.text}>{label.text}</span></td>
      <td className="time" title={time?.utc}>
        {time ? time.local : '—'}
        <div className="muted">block {String(event.blockNumber)}</div>
      </td>
      <td className="args">
        <div className="arg-list">
          {eventParts(event).map((p) => (
            <span key={p.label} className="arg">
              <span className="muted">{p.label}</span> {p.mono ? <code>{p.value}</code> : p.value}
            </span>
          ))}
        </div>
      </td>
      <td className="tx">
        {txUrl ? <a href={txUrl} target="_blank" rel="noreferrer noopener" data-link="tx">{shortHash(tx)} ↗</a> : <code title={tx}>{shortHash(tx)}</code>}
      </td>
      <td>{requestId ? <a href={requestHref(requestId)} data-link="request"><code>{requestId}</code></a> : <span className="muted">—</span>}</td>
    </tr>
  )
}
