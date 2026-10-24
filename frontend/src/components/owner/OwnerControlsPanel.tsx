// Owner controls (pure view + local form state): setPolicy, revokeAgent and the merchant allowance. Each action is
// reviewed first: the decoded call is shown, and only "Confirm and open wallet" runs simulate → wallet → receipt → event.
import { useState } from 'react'
import { formatUnits } from 'viem'
import type { AgentInfo } from '../../chain/reads'
import {
  REVOKE_WORD, buildOwnerCall, ownerTxBusy, revokeConfirmed, validAgent, validateAllowance, validatePolicy,
  type DecodedCall, type OwnerCall, type OwnerTxState,
} from '../../chain/ownerControls'
import { USDC_DECIMALS, explorerTxUrl, type Deployment } from '../../config'
import { formatTime } from '../../lib/format'

export type Current = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; info: AgentInfo; allowance: bigint; validNow: boolean }

type Props = {
  gate: { enabled: boolean; reason: string | null }
  deployment: Deployment
  agent: string | null
  current: Current
  run: (call: OwnerCall, onState: (s: OwnerTxState) => void) => Promise<OwnerTxState>
  onReload: () => void
}

const m = (v: bigint) => formatUnits(v, USDC_DECIMALS)

export function OwnerControlsPanel({ gate, deployment, agent, current, run, onReload }: Props) {
  const [maxText, setMaxText] = useState<string | null>(null)
  const [dailyText, setDailyText] = useState<string | null>(null)
  const [allowanceText, setAllowanceText] = useState('10')
  const [revokeText, setRevokeText] = useState('')
  const [pending, setPending] = useState<OwnerCall | null>(null)
  const [tx, setTx] = useState<OwnerTxState>({ phase: 'idle' })
  const [buildError, setBuildError] = useState<string | null>(null)

  const info = current.state === 'ok' ? current.info : null
  const max = maxText ?? (info ? m(info.maxPerTx) : '1')
  const daily = dailyText ?? (info ? m(info.dailyLimit) : '5')
  const policy = validatePolicy(max, daily)
  const allowance = validateAllowance(allowanceText)
  const agentOk = validAgent(agent)
  const busy = ownerTxBusy(tx)
  const locked = !gate.enabled || busy || pending !== null
  const active = info?.active === true

  function review(build: () => OwnerCall) {
    setBuildError(null)
    try {
      setPending(build())
      setTx({ phase: 'idle' })
    } catch (e) {
      setBuildError(e instanceof Error ? e.message : String(e))
    }
  }

  async function confirm() {
    if (!pending || !gate.enabled || busy) return
    const call = pending
    const end = await run(call, setTx)
    setPending(null)
    if (end.phase === 'done' && call.action.kind === 'revokeAgent') setRevokeText('')
  }

  const txUrl = 'txHash' in tx ? explorerTxUrl(deployment.chainId, tx.txHash) : null

  return (
    <section className="owner-controls" data-enabled={String(gate.enabled)}>
      <h2>Owner controls</h2>
      {gate.reason && <div className="banner yellow" role="status" data-testid="gate">{gate.reason}</div>}

      <div className="current">
        <strong>Agent</strong> <code>{agent ?? '—'}</code>
        {current.state === 'loading' && <span className="muted"> reading on chain…</span>}
        {current.state === 'error' && <span className="error"> Could not read the chain: {current.message}</span>}
        {info && (
          <span>
            {' '}· {info.active ? (current.state === 'ok' && current.validNow ? 'active, valid now' : 'active, not valid now') : 'not registered / revoked'}
            {' '}· maxPerTx {m(info.maxPerTx)} · dailyLimit {m(info.dailyLimit)} · spentToday {m(info.spentToday)} mUSDC
            {info.validUntil > 0 && <> · valid until {formatTime(info.validUntil)?.local}</>}
          </span>
        )}
        {current.state === 'ok' && <span> · merchant allowance {m(current.allowance)} mUSDC</span>}
        <button className="link" onClick={onReload} disabled={busy}>Reload</button>
      </div>

      <div className="cards">
        <div className="card" data-action="setPolicy">
          <h3>Set policy</h3>
          <p className="muted">setPolicy(agent, mUSDC, maxPerTx, dailyLimit). The token is always the deployment's mUSDC.</p>
          <label>maxPerTx (mUSDC) <input value={max} onChange={(e) => setMaxText(e.target.value)} inputMode="decimal" aria-label="maxPerTx (mUSDC)" disabled={locked} /></label>
          <label>dailyLimit (mUSDC) <input value={daily} onChange={(e) => setDailyText(e.target.value)} inputMode="decimal" aria-label="dailyLimit (mUSDC)" disabled={locked} /></label>
          {!policy.ok && <div className="field-error" role="alert">{policy.reason}</div>}
          {!active && current.state === 'ok' && <div className="muted">The agent is not active: setPolicy would revert. Re-add it with ConfigureAgent.</div>}
          <button
            data-testid="review-setPolicy"
            disabled={locked || !policy.ok || !agentOk}
            onClick={() => policy.ok && agentOk && review(() => buildOwnerCall({ kind: 'setPolicy', agent, maxPerTx: policy.maxPerTx, dailyLimit: policy.dailyLimit }, deployment))}
          >Review setPolicy</button>
        </div>

        <div className="card" data-action="allowance">
          <h3>Merchant allowance</h3>
          <p className="muted">execute(mUSDC, 0, approve(merchant, amount)), as ConfigureAgent does. This sets the allowance to the amount, it does not add to it.</p>
          <label>New allowance (mUSDC) <input value={allowanceText} onChange={(e) => setAllowanceText(e.target.value)} inputMode="decimal" aria-label="New allowance (mUSDC)" disabled={locked} /></label>
          {!allowance.ok && <div className="field-error" role="alert">{allowance.reason}</div>}
          <button
            data-testid="review-allowance"
            disabled={locked || !allowance.ok}
            onClick={() => allowance.ok && review(() => buildOwnerCall({ kind: 'allowance', amount: allowance.amount }, deployment))}
          >Review allowance</button>
        </div>

        <div className="card danger" data-action="revokeAgent">
          <h3>Revoke agent</h3>
          <p className="muted">revokeAgent(agent) deletes the agent's policy at once; its pending purchases will fail. Re-adding the agent is done with <code>script/ConfigureAgent.s.sol</code>, not here.</p>
          <label>Type {REVOKE_WORD} to enable <input value={revokeText} onChange={(e) => setRevokeText(e.target.value)} aria-label="Type REVOKE" disabled={locked} autoComplete="off" /></label>
          <button
            className="red"
            data-testid="review-revokeAgent"
            disabled={locked || !revokeConfirmed(revokeText) || !agentOk}
            onClick={() => agentOk && review(() => buildOwnerCall({ kind: 'revokeAgent', agent }, deployment))}
          >Review revoke</button>
        </div>
      </div>

      {buildError && <div className="banner red" role="alert">{buildError}</div>}

      {pending && (
        <div className={`confirm ${pending.action.kind === 'revokeAgent' ? 'danger' : ''}`} data-testid="confirm">
          <strong>You are about to sign a normal transaction from the owner account:</strong>
          <CallView call={pending.decoded} />
          <p className="muted">Expected event after mining: {pending.expect.eventName}. Calldata <code className="wrap">{pending.data}</code></p>
          <button className={pending.action.kind === 'revokeAgent' ? 'red' : 'primary'} data-testid="confirm-send" disabled={!gate.enabled || busy} onClick={() => void confirm()}>
            {busy ? 'Working…' : 'Confirm and open wallet'}
          </button>
          <button onClick={() => setPending(null)} disabled={busy}>Cancel</button>
        </div>
      )}

      <TxStatus tx={tx} txUrl={txUrl} />
    </section>
  )
}

function CallView({ call }: { call: DecodedCall }) {
  return (
    <div className="call">
      <code>{call.contract}</code> <code className="wrap">{call.to}</code>
      <div>
        <strong>{call.functionName}</strong>(
        {call.args.map((a, i) => (
          <span key={a.name}>
            {i > 0 && ', '}
            {a.name} = <code className="wrap">{a.value}</code>{a.note && <span className="muted"> ({a.note})</span>}
          </span>
        ))}
        )
      </div>
      {call.inner && <div className="inner">which calls: <CallView call={call.inner} /></div>}
    </div>
  )
}

function TxStatus({ tx, txUrl }: { tx: OwnerTxState; txUrl: string | null }) {
  if (tx.phase === 'idle') return null
  const hash = 'txHash' in tx ? tx.txHash : null
  return (
    <div className="tx-status" data-phase={tx.phase}>
      {tx.phase === 'simulating' && <p>Simulating from the owner…</p>}
      {tx.phase === 'simulateFailed' && <div className="banner red" role="alert">The simulation failed, so nothing was sent: <code>{tx.reason}</code></div>}
      {tx.phase === 'awaitingWallet' && <p>Confirm the transaction in your wallet…</p>}
      {tx.phase === 'sendFailed' && <div className="banner red" role="alert">Not sent: {tx.reason}</div>}
      {hash && <p>Transaction <code className="wrap">{hash}</code> {txUrl && <a href={txUrl} target="_blank" rel="noreferrer noopener">BaseScan</a>}</p>}
      {tx.phase === 'mining' && <p>Waiting for the block…</p>}
      {tx.phase === 'reverted' && <div className="banner red" role="alert">The transaction reverted. Nothing changed.</div>}
      {tx.phase === 'noEvent' && <div className="banner red" role="alert">{tx.reason}</div>}
      {tx.phase === 'done' && <div className="banner green" role="status">Done: <code>{tx.event}</code>. The dashboard was refreshed.</div>}
    </div>
  )
}
