// Follows one purchase request with GET /requests/:id: polls every 3 s while it is received or submitted, stops once it
// is final, and calls onSettled when an in-flight request becomes final (so the dashboard can refresh).
// Failed reads are retried every 5 s, except 404 / invalid id, which cannot change.
import type { ApiClient } from '../api/client'
import type { PurchaseRequest } from '../api/types'
import { toChatError, type ChatError } from './chat'
import { isInFlight } from './requestStatus'

export const REQUEST_POLL_MS = 3_000
export const REQUEST_RETRY_MS = 5_000

export type WatchState = { request: PurchaseRequest | null; error: ChatError | null }

type Options = { pollMs?: number; retryMs?: number; onSettled?: (r: PurchaseRequest) => void }

/** @returns stop() */
export function watchRequest(api: Pick<ApiClient, 'request'>, id: string, onState: (s: WatchState) => void, opts: Options = {}) {
  const { pollMs = REQUEST_POLL_MS, retryMs = REQUEST_RETRY_MS, onSettled } = opts
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let last: PurchaseRequest | null = null
  let wasInFlight = false

  const load = async () => {
    try {
      const request = await api.request(id)
      if (stopped) return
      last = request
      onState({ request, error: null })
      if (isInFlight(request.status)) {
        wasInFlight = true
        timer = setTimeout(load, pollMs)
      } else if (wasInFlight) {
        wasInFlight = false
        onSettled?.(request)
      }
    } catch (e) {
      if (stopped) return
      const error = toChatError(e)
      onState({ request: last, error })
      if (error.code !== 'NOT_FOUND' && error.code !== 'INVALID_INPUT') timer = setTimeout(load, retryMs)
    }
  }
  void load()

  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
