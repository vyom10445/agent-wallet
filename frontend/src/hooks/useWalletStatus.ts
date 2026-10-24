// Polls GET /wallet/status every 15 s (UI_SPEC §5), pauses while the browser tab is hidden, never overlaps two reads,
// and refreshes at once on requestWalletRefresh() (after a chat turn or an approval) or a manual refresh.
import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { ApiClient } from '../api/client'
import { onWalletRefresh } from '../lib/refresh'
import { initialWalletStatusState, walletStatusReducer } from '../lib/walletStatus'

export const WALLET_STATUS_POLL_MS = 15_000

const nowSeconds = () => Math.floor(Date.now() / 1000)

export function useWalletStatus(api: ApiClient, pollMs = WALLET_STATUS_POLL_MS) {
  const [state, dispatch] = useReducer(walletStatusReducer, initialWalletStatusState)
  const inFlight = useRef(false)

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    dispatch({ type: 'start' })
    try {
      const data = await api.walletStatus()
      dispatch({ type: 'success', data, at: nowSeconds() })
    } catch (error) {
      dispatch({ type: 'failure', error, at: nowSeconds() })
    } finally {
      inFlight.current = false
    }
  }, [api])

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    const start = () => {
      if (timer) return
      void refresh()
      timer = setInterval(() => void refresh(), pollMs)
    }
    const stop = () => {
      clearInterval(timer)
      timer = undefined
    }
    const onVisibility = () => (document.visibilityState === 'hidden' ? stop() : start())
    if (document.visibilityState !== 'hidden') start()
    document.addEventListener('visibilitychange', onVisibility)
    const unsubscribe = onWalletRefresh(() => void refresh())
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
      unsubscribe()
    }
  }, [refresh, pollMs])

  return { state, refresh }
}
