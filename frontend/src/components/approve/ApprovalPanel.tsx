// One request awaiting the owner (#/approve/<id>), mirroring integration/owner-approve.mjs: the calls are rebuilt from
// chain and compared with the backend's ownerApproval, the owner sets a max price, the batch is simulated, signed with
// the injected wallet, mined, then proven with POST /approvals/:id/verify. Decline only marks the request rejected.
import { useCallback, useEffect, useRef, useState } from 'react'
import { flowGuard } from '../../chain/wallet'
import { singleFlight } from '../../lib/singleFlight'
import { formatUnits, type Hash } from 'viem'
import type { ApiClient } from '../../api/client'
import type { PurchaseRequest } from '../../api/types'
import { checkApproval, checkMaxPrice, explainError, isApprovable, type ApprovalCheck, type ApprovalReads, type SendDeps } from '../../chain/approval'
import { USDC_DECIMALS, type Deployment } from '../../config'
import { useOwnerWallet } from '../../hooks/useOwnerWallet'
import { canRetryVerify, canStartSigning, isBusy, runSigning, verifyTx, type FlowState } from '../../lib/approvalFlow'
import { toChatError, type ChatError } from '../../lib/chat'
import { requestWalletRefresh } from '../../lib/refresh'
import { requestHref } from '../../lib/routes'
import { statusView } from '../../lib/requestStatus'
import { formatAmount, formatTime } from '../../lib/format'
import { ProofBadge } from '../ProofBadge'
import { WalletConnect } from '../wallet/WalletConnect'
import { ApprovalDetails, MismatchList } from './ApprovalDetails'
import { FlowStatus } from './FlowStatus'
import { inert } from '../../lib/text'

export const TX_HASH = /^0x[0-9a-fA-F]{64}$/
export const MAX_NOTE = 200

type Props = {
  api: Pick<ApiClient, 'request' | 'verify' | 'reject'>
  reads: ApprovalReads & { client: SendDeps['publicClient'] }
  deployment: Deployment
  requestId: string
  /** Startup checks failed: no signing at all. */
  blocked: string | null
}

type Preview = { state: 'loading' } | { state: 'error'; message: string } | { state: 'done'; check: ApprovalCheck }

type Loaded = { ok: false; error: ChatError } | { ok: true; request: PurchaseRequest; preview: Preview | null }

async function loadPanel(api: Props['api'], reads: ApprovalReads, deployment: Deployment, requestId: string): Promise<Loaded> {
  let request: PurchaseRequest
  try {
    request = await api.request(requestId)
  } catch (e) {
    return { ok: false, error: toChatError(e) }
  }
  if (!isApprovable(request)) return { ok: true, request, preview: null }
  try {
    return { ok: true, request, preview: { state: 'done', check: await checkApproval(reads, deployment, request) } }
  } catch (e) {
    return { ok: true, request, preview: { state: 'error', message: explainError(e) } }
  }
}

export function ApprovalPanel({ api, reads, deployment, requestId, blocked }: Props) {
  const { wallet, state: walletState, check: signCheck } = useOwnerWallet()
  const [request, setRequest] = useState<PurchaseRequest | null>(null)
  const [loadError, setLoadError] = useState<ChatError | null>(null)
  const [preview, setPreview] = useState<Preview>({ state: 'loading' })
  const [maxPrice, setMaxPrice] = useState('')
  const [flow, setFlow] = useState<FlowState>({ phase: 'idle' })
  const [pasted, setPasted] = useState('')
  const [note, setNote] = useState('')
  const [declining, setDeclining] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null })
  // Synchronous guards on top of the disabled buttons: a double click can never open two wallet prompts or send two
  // verify / reject calls.
  const signing = useRef(singleFlight())
  const verifying = useRef(singleFlight())
  const declineFlight = useRef(singleFlight())
  const blockedRef = useRef(blocked)
  useEffect(() => {
    blockedRef.current = blocked
  }, [blocked])
  const verifyAttempt = useRef(0)

  const [attempt, setAttempt] = useState(0)

  // GET /requests/:id, then a fresh rebuild from chain. The latest load wins (older answers are dropped).
  useEffect(() => {
    let cancelled = false
    void loadPanel(api, reads, deployment, requestId).then((res) => {
      if (cancelled) return
      if (!res.ok) {
        setRequest(null)
        setLoadError(res.error)
        return
      }
      setRequest(res.request)
      setLoadError(null)
      if (!res.preview) return
      setPreview(res.preview)
      const p = res.preview
      if (p.state === 'done') setMaxPrice((m) => m || formatUnits(p.check.rebuilt.price, USDC_DECIMALS))
    })
    return () => {
      cancelled = true
    }
  }, [api, reads, deployment, requestId, attempt])

  /** Reload from a click or after a change: the old preview is cleared so a stale one is never signed. */
  const reload = useCallback(() => {
    setPreview({ state: 'loading' })
    setAttempt((n) => n + 1)
  }, [])

  const onDone = useCallback(() => {
    requestWalletRefresh()
    reload()
  }, [reload])

  const ctxBase = { api, requestId, onState: setFlow, onDone }

  async function sign() {
    if (signing.current.running || verifying.current.running || !canStartSigning(flow)) return
    const walletClient = wallet?.walletClient()
    if (!wallet || !walletClient || walletState.status !== 'connected' || blocked) return
    // Switching account or network (or the startup checks failing) mid-flow cancels before the wallet prompt.
    const guard = flowGuard(wallet, () => blockedRef.current)
    verifyAttempt.current = 1
    await signing.current.run(() =>
      runSigning({
        ...ctxBase,
        reads,
        deployment,
        maxPriceText: maxPrice,
        guard,
        send: { publicClient: reads.client, walletClient, owner: walletState.account, deployment },
      }),
    )
  }

  function retryVerify() {
    if (!canRetryVerify(flow)) return
    const txHash = flow.txHash
    void verifying.current.run(() => {
      verifyAttempt.current = Math.max(verifyAttempt.current, 1) + 1
      return verifyTx(ctxBase, txHash, verifyAttempt.current)
    })
  }

  function verifyPasted() {
    const h = pasted.trim()
    if (!TX_HASH.test(h) || isBusy(flow) || signing.current.running) return
    void verifying.current.run(() => {
      verifyAttempt.current = 1
      return verifyTx(ctxBase, h as Hash, 1)
    })
  }

  function decline() {
    void declineFlight.current.run(doDecline)
  }

  async function doDecline() {
    if (note.length > MAX_NOTE || declining.busy) return
    if (!window.confirm('Decline this purchase? This only marks the request rejected: it moves no funds and changes nothing on chain.')) return
    setDeclining({ busy: true, error: null })
    try {
      await api.reject(requestId, note.trim() ? note.trim() : undefined)
      setDeclining({ busy: false, error: null })
      requestWalletRefresh()
      reload()
    } catch (e) {
      const err = toChatError(e)
      setDeclining({ busy: false, error: `${err.text}${err.detail ? ` (${err.detail})` : ''}` })
    }
  }

  if (loadError) {
    return (
      <div className="approval">
        <div className="banner red" role="alert" data-testid="load-error">
          <strong>Could not load the request ({loadError.code}).</strong> {loadError.text}
          {loadError.detail && <div className="muted">{loadError.detail}</div>}
          <p>Nothing can be signed until it loads.</p>
          <button onClick={reload}>Reload</button>
        </div>
      </div>
    )
  }
  if (!request) return <div className="approval"><p>Loading request <code>{requestId}</code>…</p></div>

  const view = statusView(request)
  const liveTx = flow.phase !== 'idle' && 'txHash' in flow
  const header = (
    <div className="approval-head">
      <h3>Request <a href={requestHref(request.id)}><code>{request.id}</code></a></h3>
      <span className={`status ${view.tone}`}>{view.label}</span>
      <span>{request.credits} credits</span>
      {request.price && <span>backend price {formatAmount(request.price)}</span>}
      <span className="muted">created {formatTime(request.createdAt)?.local}</span>
      <button onClick={reload} disabled={isBusy(flow)}>Reload</button>
    </div>
  )
  const reason = request.reason ? <p className="reason">Agent's reason (untrusted): <span className="untrusted">{inert(request.reason)}</span></p> : null

  // Already settled: show it, never a sign button. Keep the flow result on screen if it came from this page.
  if (!isApprovable(request)) {
    return (
      <div className="approval">
        {header}
        {reason}
        {request.status === 'fulfilled_by_owner' ? (
          <div className="banner green" role="status" data-testid="already-fulfilled">
            Already bought with owner approval. <ProofBadge request={request} />
            {request.txHash && <> Transaction <code className="wrap">{request.txHash}</code>.</>} Nothing to sign.
          </div>
        ) : (
          <div className="banner grey" data-testid="not-approvable">
            This request is <strong>{request.status}</strong>{request.status === 'needs_owner_approval' || request.status === 'expired' ? ' but the backend sent no ownerApproval' : ''}: it cannot be approved here.
          </div>
        )}
        {flow.phase !== 'idle' && <FlowStatus flow={flow} chainId={deployment.chainId} onRetryVerify={retryVerify} />}
      </div>
    )
  }

  const ready = preview.state === 'done' && preview.check.ok ? preview.check.rebuilt : null
  const max = ready ? checkMaxPrice(ready.price, maxPrice) : null
  const signDisabledReason =
    blocked ? `Signing disabled: ${blocked}` :
    !signCheck.canSign ? signCheck.reason :
    preview.state === 'loading' ? 'Reading the chain…' :
    preview.state === 'error' ? 'The chain could not be read.' :
    !ready ? 'The approval does not match the chain.' :
    max && !max.ok ? max.reason :
    !canStartSigning(flow) ? (liveTx ? 'A transaction was already sent for this request: verify it, do not sign again.' : 'Working…') :
    null

  return (
    <div className="approval">
      {header}
      {reason}
      {request.status === 'expired' && <p className="muted">The agent's window passed (expired). The owner can still buy it.</p>}

      {preview.state === 'loading' && <p>Reading quote and allowance from chain…</p>}
      {preview.state === 'error' && <div className="banner red" role="alert">Could not read the chain: {preview.message}. No sign button until it can.</div>}
      {preview.state === 'done' && !preview.check.ok && <MismatchList mismatches={preview.check.mismatches} />}
      {preview.state === 'done' && <ApprovalDetails rebuilt={preview.check.rebuilt} wallet={deployment.wallet} />}

      <div className="sign-box">
        <WalletConnect blocked={blocked} />
        <label>
          Max price (mUSDC){' '}
          <input value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} inputMode="decimal" required aria-label="Max price (mUSDC)" disabled={isBusy(flow)} />
        </label>
        {max && !max.ok && <span className="field-error" role="alert">{max.reason}</span>}
        <button className="primary" onClick={() => void sign()} disabled={signDisabledReason !== null} data-testid="sign">
          {flow.phase === 'awaitingWallet' ? 'Confirm in wallet…' : 'Sign and buy'}
        </button>
        {signDisabledReason && <span className="muted" data-testid="sign-disabled">{signDisabledReason}</span>}
      </div>

      <FlowStatus flow={flow} chainId={deployment.chainId} onRetryVerify={retryVerify} />

      <details className="fallback">
        <summary>Already signed elsewhere? Paste the tx hash</summary>
        <p className="muted">For a purchase sent with script/OwnerApprovePurchase.s.sol. This only asks the backend to verify it; nothing is signed.</p>
        <input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="0x… (66 characters)" aria-label="Transaction hash" spellCheck={false} />
        <button onClick={verifyPasted} disabled={!TX_HASH.test(pasted.trim()) || isBusy(flow)}>Verify</button>
        {pasted.trim() && !TX_HASH.test(pasted.trim()) && <span className="field-error">A tx hash is 0x plus 64 hex characters.</span>}
      </details>

      {request.status === 'needs_owner_approval' && !liveTx && (
        <details className="decline">
          <summary>Decline</summary>
          <p className="muted">Marks the request rejected. It moves no funds and changes nothing on chain.</p>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note" aria-label="Decline note" maxLength={MAX_NOTE} />
          <span className="muted">{note.length}/{MAX_NOTE}</span>
          <button onClick={decline} disabled={declining.busy || note.length > MAX_NOTE || isBusy(flow)}>{declining.busy ? 'Declining…' : 'Decline'}</button>
          {declining.error && <div className="banner red" role="alert">Not declined: {declining.error}</div>}
        </details>
      )}
    </div>
  )
}
