import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../src/api/client'
import type { WalletStatus } from '../src/api/types'
import { DashboardView } from '../src/components/dashboard/DashboardView'
import { WarningBanners } from '../src/components/dashboard/WarningBanners'
import { WARNING_TEXT } from '../src/lib/messages'
import { toFailure, type DashboardMode } from '../src/lib/walletStatus'
import { walletStatus } from './helpers/fixtures'

const render = (mode: DashboardMode, { now = 1761317005, fetchedAt = 1761317000 } = {}) =>
  renderToStaticMarkup(<DashboardView mode={mode} now={now} fetchedAt={fetchedAt} loading={false} onRefresh={() => {}} />)
const count = (html: string, needle: string) => html.split(needle).length - 1

describe('warning banners', () => {
  it('renders one banner per warning, each with its fix', () => {
    const all = Object.keys(WARNING_TEXT)
    const html = renderToStaticMarkup(<WarningBanners warnings={all} />)
    expect(count(html, 'data-warning=')).toBe(all.length)
    for (const [code, w] of Object.entries(WARNING_TEXT)) {
      expect(html).toContain(`data-warning="${code}"`)
      expect(html).toContain(w.fix.replaceAll("'", '&#x27;'))
    }
    expect(html).toContain('The owner must top up the EntryPoint deposit: rerun ConfigureAgent.')
  })

  it('renders nothing without warnings, and an unknown warning as grey text', () => {
    expect(renderToStaticMarkup(<WarningBanners warnings={[]} />)).toBe('')
    const html = renderToStaticMarkup(<WarningBanners warnings={['NEW_ONE']} />)
    expect(html).toContain('banner grey')
    expect(html).toContain('Backend warning NEW_ONE')
  })

  it('renders backend text as text, not HTML', () => {
    const html = renderToStaticMarkup(<WarningBanners warnings={['<img src=x onerror=alert(1)>']} />)
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })
})

describe('dashboard view', () => {
  it('shows the fields from /wallet/status, amounts as given and wei as ETH', () => {
    const html = render({ kind: 'current', data: walletStatus() })
    for (const text of ['99.8', '9.8', '0.01', '0.1</strong> of 5 mUSDC', '4.9 mUSDC', '0.00499 ETH', '0.02 ETH', 'data-field="credits">20', 'Active and valid now', 'aria-valuenow="2"']) {
      expect(html, text).toContain(text)
    }
    expect(html).toContain('data-warning="DEPOSIT_LOW"')
    expect(html).not.toContain('Stale since')
  })

  it('greys out the last values with "stale since" on RPC_ERROR, never as current', () => {
    const failure = toFailure(new ApiError('RPC_ERROR', 502, 'Chain read failed'), 1761317020)
    const html = render({ kind: 'stale', data: walletStatus(), since: 1761317000, failure, offline: false })
    expect(html).toContain('class="dashboard stale"')
    expect(html).toContain('data-state="stale"')
    expect(html).toContain('Stale since')
    expect(html).toContain('The backend could not read the chain.')
    expect(html).toContain('not the current ones')
  })

  it('shows a clear offline state when the backend never answered', () => {
    const html = render({ kind: 'offline', failure: toFailure(new ApiError('NETWORK', 0), 1) })
    expect(html).toContain('Backend offline.')
    expect(html).toContain('Backend not reachable')
    expect(html).not.toContain('class="cards"')
  })

  it('shows the countdown under 24 h, and revoked / not valid states', () => {
    const data = walletStatus()
    const soon = render({ kind: 'current', data: { ...data, readAt: data.agent.validUntil - 7200 } }, { now: 100, fetchedAt: 100 })
    expect(soon).toContain('Ends in 2 h 00 min 00 s')
    const revoked: WalletStatus = { ...data, agent: { ...data.agent, active: false, validNow: false } }
    expect(render({ kind: 'current', data: revoked })).toContain('data-validity="revoked"')
    const expired: WalletStatus = { ...data, readAt: data.agent.validUntil + 60, agent: { ...data.agent, validNow: false } }
    expect(render({ kind: 'current', data: expired }, { now: 1, fetchedAt: 1 })).toContain('Not valid now (expired)')
  })
})
