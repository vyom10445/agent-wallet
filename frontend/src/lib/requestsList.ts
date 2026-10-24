// Requests list logic (docs/UI_SPEC.md §2.3), pure so it can be tested. GET /requests is newest first; "Load older"
// pages back with `before` (unix seconds, the backend returns createdAt < before).
import { STATUSES, type PurchaseRequest, type Status } from '../api/types'
import { isInFlight } from './requestStatus'

export const PAGE_SIZE = 50
export const LIST_POLL_MS = 10_000
export const IN_FLIGHT_POLL_MS = 3_000

export const STATUS_FILTERS: readonly { key: string; label: string; statuses: Status[] }[] = [
  { key: 'all', label: 'All', statuses: [] },
  { key: 'owner', label: 'Needs your signature', statuses: ['needs_owner_approval'] },
  { key: 'progress', label: 'In progress', statuses: ['received', 'submitted'] },
  { key: 'paid', label: 'Paid (if proven)', statuses: ['succeeded', 'fulfilled_by_owner'] },
  { key: 'failed', label: 'Failed', statuses: ['precheck_failed', 'failed_onchain'] },
  { key: 'closed', label: 'Closed', statuses: ['rejected', 'expired'] },
]

/** Parses a typed comma list ("succeeded, failed_onchain"). Unknown values are returned separately, not sent. */
export function parseStatusList(text: string): { statuses: Status[]; unknown: string[] } {
  const parts = text.split(',').map((s) => s.trim()).filter(Boolean)
  const statuses = [...new Set(parts.filter((p): p is Status => (STATUSES as readonly string[]).includes(p)))]
  const unknown = parts.filter((p) => !(STATUSES as readonly string[]).includes(p))
  return { statuses, unknown }
}

/**
 * `before` for the next older page. The backend's filter is strict (createdAt < before), so asking for
 * "< oldest createdAt" would skip rows created in that same second on the next page. Asking for "< oldest + 1" returns
 * them too; rows already shown are dropped by mergeOlder.
 */
export const nextBefore = (rows: readonly PurchaseRequest[]) =>
  rows.length ? Math.min(...rows.map((r) => r.createdAt)) + 1 : undefined

/** Appends an older page, dropping rows already shown. hasMore is false once a page adds nothing or is short. */
export function mergeOlder(rows: readonly PurchaseRequest[], page: readonly PurchaseRequest[], limit = PAGE_SIZE) {
  const seen = new Set(rows.map((r) => r.id))
  const added = page.filter((r) => !seen.has(r.id))
  return { rows: [...rows, ...added], hasMore: page.length >= limit && added.length > 0 }
}

/**
 * A refresh of the newest page: its rows replace the shown ones (by id) and new rows go on top; older pages the user
 * loaded stay as they were, so paging is not lost on every poll.
 */
export function mergeNewest(rows: readonly PurchaseRequest[], newest: readonly PurchaseRequest[]) {
  const fresh = new Map(newest.map((r) => [r.id, r]))
  const kept = rows.filter((r) => !fresh.has(r.id))
  const oldestNew = newest.length ? Math.min(...newest.map((r) => r.createdAt)) : Infinity
  // Rows newer than the refreshed page's oldest row that are missing from it no longer match the filter: drop them.
  return [...newest, ...kept.filter((r) => r.createdAt < oldestNew)]
}

/** 3 s while any shown request is received or submitted, else 10 s. */
export const listPollMs = (rows: readonly PurchaseRequest[]) => (rows.some((r) => isInFlight(r.status)) ? IN_FLIGHT_POLL_MS : LIST_POLL_MS)
