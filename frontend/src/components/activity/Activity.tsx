// Activity tab (#/activity, docs/UI_SPEC.md §2.5): on-chain events from the backend's indexer (GET /events), newest
// first, with a type filter and "Load older", and the indexer status so a lagging or failing indexer is visible.
import { useMemo, useState } from 'react'
import { api } from '../../api'
import type { EventType } from '../../api/types'
import { createChainReads } from '../../chain/reads'
import type { Deployment } from '../../config'
import { useActivity } from '../../hooks/useActivity'
import { EVENT_TYPES, EVENT_TYPE_LABEL, eventKey, indexerView, toggleType } from '../../lib/activity'
import { EventRow } from './EventRow'
import { IndexerStatus } from './IndexerStatus'
import './activity.css'

export function Activity({ deployment, chainId }: { deployment: Deployment | null; chainId: number | null }) {
  const [types, setTypes] = useState<EventType[]>([])
  const readHead = useMemo(() => {
    if (!deployment) return null
    const { client } = createChainReads(deployment)
    return () => client.getBlockNumber()
  }, [deployment])
  const { state, loadOlder, refresh } = useActivity(api, types, readHead)
  const view = indexerView(state.health, state.eventsIndexedTo, state.head)
  const chain = chainId ?? state.health?.chainId ?? 0

  return (
    <section className="activity">
      <div className="activity-bar">
        <h2>Activity</h2>
        <div className="filters" role="group" aria-label="Event type filter">
          <button aria-pressed={types.length === 0} onClick={() => setTypes([])}>All</button>
          {EVENT_TYPES.map((t) => (
            <button key={t} aria-pressed={types.includes(t)} onClick={() => setTypes((s) => toggleType(s, t))} title={t}>{EVENT_TYPE_LABEL[t]}</button>
          ))}
        </div>
        <button onClick={refresh}>Refresh</button>
      </div>

      {state.loaded && <IndexerStatus view={view} refreshedAt={state.refreshedAt} />}
      {state.error && (
        <div className="banner red" role="alert">
          {state.error.text}{state.error.detail && <div className="muted">{state.error.detail}</div>}
        </div>
      )}
      {!state.loaded && <p>Loading events…</p>}
      {state.loaded && !state.rows.length && !state.error && <p className="muted">No events{types.length ? ' of these types' : ''} indexed yet.</p>}

      {state.rows.length > 0 && (
        <div className="list">
          <table>
            <thead>
              <tr><th>Type</th><th>By</th><th>Time</th><th>Details</th><th>Tx</th><th>Request</th></tr>
            </thead>
            <tbody>
              {state.rows.map((e) => <EventRow key={eventKey(e)} event={e} chainId={chain} />)}
            </tbody>
          </table>
        </div>
      )}
      {state.hasMore && (
        <button className="older" onClick={() => void loadOlder()} disabled={state.loadingOlder}>{state.loadingOlder ? 'Loading…' : 'Load older'}</button>
      )}
    </section>
  )
}
