import { Activity } from './components/activity/Activity'
import { Approve } from './components/approve/Approve'
import { Chat } from './components/chat/Chat'
import { DebugPanel } from './components/DebugPanel'
import { Dashboard } from './components/dashboard/Dashboard'
import { OwnerControls } from './components/owner/OwnerControls'
import { Requests } from './components/requests/Requests'
import { Icon, Logo, type IconName } from './components/Icons'
import { WalletConnect } from './components/wallet/WalletConnect'
import { SUPPORTED_CHAINS } from './config'
import { useHashRoute } from './hooks/useHashRoute'
import { OwnerWalletContext, useCreateOwnerWallet } from './hooks/useOwnerWallet'
import { useStartup } from './hooks/useStartup'
import './components/wallet/wallet.css'
import './debug.css'
import './app.css'

const TABS: { tab: string; href: string; label: string; icon: IconName }[] = [
  { tab: 'chat', href: '#/chat', label: 'Chat', icon: 'chat' },
  { tab: 'dashboard', href: '#/dashboard', label: 'Dashboard', icon: 'dashboard' },
  { tab: 'requests', href: '#/requests', label: 'Requests', icon: 'requests' },
  { tab: 'approve', href: '#/approve', label: 'Approve', icon: 'approve' },
  { tab: 'activity', href: '#/activity', label: 'Activity', icon: 'activity' },
  { tab: 'owner', href: '#/owner', label: 'Owner', icon: 'owner' },
]

// Tabs by hash (#/chat, #/dashboard, #/requests[/<id>], #/approve[/<id>], #/activity, #/owner). Chat and dashboard screens stay mounted so the dashboard keeps polling and
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
    <header className="app-header">
      <div className="app-header-inner">
        <a className="brand" href="#/chat" aria-label="Agent Wallet home">
          <Logo />
          <span className="brand-text">
            <strong>Agent Wallet</strong>
            <span className="tagline">AI spending, bounded on chain</span>
          </span>
        </a>
        <nav className="tabs" aria-label="Sections">
          {TABS.map((t) => (
            <a key={t.tab} href={t.href} aria-current={route.tab === t.tab ? 'page' : undefined}>
              <Icon name={t.icon} />
              <span>{t.label}</span>
            </a>
          ))}
        </nav>
        <div className="header-right">
          <span className={`net ${startup?.phase === 'ready' ? (startup.approvalAllowed ? 'ok' : 'warn') : startup ? 'down' : 'wait'}`} title="Backend and network (see Startup checks)">
            <span className="dot" />
            {startup?.phase === 'ready'
              ? SUPPORTED_CHAINS[startup.health.chainId]?.name ?? `chain ${startup.health.chainId}`
              : startup ? 'Backend offline' : 'Connecting…'}
          </span>
          <WalletConnect compact blocked={blocked} />
        </div>
      </div>
    </header>
    <main className="app">
      <div hidden={route.tab !== 'chat'}><Chat /></div>
      <div hidden={route.tab !== 'dashboard'}><Dashboard /></div>
      {route.tab === 'requests' && <Requests selectedId={route.requestId} />}
      {route.tab === 'approve' && (
        <Approve requestId={route.requestId} deployment={startup?.phase === 'ready' ? startup.deployment : null} blocked={blocked} />
      )}
      {route.tab === 'activity' && (
        <Activity deployment={startup?.phase === 'ready' ? startup.deployment : null} chainId={startup?.phase === 'ready' ? startup.health.chainId : null} />
      )}
      {route.tab === 'owner' && (
        <OwnerControls
          deployment={startup?.phase === 'ready' ? startup.deployment : null}
          agent={startup?.phase === 'ready' ? startup.health.agent : null}
          blocked={blocked}
        />
      )}
      <details className="debug-details">
        <summary>Startup checks (debug)</summary>
        <DebugPanel />
      </details>
      <footer className="app-footer">
        <Logo size={16} />
        Limits are enforced by the AgentWallet contract, not by this page. Paid means proven on chain.
      </footer>
    </main>
    </OwnerWalletContext.Provider>
  )
}

export default App
