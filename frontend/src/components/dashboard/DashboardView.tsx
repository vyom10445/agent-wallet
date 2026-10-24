// The wallet dashboard (docs/UI_SPEC.md §2.1), from GET /wallet/status only. Pure: everything comes in as props, so the
// current, stale and offline states can be rendered and tested without a backend.
import type { ReactNode } from 'react'
import type { Amount, WalletStatus } from '../../api/types'
import { explorerAddressUrl } from '../../config'
import { formatRelative, formatTime, formatWei, shortAddress } from '../../lib/format'
import { agentValidity, formatCountdown, type DashboardMode, type Validity } from '../../lib/walletStatus'
import { SpendBar } from './SpendBar'
import { WarningBanners } from './WarningBanners'

type Props = {
  mode: DashboardMode
  /** Browser time, unix seconds (ticks every second for the countdown). */
  now: number
  /** Browser time of the last good read, to translate `now` into chain time (readAt is the block time). */
  fetchedAt: number | null
  loading: boolean
  onRefresh: () => void
}

export function DashboardView({ mode, now, fetchedAt, loading, onRefresh }: Props) {
  const toolbar = (
    <div className="toolbar">
      <h2>Wallet</h2>
      {(mode.kind === 'current' || mode.kind === 'stale') && <ReadAt data={mode.data} now={now} />}
      <button onClick={onRefresh} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
    </div>
  )

  if (mode.kind === 'loading') return <section className="dashboard">{toolbar}<p>Reading the wallet…</p></section>
  if (mode.kind === 'offline' || mode.kind === 'error') {
    return (
      <section className="dashboard">
        {toolbar}
        <div className="banner red" role="alert" data-state={mode.kind}>
          <strong>{mode.kind === 'offline' ? 'Backend offline.' : 'Could not read the wallet.'}</strong> {mode.failure.message}
          {mode.failure.serverMessage && <div className="muted">{mode.failure.serverMessage}</div>}
        </div>
      </section>
    )
  }

  const s = mode.data
  const stale = mode.kind === 'stale'
  // Chain time now ≈ the block time we read + how long ago we read it.
  const chainNow = fetchedAt === null ? s.readAt : s.readAt + (now - fetchedAt)
  const validity = agentValidity(s.agent, chainNow)

  return (
    <section className={`dashboard${stale ? ' stale' : ''}`} data-state={mode.kind} aria-busy={loading}>
      {toolbar}
      {stale && (
        <div className="banner grey" role="status" data-state="stale">
          <strong>Stale since {formatTime(mode.since)?.local}.</strong>{' '}
          {mode.offline ? 'The backend is not reachable.' : mode.failure.code === 'RPC_ERROR' ? 'The backend could not read the chain.' : mode.failure.message}{' '}
          These are the last values read, not the current ones.
        </div>
      )}
      <WarningBanners warnings={s.warnings} validUntilIso={s.agent.validUntilIso} />

      <div className="kpis">
        <Kpi label="Wallet balance" value={s.wallet.balance.mUSDC} unit="mUSDC" tone="cyan" />
        <Kpi label="Left to spend today" value={s.agent.remainingDailyAllowance.mUSDC} unit={`of ${s.agent.dailyLimit.mUSDC} mUSDC`} tone="violet" />
        <Kpi label="Max per purchase" value={s.agent.maxPerTx.mUSDC} unit="mUSDC" tone="magenta" />
        <Kpi label="Credits owned" value={String(s.wallet.credits)} unit={`at ${s.merchant.pricePerCredit.mUSDC} mUSDC each`} tone="green" />
        <div className={`kpi agent-kpi ${validity.kind === 'valid' ? 'live' : 'down'}`}>
          <span className="kpi-label">Agent</span>
          <span className="kpi-value">{validity.kind === 'valid' ? 'Live' : validity.kind === 'revoked' ? 'Revoked' : 'Not valid'}</span>
          <span className="kpi-unit">{validity.kind === 'valid' ? 'can buy within policy' : 'cannot buy'}</span>
        </div>
      </div>

      <div className="cards">
        <Card title="Agent">
          <Row label="Address"><Addr chainId={s.chainId} value={s.addresses.agent} /></Row>
          <Row label="Status"><ValidityBadge validity={validity} /></Row>
          <Row label="Valid from"><Time t={s.agent.validAfter} /></Row>
          <Row label="Valid until">
            <Time t={s.agent.validUntil} />
            {validity.kind === 'valid' && validity.countdown !== null && (
              <div className="countdown" data-countdown>Ends in {formatCountdown(validity.countdown)}</div>
            )}
          </Row>
          <Row label="Can call purchase">{yesNo(s.agent.canPurchase)}</Row>
          <Row label="Merchant allowed">{yesNo(s.agent.merchantAllowed)}</Row>
        </Card>

        <Card title="Limits">
          <Row label="Per purchase (maxPerTx)"><Amt a={s.agent.maxPerTx} /></Row>
          <Row label="Per UTC day (dailyLimit)"><Amt a={s.agent.dailyLimit} /></Row>
          <SpendBar spentToday={s.agent.spentToday} dailyLimit={s.agent.dailyLimit} remaining={s.agent.remainingDailyAllowance} />
        </Card>

        <Card title="Wallet">
          <Row label="Address"><Addr chainId={s.chainId} value={s.addresses.wallet} /></Row>
          <Row label="mUSDC balance"><Amt a={s.wallet.balance} /></Row>
          <Row label="Merchant allowance"><Amt a={s.wallet.merchantAllowance} /></Row>
          <Row label="Credits owned"><span data-field="credits">{s.wallet.credits}</span></Row>
          <Row label="EntryPoint deposit"><Eth wei={s.wallet.entryPointDeposit} /></Row>
          <Row label="Owner"><Addr chainId={s.chainId} value={s.addresses.owner} /></Row>
        </Card>

        <Card title="Merchant">
          <Row label="Price per credit"><Amt a={s.merchant.pricePerCredit} /></Row>
          <Row label="Purchases (all buyers)">{s.merchant.purchaseCount}</Row>
          <Row label="Address"><Addr chainId={s.chainId} value={s.addresses.merchant} /></Row>
        </Card>

        <Card title="Gas payer (backend submitter)">
          <Row label="Address"><Addr chainId={s.chainId} value={s.submitter.address} /></Row>
          <Row label="ETH balance"><Eth wei={s.submitter.ethBalance} /></Row>
        </Card>
      </div>

      <p className="muted footer">
        Chain {s.chainId} · block {s.blockNumber} · next agent nonce {s.agent.nextNonce} · limits are enforced by the contract, not this page.
      </p>
    </section>
  )
}

function Kpi({ label, value, unit, tone }: { label: string; value: string; unit: string; tone: 'cyan' | 'violet' | 'magenta' | 'green' }) {
  return (
    <div className={`kpi ${tone}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      <span className="kpi-unit">{unit}</span>
    </div>
  )
}

function ReadAt({ data, now }: { data: WalletStatus; now: number }) {
  const t = formatTime(data.readAt)
  return (
    <span className="muted" title={t?.utc}>
      Read at {t?.local} ({formatRelative(data.readAt, now)})
    </span>
  )
}

function ValidityBadge({ validity }: { validity: Validity }) {
  switch (validity.kind) {
    case 'valid':
      return <span className="badge green" data-validity="valid">Active and valid now</span>
    case 'revoked':
      return <span className="badge red" data-validity="revoked">Revoked</span>
    case 'not_started':
      return <span className="badge red" data-validity="not_valid">Not valid now (starts in {formatCountdown(validity.startsIn)})</span>
    case 'expired':
      return <span className="badge red" data-validity="not_valid">Not valid now (expired)</span>
    case 'not_valid':
      return <span className="badge red" data-validity="not_valid">Not valid now</span>
  }
}

const yesNo = (v: boolean) => <span className={`badge ${v ? 'green' : 'red'}`}>{v ? 'Yes' : 'No'}</span>

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="card">
      <h3>{title}</h3>
      {children}
    </div>
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

function Amt({ a }: { a: Amount }) {
  return (
    <>
      <strong>{a.mUSDC}</strong> mUSDC <span className="muted base">({a.base})</span>
    </>
  )
}

function Eth({ wei }: { wei: string }) {
  return (
    <>
      {formatWei(wei)} <span className="muted base">({wei} wei)</span>
    </>
  )
}

function Time({ t }: { t: number }) {
  const f = formatTime(t)
  return f ? (
    <span>
      {f.local}
      <div className="muted">{f.utc}</div>
    </span>
  ) : (
    <>—</>
  )
}

function Addr({ chainId, value }: { chainId: number; value: string }) {
  const href = explorerAddressUrl(chainId, value)
  return href ? (
    <a href={href} target="_blank" rel="noreferrer noopener" title={value}><code>{shortAddress(value)}</code></a>
  ) : (
    <code title={value}>{shortAddress(value)}</code>
  )
}
