// One row of the requests list. Labels come from the status table; "paid" only via ProofBadge (proofVerified === true).
import type { PurchaseRequest } from '../../api/types'
import { formatTime, shortHash } from '../../lib/format'
import { safeExplorerUrl, statusView } from '../../lib/requestStatus'
import { requestHref } from '../../lib/routes'
import { ProofBadge } from '../ProofBadge'
import { inert } from '../../lib/text'

export function RequestRow({ request: r, selected }: { request: PurchaseRequest; selected: boolean }) {
  const v = statusView(r)
  const t = formatTime(r.createdAt)
  const tx = safeExplorerUrl(r.explorerUrl)
  return (
    <tr className={selected ? 'selected' : undefined} data-request={r.id} data-status={r.status}>
      <td title={t?.utc}><a href={requestHref(r.id)}>{t?.local}</a></td>
      <td>
        <span className={`status ${v.tone}`} title={v.hint}>{v.label}</span>{v.paid ? <> <ProofBadge request={r} /></> : null}
      </td>
      <td className="num">{r.credits}</td>
      <td className="num">{r.price ? `${r.price.mUSDC} mUSDC` : '—'}</td>
      <td>{r.path ?? '—'}</td>
      <td>{r.error ? <code>{inert(r.error.code)}</code> : '—'}</td>
      <td>{r.txHash ? (tx ? <a href={tx} target="_blank" rel="noreferrer noopener"><code>{shortHash(r.txHash)}</code></a> : <code>{shortHash(r.txHash)}</code>) : '—'}</td>
    </tr>
  )
}
