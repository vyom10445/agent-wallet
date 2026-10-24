import { Chat } from './components/chat/Chat'
import { DebugPanel } from './components/DebugPanel'
import { Dashboard } from './components/dashboard/Dashboard'
import { useHashRoute } from './hooks/useHashRoute'
import './debug.css'

// Tabs by hash (#/chat, #/dashboard, #/approve/<id>). Both screens stay mounted so the dashboard keeps polling and
// refreshes after chat turns even while the chat is in front.
function App() {
  const route = useHashRoute()
  return (
    <main className="app">
      <nav className="tabs">
        <a href="#/chat" aria-current={route.tab === 'chat' ? 'page' : undefined}>Chat</a>
        <a href="#/dashboard" aria-current={route.tab === 'dashboard' ? 'page' : undefined}>Dashboard</a>
        <a href="#/approve" aria-current={route.tab === 'approve' ? 'page' : undefined}>Approve</a>
      </nav>
      <div hidden={route.tab !== 'chat'}><Chat /></div>
      <div hidden={route.tab !== 'dashboard'}><Dashboard /></div>
      {route.tab === 'approve' && (
        <section className="placeholder">
          <h2>Owner approval</h2>
          <p>
            {route.requestId ? <>Request <code>{route.requestId}</code> needs the owner's signature. </> : null}
            The signing screen is not built yet. Until then, sign with <code>script/OwnerApprovePurchase.s.sol</code> and nothing is bought before you do.
          </p>
        </section>
      )}
      <details className="debug-details">
        <summary>Startup checks (debug)</summary>
        <DebugPanel />
      </details>
    </main>
  )
}

export default App
