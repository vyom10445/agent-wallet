import { describe, expect, it } from 'vitest'
import { ApiError } from '../src/api/client'
import {
  agentValidity, dashboardMode, formatCountdown, initialWalletStatusState, walletStatusReducer, type WalletStatusState,
} from '../src/lib/walletStatus'
import { walletStatus } from './helpers/fixtures'

const run = (...actions: Parameters<typeof walletStatusReducer>[1][]) =>
  actions.reduce<WalletStatusState>(walletStatusReducer, initialWalletStatusState)

describe('stale state', () => {
  it('is loading before the first read and current after a good one', () => {
    expect(dashboardMode(initialWalletStatusState).kind).toBe('loading')
    const s = run({ type: 'start' }, { type: 'success', data: walletStatus(), at: 1000 })
    expect(dashboardMode(s)).toEqual({ kind: 'current', data: walletStatus() })
    expect(s.loading).toBe(false)
  })

  it('keeps the last values but marks them stale on 502 RPC_ERROR, since the last good read', () => {
    const s = run(
      { type: 'success', data: walletStatus(), at: 1000 },
      { type: 'start' },
      { type: 'failure', error: new ApiError('RPC_ERROR', 502, 'Chain read failed'), at: 1015 },
    )
    const mode = dashboardMode(s)
    expect(mode.kind).toBe('stale')
    if (mode.kind !== 'stale') return
    expect(mode.data).toEqual(walletStatus())
    expect(mode.since).toBe(1000)
    expect(mode.failure.code).toBe('RPC_ERROR')
    expect(mode.offline).toBe(false)
  })

  it('stays stale since the last good read across repeated failures, and recovers on success', () => {
    const fail = (at: number) => ({ type: 'failure' as const, error: new ApiError('RPC_ERROR', 502), at })
    const stale = run({ type: 'success', data: walletStatus(), at: 1000 }, fail(1015), fail(1030))
    expect(dashboardMode(stale)).toMatchObject({ kind: 'stale', since: 1000 })
    const back = walletStatusReducer(stale, { type: 'success', data: walletStatus(), at: 1045 })
    expect(dashboardMode(back).kind).toBe('current')
    expect(back.failure).toBeNull()
  })

  it('marks a stopped backend as offline (stale with data, offline without)', () => {
    const down = { type: 'failure' as const, error: new ApiError('NETWORK', 0), at: 1015 }
    expect(dashboardMode(run({ type: 'success', data: walletStatus(), at: 1000 }, down))).toMatchObject({ kind: 'stale', offline: true })
    expect(dashboardMode(run(down)).kind).toBe('offline')
    expect(dashboardMode(run({ type: 'failure', error: new ApiError('INTERNAL', 500), at: 1 })).kind).toBe('error')
  })

  it('turns non-API errors into a failure too', () => {
    const s = run({ type: 'failure', error: new Error('boom'), at: 5 })
    expect(s.failure).toMatchObject({ code: 'UNKNOWN', message: 'boom' })
  })
})

describe('agent validity', () => {
  const agent = walletStatus().agent // validAfter 1761300000, validUntil 1761904800
  it('is valid with no countdown when more than 24 h are left', () => {
    expect(agentValidity(agent, agent.validUntil - 86_400)).toEqual({ kind: 'valid', countdown: null })
  })
  it('counts down under 24 h', () => {
    expect(agentValidity(agent, agent.validUntil - 3_600)).toEqual({ kind: 'valid', countdown: 3_600 })
    expect(formatCountdown(3_725)).toBe('1 h 02 min 05 s')
  })
  it('shows revoked, not started and expired from the contract flags', () => {
    expect(agentValidity({ ...agent, active: false, validNow: false }, agent.validUntil - 10).kind).toBe('revoked')
    expect(agentValidity({ ...agent, validNow: false }, agent.validAfter - 60)).toEqual({ kind: 'not_started', startsIn: 60 })
    expect(agentValidity({ ...agent, validNow: false }, agent.validUntil + 5)).toEqual({ kind: 'expired', ago: 5 })
    expect(agentValidity({ ...agent, validNow: false }, agent.validUntil - 5).kind).toBe('not_valid')
  })
  it('trusts validNow from the contract over the clock', () => {
    // Even if the browser clock says expired, validNow: true means valid (the clock may be off).
    expect(agentValidity(agent, agent.validUntil + 100).kind).toBe('valid')
  })
})
