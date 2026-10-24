// Activity feed logic (docs/UI_SPEC.md §2.5), pure so it can be tested. GET /events is newest first, ordered by
// (blockNumber, logIndex) descending; "Load older" pages back with `before` (the backend returns blockNumber < before).
// Every value comes from the backend's indexer and is shown as text only.
import { EVENT_TYPES, type ChainEvent, type EventType, type Health } from '../api/types'
import { formatAmount, formatWei, shortAddress } from './format'

export const EVENTS_PAGE = 50
export const ACTIVITY_POLL_MS = 15_000
/** Indexer this many blocks behind the chain head is shown as lagging (Base makes a block every 2 s, so ~1 minute). */
export const LAG_BLOCKS = 30

export const EVENT_TYPE_LABEL: Readonly<Record<EventType, string>> = {
  CreditsPurchased: 'Credits purchased',
  AgentSpent: 'Agent spent',
  AgentExecuted: 'Agent executed',
  AgentRevoked: 'Agent revoked',
  PolicySet: 'Policy set',
  UserOperationEvent: 'UserOp',
  UserOperationRevertReason: 'UserOp revert',
}
export { EVENT_TYPES }

export const eventKey = (e: Pick<ChainEvent, 'txHash' | 'logIndex'>) => `${e.txHash.toLowerCase()}:${e.logIndex}`

/** Toggles one type in the filter; an empty filter means all types. */
export function toggleType(selected: readonly EventType[], type: EventType): EventType[] {
  const next = selected.includes(type) ? selected.filter((t) => t !== type) : [...selected, type]
  return EVENT_TYPES.filter((t) => next.includes(t)) // stable order, unknowns dropped
}

/**
 * `before` for the next older page. One transaction emits several events in one block (UserOperationEvent,
 * CreditsPurchased, AgentSpent, AgentExecuted), and the backend's filter is strict, so "< oldest block" would skip
 * the rest of a block cut by the page limit. Ask for "< oldest + 1" and drop rows already shown (mergeOlder). Only when
 * that adds nothing (a single block with more events than a page) fall back to "< oldest".
 */
export const nextBefore = (rows: readonly ChainEvent[], inclusive = true) => {
  if (!rows.length) return undefined
  const oldest = Math.min(...rows.map((e) => e.blockNumber))
  return inclusive ? oldest + 1 : oldest
}

export function mergeOlder(rows: readonly ChainEvent[], page: readonly ChainEvent[], limit = EVENTS_PAGE) {
  const seen = new Set(rows.map(eventKey))
  const added = page.filter((e) => !seen.has(eventKey(e)))
  return { rows: [...rows, ...added], added: added.length, hasMore: page.length >= limit }
}

/** A refresh of the newest page replaces those rows and keeps the older pages the user loaded. */
export function mergeNewest(rows: readonly ChainEvent[], newest: readonly ChainEvent[]) {
  if (!newest.length) return [] // nothing indexed for this filter (or the db was reset)
  const fresh = new Set(newest.map(eventKey))
  const oldestNew = Math.min(...newest.map((e) => e.blockNumber))
  return [...newest, ...rows.filter((e) => !fresh.has(eventKey(e)) && e.blockNumber < oldestNew)]
}

export type Part = { label: string; value: string; mono?: boolean }
const s = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v))
const amount = (v: unknown) => (v && typeof v === 'object' && 'mUSDC' in v ? formatAmount(v as { base: string; mUSDC: string }) : s(v))

/** "0x0" is the owner's nonce key; any other key is the 20-byte agent address. */
export function nonceKeyText(key: unknown): string {
  const k = s(key)
  if (/^0x0*$/i.test(k)) return '0x0 (owner)'
  return /^0x[0-9a-fA-F]{40}$/.test(k) ? `${shortAddress(k)} (agent key)` : k
}

/** The key arguments of one event, as label/value pairs of plain text. Unknown types show their raw args. */
export function eventParts(e: ChainEvent): Part[] {
  const a = (e.args ?? {}) as Record<string, unknown>
  switch (e.type) {
    case 'CreditsPurchased':
      return [
        { label: 'credits', value: s(a.credits) },
        { label: 'amountPaid', value: amount(a.amountPaid) },
        { label: 'purchase', value: `#${s(a.purchaseId)}` },
      ]
    case 'UserOperationEvent':
      return [
        { label: 'success', value: a.success === true ? 'true' : a.success === false ? 'FALSE' : s(a.success) },
        { label: 'nonceKey', value: nonceKeyText(a.nonceKey), mono: true },
        { label: 'nonce #', value: s(a.nonceSequence) },
        { label: 'gas cost', value: formatWei(s(a.actualGasCost)) },
      ]
    case 'UserOperationRevertReason':
      return [
        { label: 'reason', value: a.reason === null || a.reason === undefined ? `undecodable (${s(a.revertReason)})` : s(a.reason), mono: true },
        { label: 'nonceKey', value: nonceKeyText(a.nonceKey), mono: true },
        { label: 'nonce #', value: s(a.nonceSequence) },
      ]
    case 'AgentSpent':
      return [
        { label: 'amount', value: amount(a.amount) },
        { label: 'to', value: s(a.recipient), mono: true },
        { label: 'spentToday', value: amount(a.spentToday) },
      ]
    case 'AgentExecuted':
      return [
        { label: 'selector', value: s(a.selector), mono: true },
        { label: 'target', value: s(a.target), mono: true },
      ]
    case 'AgentRevoked':
      return [{ label: 'agent', value: s(a.agent), mono: true }]
    case 'PolicySet':
      return [
        { label: 'agent', value: s(a.agent), mono: true },
        { label: 'maxPerTx', value: amount(a.maxPerTx) },
        { label: 'dailyLimit', value: amount(a.dailyLimit) },
      ]
    default:
      return Object.entries(a).map(([label, v]) => ({ label, value: amount(v), mono: true }))
  }
}

export type LabelView = { text: string; tone: 'blue' | 'purple' | 'grey' }
export function labelView(label: unknown): LabelView {
  if (label === 'agent') return { text: 'agent', tone: 'blue' }
  if (label === 'owner') return { text: 'owner', tone: 'purple' }
  return { text: label === 'other' ? 'other' : s(label), tone: 'grey' }
}

const REQUEST_ID = /^req_[0-9a-f]{16}$/
/** Only a well-formed request id becomes a link. */
export const safeRequestId = (id: unknown) => (typeof id === 'string' && REQUEST_ID.test(id) ? id : null)

export type IndexerView = {
  tone: 'green' | 'yellow' | 'red' | 'grey'
  text: string
  indexedToBlock: number | null
  head: number | null
  behind: number | null
  lastError: string | null
}

/**
 * Indexer status from GET /health (events: { indexedToBlock, lastError, polling }) and GET /events, plus the chain head
 * read through the public RPC so a lagging indexer is visible even when the backend reports no error.
 */
export function indexerView(health: Pick<Health, 'events'> | null, eventsIndexedTo: number | null, head: number | null): IndexerView {
  const ev = health?.events
  const indexedToBlock = ev?.indexedToBlock ?? eventsIndexedTo ?? null
  const behind = head !== null && indexedToBlock !== null ? Math.max(0, head - indexedToBlock) : null
  const lastError = ev?.lastError ?? null
  const base = { indexedToBlock, head, behind, lastError }
  if (!health) return { ...base, tone: 'grey', text: 'Indexer status unknown (GET /health failed).' }
  if (!ev) return { ...base, tone: 'red', text: 'The backend reports no event indexer: the feed is empty or stale.' }
  if (lastError) return { ...base, tone: 'red', text: 'Event indexer error: the feed may be stale.' }
  if (!ev.polling) return { ...base, tone: 'yellow', text: 'The event indexer is not polling: the feed may be stale.' }
  if (indexedToBlock === null) return { ...base, tone: 'yellow', text: 'The event indexer has not indexed any block yet.' }
  if (behind !== null && behind > LAG_BLOCKS) return { ...base, tone: 'yellow', text: `The event indexer is ${behind} blocks behind the chain.` }
  return { ...base, tone: 'green', text: 'Event indexer up to date.' }
}
