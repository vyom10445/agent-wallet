// The startup checks (lib/startup.ts) for the whole app: run once, retried every 5 s while the backend is unreachable.
import { useEffect, useState } from 'react'
import { api } from '../api'
import { runStartupChecks, type StartupState } from '../lib/startup'

const RETRY_MS = 5_000

export function useStartup(): StartupState | null {
  const [state, setState] = useState<StartupState | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    runStartupChecks(api).then((s) => !cancelled && setState(s))
    return () => {
      cancelled = true
    }
  }, [attempt])

  useEffect(() => {
    if (state?.phase !== 'unreachable') return
    const t = setTimeout(() => setAttempt((n) => n + 1), RETRY_MS)
    return () => clearTimeout(t)
  }, [state])

  return state
}
