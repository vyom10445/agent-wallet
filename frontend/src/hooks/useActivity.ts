// GET /events for the Activity tab: the newest page plus GET /health (indexer status) and the chain head, refreshed
// every 15 s while the page is visible. "Load older" pages back (lib/activity.ts nextBefore).
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../api/client'
import type { ChainEvent, EventType, Health } from '../api/types'
import { toChatError, type ChatError } from '../lib/chat'
import { ACTIVITY_POLL_MS, EVENTS_PAGE, mergeNewest, mergeOlder, nextBefore } from '../lib/activity'

export type ActivityState = {
  rows: ChainEvent[]
  loaded: boolean
  error: ChatError | null
  hasMore: boolean
  loadingOlder: boolean
  refreshedAt: number | null
  eventsIndexedTo: number | null
  health: Health | null
  head: number | null
}

const empty: ActivityState = {
  rows: [], loaded: false, error: null, hasMore: false, loadingOlder: false, refreshedAt: null, eventsIndexedTo: null, health: null, head: null,
}

/** @param readHead the chain head through the public RPC (never the wallet); null when the address book is not ready. */
export function useActivity(api: Pick<ApiClient, 'events' | 'health'>, types: readonly EventType[], readHead: (() => Promise<bigint>) | null) {
  const [state, setState] = useState<ActivityState>(empty)
  const rowsRef = useRef<ChainEvent[]>([])
  const typeKey = types.join(',')
  const typeList = useCallback(() => (typeKey ? (typeKey.split(',') as EventType[]) : undefined), [typeKey])

  const loadNewest = useCallback(async (reset: boolean) => {
    const [events, health, head] = await Promise.allSettled([
      api.events({ type: typeList(), limit: EVENTS_PAGE }),
      api.health(),
      readHead ? readHead() : Promise.reject(new Error('no chain')),
    ])
    const now = Math.floor(Date.now() / 1000)
    const ok = events.status === 'fulfilled' ? events.value : null
    const rows = ok ? (reset ? ok.events : mergeNewest(rowsRef.current, ok.events)) : rowsRef.current
    rowsRef.current = rows
    setState((s) => {
      const next = {
        ...s,
        loaded: true,
        health: health.status === 'fulfilled' ? health.value : null,
        head: head.status === 'fulfilled' ? Number(head.value) : s.head,
      }
      if (!ok) return { ...next, error: toChatError((events as PromiseRejectedResult).reason) }
      return { ...next, rows, error: null, refreshedAt: now, eventsIndexedTo: ok.indexedToBlock, hasMore: reset ? ok.events.length >= EVENTS_PAGE : s.hasMore }
    })
  }, [api, typeList, readHead])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    rowsRef.current = []
    const tick = async (reset: boolean) => {
      await loadNewest(reset)
      if (cancelled) return
      timer = setTimeout(() => {
        if (document.visibilityState === 'hidden') {
          const resume = () => {
            document.removeEventListener('visibilitychange', resume)
            if (!cancelled) void tick(false)
          }
          document.addEventListener('visibilitychange', resume)
        } else void tick(false)
      }, ACTIVITY_POLL_MS)
    }
    void tick(true)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [loadNewest])

  const loadOlder = useCallback(async () => {
    if (!rowsRef.current.length) return
    setState((s) => ({ ...s, loadingOlder: true }))
    try {
      let page = (await api.events({ type: typeList(), limit: EVENTS_PAGE, before: nextBefore(rowsRef.current) })).events
      let merged = mergeOlder(rowsRef.current, page)
      if (merged.added === 0 && merged.hasMore) {
        // One block holds more events than a page: step past it.
        page = (await api.events({ type: typeList(), limit: EVENTS_PAGE, before: nextBefore(rowsRef.current, false) })).events
        merged = mergeOlder(rowsRef.current, page)
      }
      rowsRef.current = merged.rows
      setState((s) => ({ ...s, rows: merged.rows, hasMore: merged.hasMore && merged.added > 0, loadingOlder: false, error: null }))
    } catch (e) {
      setState((s) => ({ ...s, loadingOlder: false, error: toChatError(e) }))
    }
  }, [api, typeList])

  return { state, loadOlder, refresh: () => void loadNewest(false) }
}
