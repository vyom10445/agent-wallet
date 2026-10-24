import { DebugPanel } from './components/DebugPanel'
import { Dashboard } from './components/dashboard/Dashboard'
import './debug.css'

// Phase 4: the wallet dashboard, with the Phase 3 startup checks below it. Tabs (docs/UI_SPEC.md §1) come later.
function App() {
  return (
    <main className="app">
      <Dashboard />
      <details className="debug-details">
        <summary>Startup checks (debug)</summary>
        <DebugPanel />
      </details>
    </main>
  )
}

export default App
