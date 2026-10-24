// Live status of one purchase request (see lib/watchRequest.ts). When an in-flight request settles, the dashboard
// refreshes, so spentToday and credits update without a page reload.
import { useEffect, useState } from 'react'
import type { ApiClient } from '../api/client'
import { requestWalletRefresh } from '../lib/refresh'
import { watchRequest, type WatchState } from '../lib/watchRequest'

export function useRequestStatus(api: ApiClient, id: string): WatchState {
  const [state, setState] = useState<WatchState>({ request: null, error: null })
  useEffect(() => watchRequest(api, id, setState, { onSettled: requestWalletRefresh }), [api, id])
  return state
}
