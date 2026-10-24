// Requests tab (docs/UI_SPEC.md §2.3): the list from GET /requests and, when #/requests/<id> is open, the detail from
// GET /requests/:id (refreshed every 3 s while received or submitted).
import { useEffect, useState } from 'react'
import { api } from '../../api'
import type { Status } from '../../api/types'
import { useRequestStatus } from '../../hooks/useRequestStatus'
import { useRequestsList } from '../../hooks/useRequestsList'
import { STATUS_FILTERS, parseStatusList } from '../../lib/requestsList'
import { RequestDetailView } from './RequestDetailView'
import { RequestRow } from './RequestRow'
import './requests.css'

export function Requests({ selectedId }: { selectedId: string | null }) {
  const [statuses, setStatuses] = useState<Status[]>([])
  const [custom, setCustom] = useState('')
  const { state, loadOlder, refresh } = useRequestsList(api, statuses)
  const parsed = parseStatusList(custom)
  const activeKey = STATUS_FILTERS.find((f) => f.statuses.join(',') === statuses.join(','))?.key ?? 'custom'

  return (
    <section className="requests">
      <div className="requests-bar">
        <h2>Requests</h2>
        <div className="filters" role="group" aria-label="Status filter">
          {STATUS_FILTERS.map((f) => (
            <button key={f.key} aria-pressed={activeKey === f.key} onClick={() => setStatuses(f.statuses)}>{f.label}</button>
          ))}
        </div>
        <form
          className="custom"
          onSubmit={(e) => {
            e.preventDefault()
            if (parsed.statuses.length && !parsed.unknown.length) setStatuses(parsed.statuses)
          }}
        >
          <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="status list, e.g. succeeded,failed_onchain" aria-label="Status list" />
          <button type="submit" disabled={!parsed.statuses.length || parsed.unknown.length > 0}>Filter</button>
          {parsed.unknown.length > 0 && <span className="field-error">Unknown: {parsed.unknown.join(', ')}</span>}
        </form>
        <button onClick={refresh}>Refresh</button>
      </div>

      {state.error && <div className="banner red" role="alert">{state.error.text}{state.error.detail && <span className="muted"> ({state.error.detail})</span>}</div>}

      <div className="requests-body">
        <div className="list">
          {!state.loaded && <p className="muted">Loading requests…</p>}
          {state.loaded && !state.rows.length && !state.error && <p className="muted">No requests{statuses.length ? ' with this status' : ''} yet.</p>}
          {state.rows.length > 0 && (
            <table>
              <thead>
                <tr><th>Created</th><th>Status</th><th className="num">Credits</th><th className="num">Price</th><th>Path</th><th>Error</th><th>Tx</th></tr>
              </thead>
              <tbody>
                {state.rows.map((r) => <RequestRow key={r.id} request={r} selected={r.id === selectedId} />)}
              </tbody>
            </table>
          )}
          {state.hasMore && (
            <button className="older" onClick={() => void loadOlder()} disabled={state.loadingOlder}>{state.loadingOlder ? 'Loading…' : 'Load older'}</button>
          )}
        </div>
        {selectedId && <RequestDetail key={selectedId} id={selectedId} />}
      </div>
    </section>
  )
}

function RequestDetail({ id }: { id: string }) {
  const { request, error } = useRequestStatus(api, id)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="detail-pane">
      <a className="close" href="#/requests">Close</a>
      {!request && !error && <p className="muted">Loading {id}…</p>}
      {!request && error && <div className="banner red" role="alert">{error.code === 'NOT_FOUND' ? 'No such request.' : error.text}</div>}
      {request && <RequestDetailView request={request} now={now} errorText={error?.text ?? null} />}
    </div>
  )
}
