// Owner tab (#/owner): reads the agent's policy and the merchant allowance on chain, and runs owner transactions with
// the injected wallet only when the owner is connected on the backend's chain (Phase 7) and startup checks passed.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createChainReads } from '../../chain/reads'
import { explainError } from '../../chain/approval'
import { ownerGate, runOwnerTx, type OwnerCall, type OwnerTxState } from '../../chain/ownerControls'
import { ABI, type Deployment } from '../../config'
import { useOwnerWallet } from '../../hooks/useOwnerWallet'
import { onWalletRefresh, requestWalletRefresh } from '../../lib/refresh'
import { WalletConnect } from '../wallet/WalletConnect'
import { OwnerControlsPanel, type Current } from './OwnerControlsPanel'
import './owner.css'

export function OwnerControls({ deployment, agent, blocked }: { deployment: Deployment | null; agent: string | null; blocked: string | null }) {
  const { wallet, state, check } = useOwnerWallet()
  const reads = useMemo(() => (deployment ? createChainReads(deployment) : null), [deployment])
  const [current, setCurrent] = useState<Current>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!reads || !agent) return
    let cancelled = false
    Promise.all([
      reads.getAgent(agent as `0x${string}`),
      reads.allowance(),
      reads.client.readContract({ address: reads.deployment.wallet, abi: ABI.wallet, functionName: 'isAgentValid', args: [agent] }) as Promise<boolean>,
    ]).then(
      ([info, allowance, validNow]) => !cancelled && setCurrent({ state: 'ok', info, allowance, validNow }),
      (e) => !cancelled && setCurrent({ state: 'error', message: explainError(e) }),
    )
    return () => {
      cancelled = true
    }
  }, [reads, agent, attempt])

  // Re-read after any change elsewhere (chat turn, approval) too.
  useEffect(() => onWalletRefresh(() => setAttempt((n) => n + 1)), [])
  const reload = useCallback(() => setAttempt((n) => n + 1), [])

  const run = useCallback(async (call: OwnerCall, onState: (s: OwnerTxState) => void): Promise<OwnerTxState> => {
    const walletClient = wallet?.walletClient()
    if (!reads || !walletClient || state.status !== 'connected' || blocked) {
      const s: OwnerTxState = { phase: 'sendFailed', reason: 'The owner wallet is not ready.' }
      onState(s)
      return s
    }
    const end = await runOwnerTx({ publicClient: reads.client, walletClient, owner: state.account }, call, onState)
    if (end.phase === 'done' || end.phase === 'noEvent' || end.phase === 'reverted') requestWalletRefresh()
    return end
  }, [wallet, reads, state, blocked])

  if (!deployment) {
    return (
      <section className="owner-controls">
        <h2>Owner controls</h2>
        <WalletConnect blocked={blocked} />
        <p className="muted">Waiting for the backend and the address book ({blocked ?? 'checking'}).</p>
      </section>
    )
  }
  return (
    <>
      <WalletConnect blocked={blocked} />
      <OwnerControlsPanel gate={ownerGate(check, blocked)} deployment={deployment} agent={agent} current={current} run={run} onReload={reload} />
    </>
  )
}
