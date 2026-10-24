// The paid rule (docs/UI_SPEC.md §0.2): a request is paid only when its status is succeeded or fulfilled_by_owner AND
// the backend re-checked the proof on chain (proofVerified === true). false = red warning, null/missing = grey.
import type { PurchaseRequest } from '../api/types'
import { isPaidStatus } from '../lib/requestStatus'

export function ProofBadge({ request }: { request: Pick<PurchaseRequest, 'status' | 'proofVerified'> }) {
  if (!isPaidStatus(request.status)) return null
  if (request.proofVerified === true) return <span className="proof paid" data-proof="paid">Paid · proven on chain</span>
  if (request.proofVerified === false) {
    return <span className="proof bad" data-proof="false" role="alert">Proof does not hold: treat as not paid</span>
  }
  return <span className="proof unknown" data-proof="unknown">Could not check the chain: not shown as paid</span>
}
