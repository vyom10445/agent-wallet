// GET /requests for the list view: the newest page is refreshed every 10 s, or every 3 s while a shown request is
// received or submitted (until it is final), paused while the tab is hidden. "Load older" pages back with `before`.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../api/client'
import type { PurchaseRequest, Status } from '../api/types'
import { toChatError, type ChatError } from '../lib/chat'
import { requestWalletRefresh } from '../lib/refresh'
import { isInFlight } from '../lib/requestStatus'
import { PAGE_SIZE, listPollMs, mergeNewest, mergeOlder, nextBefore } from '../lib/requestsList'

export type RequestsListState = {
  rows: PurchaseRequest[]
  loaded: boolean
  error: ChatError | null
  hasMore: boolean
  loadingOlder: boolean
  refreshedAt: number | null
}

const empty: RequestsListState = { rows: [], loaded: false, error: null, hasMore: false, loadingOlder: false, refreshedAt: null }

export function useRequestsList(api: ApiClient, statuses: readonly Status[]) {
  const [state, setState] = useState<RequestsListState>(empty)
  const rowsRef = useRef<PurchaseRequest[]>([])
  const filterKey = statuses.join(',')

  const loadNewest = useCallback(async (reset: boolean) => {
    const status = filterKey ? (filterKey.split(',') as Status[]) : undefined
    try {
      const { requests } = await api.requests({ status, limit: PAGE_SIZE })
      const before = rowsRef.current
      const rows = reset ? requests : mergeNewest(before, requests)
      // A request that was in flight and is now final moved funds (or failed): refresh the dashboard.
      const settled = before.some((old) => isInFlight(old.status) && rows.some((r) => r.id === old.id && !isInFlight(r.status)))
      if (settled) requestWalletRefresh()
      rowsRef.current = rows
      setState((s) => ({ ...s, rows, loaded: true, error: null, hasMore: reset ? requests.length >= PAGE_SIZE : s.hasMore, refreshedAt: Math.floor(Date.now() / 1000) }))
      return rows
    } catch (e) {
      setState((s) => ({ ...s, loaded: true, error: toChatError(e) }))
      return rowsRef.current
    }
  }, [api, filterKey])

  // New filter: start over, then keep the newest page fresh.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    rowsRef.current = []
    const tick = async (reset: boolean) => {
      const rows = await loadNewest(reset)
      if (cancelled) return
      timer = setTimeout(() => {
        if (document.visibilityState === 'hidden') {
          const resume = () => {
            document.removeEventListener('visibilitychange', resume)
            if (!cancelled) void tick(false)
          }
          document.addEventListener('visibilitychange', resume)
        } else void tick(false)
      }, listPollMs(rows))
    }
    void tick(true)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [loadNewest])

  const loadOlder = useCallback(async () => {
    const before = nextBefore(rowsRef.current)
    if (before === undefined) return
    setState((s) => ({ ...s, loadingOlder: true }))
    try {
      const { requests } = await api.requests({ status: filterKey ? (filterKey.split(',') as Status[]) : undefined, limit: PAGE_SIZE, before })
      const merged = mergeOlder(rowsRef.current, requests)
      rowsRef.current = merged.rows
      setState((s) => ({ ...s, rows: merged.rows, hasMore: merged.hasMore, loadingOlder: false, error: null }))
    } catch (e) {
      setState((s) => ({ ...s, loadingOlder: false, error: toChatError(e) }))
    }
  }, [api, filterKey])

  return { state, loadOlder, refresh: () => void loadNewest(false) }
}
