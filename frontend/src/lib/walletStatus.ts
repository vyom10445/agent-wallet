// Dashboard state for GET /wallet/status, kept pure so it can be tested without a browser.
// Rule: values are shown as current only right after a successful read. After a failure the last good values are kept
// but marked stale (greyed out, "stale since <time of last good read>"), never presented as current.
import { isApiError } from '../api/client'
import type { WalletStatus } from '../api/types'

export type FetchFailure = { code: string; message: string; serverMessage: string | null; at: number }

export type WalletStatusState = {
  data: WalletStatus | null
  /** Browser time (unix seconds) of the last successful read; "stale since" shows this. */
  fetchedAt: number | null
  /** The most recent failure, cleared by the next success. */
  failure: FetchFailure | null
  loading: boolean
}

export type WalletStatusAction =
  | { type: 'start' }
  | { type: 'success'; data: WalletStatus; at: number }
  | { type: 'failure'; error: unknown; at: number }

export const initialWalletStatusState: WalletStatusState = { data: null, fetchedAt: null, failure: null, loading: false }

export function toFailure(error: unknown, at: number): FetchFailure {
  if (isApiError(error)) return { code: String(error.code), message: error.message, serverMessage: error.serverMessage, at }
  return { code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error), serverMessage: null, at }
}

export function walletStatusReducer(state: WalletStatusState, action: WalletStatusAction): WalletStatusState {
  switch (action.type) {
    case 'start':
      return { ...state, loading: true }
    case 'success':
      return { data: action.data, fetchedAt: action.at, failure: null, loading: false }
    case 'failure':
      // Keep the last good data, but it is stale from now on.
      return { ...state, failure: toFailure(action.error, action.at), loading: false }
  }
}

/** What the screen should show. `stale` means: grey out every value and say since when. */
export type DashboardMode =
  | { kind: 'loading' }
  | { kind: 'offline'; failure: FetchFailure }           // never had data, backend not reachable
  | { kind: 'error'; failure: FetchFailure }             // never had data, backend answered with an error
  | { kind: 'current'; data: WalletStatus }
  | { kind: 'stale'; data: WalletStatus; since: number; failure: FetchFailure; offline: boolean }

const isOffline = (f: FetchFailure) => f.code === 'NETWORK' || f.code === 'TIMEOUT'

export function dashboardMode(state: WalletStatusState): DashboardMode {
  if (state.data && state.fetchedAt !== null) {
    return state.failure
      ? { kind: 'stale', data: state.data, since: state.fetchedAt, failure: state.failure, offline: isOffline(state.failure) }
      : { kind: 'current', data: state.data }
  }
  if (state.failure) return isOffline(state.failure) ? { kind: 'offline', failure: state.failure } : { kind: 'error', failure: state.failure }
  return { kind: 'loading' }
}

export type Validity =
  | { kind: 'valid'; countdown: number | null }          // countdown = seconds left when under 24 h
  | { kind: 'revoked' }
  | { kind: 'not_started'; startsIn: number }
  | { kind: 'expired'; ago: number }
  | { kind: 'not_valid' }                                // validNow false for another reason

const DAY = 86_400

/**
 * Agent validity for display. The contract's isAgentValid (agent.validNow) decides valid or not; the times only explain
 * why. `now` should be the chain's time where possible, so use readAt (the backend's read time), not the browser clock.
 */
export function agentValidity(agent: WalletStatus['agent'], now: number): Validity {
  if (!agent.active) return { kind: 'revoked' }
  if (agent.validNow) {
    const left = agent.validUntil - now
    return { kind: 'valid', countdown: left >= 0 && left < DAY ? left : null }
  }
  if (now < agent.validAfter) return { kind: 'not_started', startsIn: agent.validAfter - now }
  if (now > agent.validUntil) return { kind: 'expired', ago: now - agent.validUntil }
  return { kind: 'not_valid' }
}

/** "3 h 04 min 05 s" style countdown. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${h} h ${String(m).padStart(2, '0')} min ${String(sec).padStart(2, '0')} s`
}
