// How a purchase request is shown (docs/UI_SPEC.md §3). The contract is the only authority: a request is shown as
// bought only when its status is succeeded or fulfilled_by_owner AND the backend re-checked it on chain
// (proofVerified === true). The agent's reply text never decides this. needs_owner_approval is not an approval.
import type { PurchaseRequest, Status } from '../api/types'

export type Tone = 'grey' | 'orange' | 'blue' | 'green' | 'red' | 'purple'
export type StatusView = { label: string; tone: Tone; paid: boolean; hint: string }

const BASE: Readonly<Record<Status, { label: string; tone: Tone; hint: string }>> = {
  received: { label: 'Checking', tone: 'grey', hint: 'The backend is checking the policy.' },
  precheck_failed: { label: 'Not sent', tone: 'orange', hint: 'Nothing was sent to the chain.' },
  submitted: { label: 'Sent, waiting for the chain', tone: 'blue', hint: 'Waiting for the transaction to be mined.' },
  succeeded: { label: 'Bought by agent', tone: 'green', hint: 'Proven on chain.' },
  failed_onchain: { label: 'Failed on chain', tone: 'red', hint: 'The transaction ran but the purchase failed. Nothing was bought.' },
  needs_owner_approval: { label: 'Needs your signature', tone: 'purple', hint: 'Nothing was bought. Only the owner signing on chain can buy it.' },
  fulfilled_by_owner: { label: 'Bought with owner approval', tone: 'green', hint: 'Proven on chain.' },
  rejected: { label: 'Declined by you', tone: 'grey', hint: 'Nothing was bought.' },
  expired: { label: 'Expired', tone: 'grey', hint: 'Nothing was bought. The owner may still sign.' },
}

const PAID: readonly Status[] = ['succeeded', 'fulfilled_by_owner']
/** Statuses that can still change by themselves (the chip keeps polling). */
const IN_FLIGHT: readonly Status[] = ['received', 'submitted']

export const isPaidStatus = (s: Status) => PAID.includes(s)
export const isInFlight = (s: Status) => IN_FLIGHT.includes(s)
export const needsOwner = (s: Status) => s === 'needs_owner_approval' || s === 'expired'

export function statusView(r: Pick<PurchaseRequest, 'status' | 'proofVerified'>): StatusView {
  const base = BASE[r.status] ?? { label: String(r.status), tone: 'grey' as const, hint: 'Unknown status.' }
  if (!isPaidStatus(r.status)) return { ...base, paid: false }
  if (r.proofVerified === true) return { ...base, paid: true }
  if (r.proofVerified === false) {
    return { label: 'Proof does not hold', tone: 'red', paid: false, hint: 'The database says paid, but the chain does not confirm it. Treat as not paid.' }
  }
  return { label: 'Could not check the chain', tone: 'grey', paid: false, hint: 'Recorded as paid, but the proof could not be checked right now. Not shown as paid.' }
}
