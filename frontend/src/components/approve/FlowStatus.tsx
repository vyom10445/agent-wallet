// Progress and result of the signing sequence (lib/approvalFlow.ts). Pure view.
import type { Check } from '../../api/types'
import { safeExplorerUrl } from '../../lib/requestStatus'
import { canRetryVerify, type FlowState } from '../../lib/approvalFlow'
import { MismatchList } from './ApprovalDetails'
import { inert } from '../../lib/text'

const txLink = (hash: string, chainId: number) => (chainId === 84532 ? safeExplorerUrl(`https://sepolia.basescan.org/tx/${hash}`) : null)

export function FlowStatus({ flow, chainId, onRetryVerify }: { flow: FlowState; chainId: number; onRetryVerify: () => void }) {
  const tx = 'txHash' in flow ? flow.txHash : null
  const link = tx ? txLink(tx, chainId) : null
  return (
    <div className="flow" data-phase={flow.phase}>
      {flow.phase === 'checking' && <p>Re-reading the request and the chain…</p>}
      {flow.phase === 'mismatch' && <MismatchList mismatches={flow.mismatches} />}
      {flow.phase === 'refused' && <div className="banner red" role="alert">Not signed: {flow.reason}</div>}
      {flow.phase === 'cancelled' && <div className="banner red" role="alert" data-testid="cancelled">Cancelled before the wallet prompt: {flow.reason} Nothing was sent.</div>}
      {flow.phase === 'simulating' && <p>Simulating executeBatch from the owner…</p>}
      {flow.phase === 'simulateFailed' && <div className="banner red" role="alert">The simulation failed, so nothing was sent: <code>{flow.reason}</code></div>}
      {flow.phase === 'awaitingWallet' && <p className="wait">Confirm the transaction in your wallet…</p>}
      {flow.phase === 'sendFailed' && <div className="banner red" role="alert">Not sent: {flow.reason}</div>}

      {tx && (
        <p className="tx">
          Transaction <code className="wrap">{tx}</code> {link && <a href={link} target="_blank" rel="noreferrer noopener">BaseScan</a>}
        </p>
      )}
      {flow.phase === 'mining' && <p className="wait">Waiting for the block…</p>}
      {flow.phase === 'reverted' && <div className="banner red" role="alert">Your transaction reverted, so nothing was bought. You can try again.</div>}
      {flow.phase === 'verifying' && <p className="wait">Verifying on chain with the backend{flow.attempt > 1 ? ` (attempt ${flow.attempt})` : ''}…</p>}

      {canRetryVerify(flow) && (
        <div className="banner red" role="alert" data-testid="verify-failed">
          <strong>Verify failed: {flow.code}.</strong> {flow.message}
          {flow.serverMessage && <div className="muted">{flow.serverMessage}</div>}
          <Checks checks={flow.checks} />
          <p>The transaction is already on chain. Do not sign again: retry verify.</p>
          <button onClick={onRetryVerify}>Retry verify</button>
        </div>
      )}

      {flow.phase === 'verified' && (
        <div className="banner green" role="status" data-testid="verified">
          <strong>Verified: {flow.result.request.status}.</strong>{' '}
          {flow.result.request.amountPaid && <>Paid {flow.result.request.amountPaid.mUSDC} mUSDC, purchase #{flow.result.request.purchaseId}. </>}
          <Checks checks={flow.result.checks} />
        </div>
      )}
    </div>
  )
}

export function Checks({ checks }: { checks: readonly Check[] }) {
  if (!checks.length) return null
  return (
    <ul className="checks">
      {checks.map((c, i) => (
        <li key={`${c.name}-${i}`} className={c.ok ? 'ok' : 'fail'}>
          {c.ok ? '✓' : '✗'} <code>{inert(c.name)}</code>{c.detail && <> · {inert(c.detail)}</>}
        </li>
      ))}
    </ul>
  )
}
