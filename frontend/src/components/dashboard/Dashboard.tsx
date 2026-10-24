// Wallet dashboard container: polling and the 1 s clock for the countdown. The view is DashboardView.
import { useEffect, useState } from 'react'
import { api } from '../../api'
import { useWalletStatus } from '../../hooks/useWalletStatus'
import { dashboardMode } from '../../lib/walletStatus'
import { DashboardView } from './DashboardView'
import './dashboard.css'

export function Dashboard() {
  const { state, refresh } = useWalletStatus(api)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(t)
  }, [])

  return <DashboardView mode={dashboardMode(state)} now={now} fetchedAt={state.fetchedAt} loading={state.loading} onRefresh={() => void refresh()} />
}
