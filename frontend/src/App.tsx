import { Activity } from './components/activity/Activity'
import { Approve } from './components/approve/Approve'
import { Chat } from './components/chat/Chat'
import { DebugPanel } from './components/DebugPanel'
import { Dashboard } from './components/dashboard/Dashboard'
import { Requests } from './components/requests/Requests'
import { WalletConnect } from './components/wallet/WalletConnect'
import { useHashRoute } from './hooks/useHashRoute'
import { OwnerWalletContext, useCreateOwnerWallet } from './hooks/useOwnerWallet'
import { useStartup } from './hooks/useStartup'
import './components/wallet/wallet.css'
import './debug.css'

// Tabs by hash (#/chat, #/dashboard, #/requests[/<id>], #/approve[/<id>], #/activity). Chat and dashboard screens stay mounted so the dashboard keeps polling and
// refreshes after chat turns even while the chat is in front.
function App() {
  const route = useHashRoute()
  const startup = useStartup()
  const wallet = useCreateOwnerWallet(startup)
  // Signing also needs the backend and the address book to agree (Phase 3 startup checks).
  const blocked =
    startup?.phase === 'ready'
      ? startup.approvalAllowed ? null : 'the backend and contracts/deployments disagree (see Startup checks)'
      : startup ? 'the backend is not ready (see Startup checks)' : 'checking the backend…'
  return (
    <OwnerWalletContext.Provider value={wallet}>
    <main className="app">
      <header className="app-header">
        <strong>Agent Wallet</strong>
        <WalletConnect compact blocked={blocked} />
      </header>
      <nav className="tabs">
        <a href="#/chat" aria-current={route.tab === 'chat' ? 'page' : undefined}>Chat</a>
        <a href="#/dashboard" aria-current={route.tab === 'dashboard' ? 'page' : undefined}>Dashboard</a>
        <a href="#/requests" aria-current={route.tab === 'requests' ? 'page' : undefined}>Requests</a>
        <a href="#/approve" aria-current={route.tab === 'approve' ? 'page' : undefined}>Approve</a>
        <a href="#/activity" aria-current={route.tab === 'activity' ? 'page' : undefined}>Activity</a>
      </nav>
      <div hidden={route.tab !== 'chat'}><Chat /></div>
      <div hidden={route.tab !== 'dashboard'}><Dashboard /></div>
      {route.tab === 'requests' && <Requests selectedId={route.requestId} />}
      {route.tab === 'approve' && (
        <Approve requestId={route.requestId} deployment={startup?.phase === 'ready' ? startup.deployment : null} blocked={blocked} />
      )}
      {route.tab === 'activity' && (
        <Activity deployment={startup?.phase === 'ready' ? startup.deployment : null} chainId={startup?.phase === 'ready' ? startup.health.chainId : null} />
      )}
      <details className="debug-details">
        <summary>Startup checks (debug)</summary>
        <DebugPanel />
      </details>
    </main>
    </OwnerWalletContext.Provider>
  )
}

export default App
