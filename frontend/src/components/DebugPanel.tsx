// Phase 3 debug panel: what GET /health says, whether the backend and the address book agree, and one direct chain read
// (owner()) through the public RPC. Temporary until the real screens arrive. All backend text renders as plain text.
import { useEffect, useState } from 'react'
import { api } from '../api'
import { createChainReads } from '../chain/reads'
import { explorerAddressUrl } from '../config'
import { formatTime, sameAddress, shortAddress } from '../lib/format'
import { runStartupChecks, type StartupState } from '../lib/startup'

type ChainOwner = { wallet: string } & ({ state: 'ok'; owner: string } | { state: 'error'; message: string })

const RETRY_MS = 5_000

export function DebugPanel() {
  const [startup, setStartup] = useState<StartupState | null>(null)
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [chainOwner, setChainOwner] = useState<ChainOwner | null>(null)

  // One check per attempt. "Check again" and the retry timer bump the attempt.
  useEffect(() => {
    let cancelled = false
    runStartupChecks(api).then((result) => {
      if (cancelled) return
      setStartup(result)
      setCheckedAt(Math.floor(Date.now() / 1000))
    })
    return () => {
      cancelled = true
    }
  }, [attempt])

  // While the backend is down, try again every few seconds so starting it is enough.
  useEffect(() => {
    if (startup?.phase !== 'unreachable') return
    const t = setTimeout(() => setAttempt((n) => n + 1), RETRY_MS)
    return () => clearTimeout(t)
  }, [startup])

  const deployment = startup?.phase === 'ready' ? startup.deployment : null
  useEffect(() => {
    if (!deployment) return
    let cancelled = false
    createChainReads(deployment)
      .owner()
      .then((owner) => !cancelled && setChainOwner({ wallet: deployment.wallet, state: 'ok', owner }))
      .catch((e: unknown) => {
        const err = e as { shortMessage?: string; message?: string }
        if (!cancelled) setChainOwner({ wallet: deployment.wallet, state: 'error', message: err.shortMessage ?? err.message ?? String(e) })
      })
    return () => {
      cancelled = true
    }
  }, [deployment])
  const owner = chainOwner && deployment && chainOwner.wallet === deployment.wallet ? chainOwner : null

  return (
    <section className="debug">
      <h1>Agent Wallet · debug</h1>
      <p className="muted">
        Backend <code>{api.baseUrl}</code>
        {checkedAt && <> · checked {formatTime(checkedAt)?.local}</>} · <button onClick={() => setAttempt((n) => n + 1)}>Check again</button>
      </p>

      {!startup && <p>Checking the backend…</p>}

      {startup?.phase === 'unreachable' && (
        <div className="banner red" role="alert">
          <strong>{startup.message}</strong>
          <div className="muted">Retrying every {RETRY_MS / 1000} s.</div>
        </div>
      )}

      {startup?.phase === 'error' && (
        <div className="banner red" role="alert">
          <strong>Startup check failed.</strong> {startup.message}
        </div>
      )}

      {startup?.phase === 'ready' && (
        <>
          {startup.mismatches.length === 0 ? (
            <div className="banner green">Addresses match: the backend and contracts/deployments/{startup.deployment.chainId}.json agree.</div>
          ) : (
            <div className="banner red" role="alert">
              <strong>Backend and address book disagree. The approval flow is disabled.</strong>
              <table>
                <thead>
                  <tr><th>Field</th><th>Backend</th><th>Expected</th></tr>
                </thead>
                <tbody>
                  {startup.mismatches.map((m) => (
                    <tr key={m.field}><td>{m.field}</td><td><code>{m.backend ?? '—'}</code></td><td><code>{m.file ?? '—'}</code></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h2>GET /health</h2>
          <table>
            <tbody>
              <tr><th>ok</th><td>{String(startup.health.ok)}</td></tr>
              <tr><th>apiVersion</th><td>{startup.health.apiVersion}</td></tr>
              <tr><th>chainId</th><td>{startup.health.chainId}{startup.health.chainId === 84532 ? ' (Base Sepolia)' : startup.health.chainId === 31337 ? ' (Anvil)' : ''}</td></tr>
              <tr><th>wallet</th><td><Addr chainId={startup.health.chainId} value={startup.health.wallet} /></td></tr>
              <tr><th>agent</th><td><Addr chainId={startup.health.chainId} value={startup.health.agent} /></td></tr>
              <tr><th>llm</th><td>{startup.health.llm}</td></tr>
              {startup.health.events && (
                <tr>
                  <th>events</th>
                  <td>
                    indexed to {startup.health.events.indexedToBlock ?? '—'} · polling {String(startup.health.events.polling)}
                    {startup.health.events.lastError && <> · last error: {startup.health.events.lastError}</>}
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <h2>Checks</h2>
          <table>
            <tbody>
              <tr><th>Address book</th><td>contracts/deployments/{startup.deployment.chainId}.json, wallet {shortAddress(startup.deployment.wallet)}</td></tr>
              <tr><th>Agent valid now</th><td>{String(startup.status.agent.validNow)} (until {startup.status.agent.validUntilIso})</td></tr>
              <tr><th>Approval flow</th><td>{startup.approvalAllowed ? 'enabled' : 'disabled (addresses differ)'}</td></tr>
              <tr>
                <th>owner() on chain</th>
                <td>
                  {!owner && 'reading…'}
                  {owner?.state === 'ok' && (
                    <>
                      <Addr chainId={startup.deployment.chainId} value={owner.owner} />{' '}
                      {sameAddress(owner.owner, startup.deployment.owner) ? '✓ matches the address book' : '✗ differs from the address book'}
                    </>
                  )}
                  {owner?.state === 'error' && <>public RPC read failed: {owner.message}</>}
                </td>
              </tr>
            </tbody>
          </table>
        </>
      )}
    </section>
  )
}

function Addr({ chainId, value }: { chainId: number; value: string }) {
  const href = explorerAddressUrl(chainId, value)
  return href ? <a href={href} target="_blank" rel="noreferrer noopener"><code>{value}</code></a> : <code>{value}</code>
}
