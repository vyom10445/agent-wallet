import type { IndexerView } from '../../lib/activity'
import { formatTime } from '../../lib/format'

export function IndexerStatus({ view, refreshedAt }: { view: IndexerView; refreshedAt: number | null }) {
  return (
    <div className={`indexer ${view.tone}`} role={view.tone === 'green' ? 'status' : 'alert'} data-indexer={view.tone}>
      <strong>Indexed to block {view.indexedToBlock ?? '—'}</strong>
      {view.head !== null && <span> · chain head {view.head}{view.behind !== null ? ` (${view.behind} behind)` : ''}</span>}
      <span> · {view.text}</span>
      {view.lastError && <div className="error-text">Last indexer error: <code>{view.lastError}</code></div>}
      {refreshedAt && <div className="muted">Refreshed {formatTime(refreshedAt)?.local}, every 15 s.</div>}
    </div>
  )
}
