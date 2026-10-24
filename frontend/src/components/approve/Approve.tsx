// Approve tab (#/approve, #/approve/<id>): the requests waiting for the owner (GET /requests?status=needs_owner_approval,expired,
// refreshed every 15 s while visible) and the signing panel for the selected one.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import type { PurchaseRequest } from '../../api/types'
import { createChainReads } from '../../chain/reads'
import type { Deployment } from '../../config'
import { toChatError, type ChatError } from '../../lib/chat'
import { formatAmount, formatRelative } from '../../lib/format'
import { approvalHref } from '../../lib/routes'
import { statusView } from '../../lib/requestStatus'
import { WalletConnect } from '../wallet/WalletConnect'
import { ApprovalPanel } from './ApprovalPanel'
import './approve.css'

const POLL_MS = 15_000

export function Approve({ requestId, deployment, blocked }: { requestId: string | null; deployment: Deployment | null; blocked: string | null }) {
  const reads = useMemo(() => (deployment ? createChainReads(deployment) : null), [deployment])
  const { rows, error, refresh } = useWaiting()

  return (
    <section className="approve">
      <h2>Owner approval</h2>
      <div className="approve-body">
        <aside className="waiting">
          <div className="waiting-bar">
            <strong>Waiting for you</strong>
            <button onClick={refresh}>Refresh</button>
          </div>
          {error && <div className="banner red" role="alert">{error.text}{error.detail && <div className="muted">{error.detail}</div>}</div>}
          {rows && !rows.length && <p className="muted">Nothing is waiting for the owner.</p>}
          {rows && rows.length > 0 && (
            <ul>
              {rows.map((r) => (
                <li key={r.id} className={r.id === requestId ? 'selected' : undefined}>
                  <a href={approvalHref(r.id)}>
                    <code>{r.id}</code> · {r.credits} credits · {formatAmount(r.price)}
                  </a>
                  <span className={`status ${statusView(r).tone}`}>{statusView(r).label}</span>
                  <span className="muted">{formatRelative(r.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </aside>
        <div className="panel">
          {!deployment || !reads ? (
            <>
              <WalletConnect blocked={blocked} />
              <p className="muted">Waiting for the backend and the address book ({blocked ?? 'checking'}).</p>
            </>
          ) : requestId ? (
            <ApprovalPanel key={requestId} api={api} reads={reads} deployment={deployment} requestId={requestId} blocked={blocked} />
          ) : (
            <>
              <WalletConnect blocked={blocked} />
              <p className="muted">Pick a request on the left, or open the approval link from the chat.</p>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

function useWaiting() {
  const [rows, setRows] = useState<PurchaseRequest[] | null>(null)
  const [error, setError] = useState<ChatError | null>(null)
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false
    api.requests({ status: ['needs_owner_approval', 'expired'], limit: 50 }).then(
      (r) => {
        if (cancelled) return
        setRows(r.requests)
        setError(null)
      },
      (e) => !cancelled && setError(toChatError(e)),
    )
    const t = setTimeout(() => {
      if (document.visibilityState !== 'hidden') return setTick((n) => n + 1)
      const resume = () => {
        document.removeEventListener('visibilitychange', resume)
        if (!cancelled) setTick((n) => n + 1)
      }
      document.addEventListener('visibilitychange', resume)
    }, POLL_MS)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [tick])

  return { rows, error, refresh }
}
