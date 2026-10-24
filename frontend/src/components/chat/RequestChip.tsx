// One chip per request created in a chat turn. The label comes from the request's live status and proof, never from
// the agent's reply: "Bought" only with status succeeded/fulfilled_by_owner and proofVerified === true.
import { api } from '../../api'
import type { PurchaseRequest } from '../../api/types'
import { useRequestStatus } from '../../hooks/useRequestStatus'
import { shortHash } from '../../lib/format'
import { requestErrorText } from '../../lib/messages'
import { needsOwner, statusView } from '../../lib/requestStatus'
import { approvalHref } from '../../lib/routes'

export function RequestChip({ id }: { id: string }) {
  const { request, error } = useRequestStatus(api, id)
  return <RequestChipView id={id} request={request} errorText={error?.text ?? null} />
}

export function RequestChipView({ id, request, errorText }: { id: string; request: PurchaseRequest | null; errorText: string | null }) {
  if (!request) {
    return (
      <span className="chip grey" data-request={id}>
        <code>{id}</code> {errorText ? `status unavailable: ${errorText}` : 'loading…'}
      </span>
    )
  }
  const v = statusView(request)
  // The backend builds explorerUrl (BaseScan on 84532, null on Anvil); only an https BaseScan link is rendered as a link.
  const tx = request.explorerUrl && /^https:\/\/sepolia\.basescan\.org\/tx\/0x[0-9a-fA-F]{64}$/.test(request.explorerUrl) ? request.explorerUrl : null
  return (
    <span className={`chip ${v.tone}`} data-request={id} data-status={request.status} title={v.hint}>
      <code>{id}</code> <strong>{v.label}</strong> · {request.credits} credits
      {request.price && <> · {request.price.mUSDC} mUSDC</>}
      {v.paid && request.amountPaid && <> · paid {request.amountPaid.mUSDC} mUSDC</>}
      {request.error && (
        <span className="chip-error"> · {request.error.code}: {requestErrorText(request.error.code)}</span>
      )}
      {request.txHash && (
        <>
          {' · '}
          {tx ? <a href={tx} target="_blank" rel="noreferrer noopener">tx {shortHash(request.txHash)}</a> : <>tx {shortHash(request.txHash)}</>}
        </>
      )}
      {needsOwner(request.status) && (
        <>
          {' · '}
          <a href={approvalHref(id)}>{request.status === 'expired' ? 'Open owner approval' : 'Review and sign'}</a>
        </>
      )}
      {errorText && <span className="muted"> (refresh failed: {errorText})</span>}
    </span>
  )
}
