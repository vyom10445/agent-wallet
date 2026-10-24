// Every PurchaseRequest field from GET /requests/:id (docs/UI_SPEC.md §2.3). Backend text (reason, error.message,
// proofChecks detail) is shown as plain text only.
import type { ReactNode } from 'react'
import type { PurchaseRequest } from '../../api/types'
import { formatRelative, formatTime, formatWei } from '../../lib/format'
import { requestErrorText } from '../../lib/messages'
import { isPaidStatus, needsOwner, safeExplorerUrl, statusView } from '../../lib/requestStatus'
import { approvalHref } from '../../lib/routes'
import { ProofBadge } from '../ProofBadge'
import { inert, inertOrNull } from '../../lib/text'

const PRECHECK: Record<string, string> = {
  AGENT_OK: "Within the agent's limits",
  NEEDS_OWNER: "Above the agent's limits",
  NEEDS_OWNER_TOPUP: 'Allowance or balance too low for the agent',
  BLOCKED: 'Blocked by policy',
}

export function RequestDetailView({ request: r, now, errorText }: { request: PurchaseRequest; now: number; errorText: string | null }) {
  const v = statusView(r)
  const tx = safeExplorerUrl(r.explorerUrl)
  return (
    <article className="detail" data-request={r.id}>
      <header>
        <h3><code>{r.id}</code></h3>
        <span className={`status ${v.tone}`}>{v.label}</span>{v.paid ? <> <ProofBadge request={r} /></> : null}
        <p className={v.tone === 'red' ? 'warn' : 'muted'} data-proof-hint={isPaidStatus(r.status) && !v.paid ? String(r.proofVerified ?? null) : undefined}>{v.hint}</p>
        {errorText && <p className="muted">Refresh failed: {errorText} (showing the last values read)</p>}
        {r.ownerApproval && needsOwner(r.status) && <a className="button" href={approvalHref(r.id)}>Open in Approve</a>}
      </header>

      <Section title="Summary">
        <Row label="Status"><code>{r.status}</code></Row>
        <Row label="Credits">{r.credits}</Row>
        <Row label="Agent's reason (untrusted)"><span className="untrusted">{inertOrNull(r.reason) ?? '—'}</span></Row>
        <Row label="Price (quote at pre-check)">{r.price ? `${r.price.mUSDC} mUSDC (${r.price.base})` : '—'}</Row>
        <Row label="Amount paid">{r.amountPaid ? `${r.amountPaid.mUSDC} mUSDC (${r.amountPaid.base})` : '—'}</Row>
        <Row label="Purchase id">{r.purchaseId ?? '—'}</Row>
        <Row label="Path">{r.path ?? '—'}</Row>
        <Row label="Pre-check">{r.precheck ? `${r.precheck}: ${PRECHECK[r.precheck] ?? ''}` : '—'}</Row>
        <Row label="Conversation">{r.conversationId ?? '—'}</Row>
      </Section>

      {r.error && (
        <Section title="Error">
          <Row label="Code"><code>{inert(r.error.code)}</code></Row>
          <Row label="Meaning">{inert(requestErrorText(r.error.code))}</Row>
          <Row label="Decoded reason"><code className="wrap">{inertOrNull(r.error.message) ?? '—'}</code></Row>
        </Section>
      )}

      <Section title="Chain">
        <Row label="Tx hash">{r.txHash ? (tx ? <a href={tx} target="_blank" rel="noreferrer noopener"><code className="wrap">{r.txHash}</code></a> : <code className="wrap">{r.txHash}</code>) : '—'}</Row>
        <Row label="Block">{r.blockNumber ?? '—'}</Row>
        {r.path !== 'owner' && (
          <>
            <Row label="UserOp hash">{r.userOpHash ? <code className="wrap">{r.userOpHash}</code> : '—'}</Row>
            <Row label="UserOp nonce">{r.nonce ? <code className="wrap">{r.nonce}</code> : '—'}</Row>
            <Row label="Gas cost (actualGasCost)">{r.actualGasCost ? formatWei(r.actualGasCost) : '—'}</Row>
          </>
        )}
        <Row label="Agent"><code className="wrap">{r.agent}</code></Row>
      </Section>

      {(r.proofChecks?.length ?? 0) > 0 && (
        <Section title="Proof checks (re-checked on chain)">
          <ul className="checks">
            {r.proofChecks!.map((c, i) => (
              <li key={`${c.name}-${i}`} className={c.ok ? 'ok' : 'fail'}>
                {c.ok ? '✓' : '✗'} <code>{c.name}</code>{c.detail && <> · <span>{inert(c.detail)}</span></>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Times">
        <Row label="Created"><Time t={r.createdAt} /></Row>
        <Row label="Updated"><Time t={r.updatedAt} /></Row>
        {r.path === 'owner' && (
          <Row label="Expires">
            {r.expiresAt === null ? '—' : (
              <>
                <Time t={r.expiresAt} />
                <div className="muted">{r.expiresAt > now ? `expires ${formatRelative(r.expiresAt, now)}` : `expired ${formatRelative(r.expiresAt, now)}`}</div>
              </>
            )}
          </Row>
        )}
      </Section>
    </article>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h4>{title}</h4>
      {children}
    </section>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="row">
      <span className="label">{label}</span>
      <span className="value">{children}</span>
    </div>
  )
}

function Time({ t }: { t: number }) {
  const f = formatTime(t)
  return <span title={f?.utc}>{f?.local} <span className="muted">{f?.utc}</span></span>
}
