import { renderToStaticMarkup } from 'react-dom/server'
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, type Hash, type Hex } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import {
  buildOwnerCall, findExpectedEvent, ownerGate, revokeConfirmed, runOwnerTx, validateAllowance, validatePolicy, type OwnerCall, type OwnerTxDeps,
} from '../src/chain/ownerControls'
import type { AgentInfo } from '../src/chain/reads'
import { signingCheck, type WalletState } from '../src/chain/wallet'
import { OwnerControlsPanel, type Current } from '../src/components/owner/OwnerControlsPanel'
import { ABI } from '../src/config'
import { AGENT, BOOK } from './helpers/fixtures'

const OTHER = '0x1111111111111111111111111111111111111111' as const
const TX = `0x${'cd'.repeat(32)}` as Hash
const connected = (over: Partial<Extract<WalletState, { status: 'connected' }>> = {}): WalletState => ({
  status: 'connected', account: BOOK.owner, chainId: 84532, expectedChainId: 84532, owner: { state: 'ok', owner: BOOK.owner }, switching: false, error: null, ...over,
})
const info: AgentInfo = { active: true, validAfter: 1761300000, validUntil: 1761904800, token: BOOK.usdc, maxPerTx: 1_000_000n, dailyLimit: 5_000_000n, spentToday: 100_000n }
const current: Current = { state: 'ok', info, allowance: 9_800_000n, validNow: true }
const run = vi.fn()

const panel = (state: WalletState, blocked: string | null = null) =>
  renderToStaticMarkup(
    <OwnerControlsPanel gate={ownerGate(signingCheck(state), blocked)} deployment={BOOK} agent={AGENT} current={current} run={run} onReload={() => {}} />,
  )
const isDisabled = (html: string, testId: string) => new RegExp(`<button[^>]*data-testid="${testId}"[^>]*disabled=""`).test(html) || new RegExp(`<button[^>]*disabled=""[^>]*data-testid="${testId}"`).test(html)
const ACTIONS = ['review-setPolicy', 'review-allowance', 'review-revokeAgent']

describe('owner controls are disabled unless the owner is connected on the right chain', () => {
  it.each([
    ['a non-owner account', connected({ account: OTHER })],
    ['the wrong chain', connected({ chainId: 1 })],
    ['owner() not read yet', connected({ owner: { state: 'loading' } })],
    ['no wallet', { status: 'no_wallet' } as WalletState],
    ['disconnected', { status: 'disconnected', lastAccount: null, error: null } as WalletState],
  ])('every action is disabled for %s', (_name, state) => {
    const html = panel(state)
    for (const id of ACTIONS) expect(isDisabled(html, id), id).toBe(true)
    expect(html).toContain('data-testid="gate"')
    expect(html).toContain('data-enabled="false"')
    expect(html).not.toContain('data-testid="confirm"')
    expect(run).not.toHaveBeenCalled()
  })

  it('the reason names the problem', () => {
    expect(ownerGate(signingCheck(connected({ account: OTHER })), null).reason).toContain('not the wallet owner')
    expect(ownerGate(signingCheck(connected({ chainId: 1 })), null).reason).toContain('Wrong network')
    expect(ownerGate(signingCheck(connected()), 'the backend and contracts/deployments disagree').enabled).toBe(false)
  })

  it('startup mismatches disable it too, even for the owner', () => {
    const html = panel(connected(), 'the backend and contracts/deployments disagree')
    for (const id of ACTIONS) expect(isDisabled(html, id), id).toBe(true)
  })

  it('for the owner on the right chain setPolicy and allowance are enabled; revoke still needs the typed word', () => {
    const html = panel(connected())
    expect(isDisabled(html, 'review-setPolicy')).toBe(false)
    expect(isDisabled(html, 'review-allowance')).toBe(false)
    expect(isDisabled(html, 'review-revokeAgent')).toBe(true)
    expect(html).toContain('data-enabled="true"')
    expect(html).toContain('ConfigureAgent')
    expect(revokeConfirmed('REVOKE')).toBe(true)
    expect(revokeConfirmed('revoke')).toBe(false)
    expect(revokeConfirmed('')).toBe(false)
  })
})

describe('input checks', () => {
  it('setPolicy limits: parseUnits(x, 6), zero and maxPerTx > dailyLimit refused', () => {
    expect(validatePolicy('0.5', '5')).toEqual({ ok: true, maxPerTx: 500_000n, dailyLimit: 5_000_000n })
    expect(validatePolicy('5', '5')).toMatchObject({ ok: true })
    expect(validatePolicy('0', '5')).toMatchObject({ ok: false })
    expect(validatePolicy('1', '0')).toMatchObject({ ok: false })
    expect(validatePolicy('6', '5')).toMatchObject({ ok: false })
    for (const bad of ['', 'abc', '-1', '1.1234567', '1e3']) expect(validatePolicy(bad, '5')).toMatchObject({ ok: false })
  })

  it('allowance: positive mUSDC only', () => {
    expect(validateAllowance('10')).toEqual({ ok: true, amount: 10_000_000n })
    expect(validateAllowance('0')).toMatchObject({ ok: false })
    expect(validateAllowance('x')).toMatchObject({ ok: false })
  })
})

describe('calls', () => {
  it('setPolicy(agent, deployment mUSDC, maxPerTx, dailyLimit) on the wallet', () => {
    const c = buildOwnerCall({ kind: 'setPolicy', agent: AGENT, maxPerTx: 500_000n, dailyLimit: 5_000_000n }, BOOK)
    expect(c.address).toBe(BOOK.wallet)
    expect(decodeFunctionData({ abi: ABI.wallet, data: c.data })).toMatchObject({ functionName: 'setPolicy', args: [AGENT, BOOK.usdc, 500_000n, 5_000_000n] })
    expect(c.decoded.args.map((a) => [a.name, a.value, a.note])).toEqual([
      ['agent', AGENT, undefined], ['token', BOOK.usdc, 'mUSDC'], ['maxPerTx', '500000', '0.5 mUSDC'], ['dailyLimit', '5000000', '5 mUSDC'],
    ])
    expect(c.expect.eventName).toBe('PolicySet')
  })

  it('revokeAgent(agent)', () => {
    const c = buildOwnerCall({ kind: 'revokeAgent', agent: AGENT }, BOOK)
    expect(decodeFunctionData({ abi: ABI.wallet, data: c.data })).toMatchObject({ functionName: 'revokeAgent', args: [AGENT] })
    expect(c.expect).toMatchObject({ eventName: 'AgentRevoked', emitter: BOOK.wallet })
    expect(() => buildOwnerCall({ kind: 'revokeAgent', agent: '0x0000000000000000000000000000000000000000' }, BOOK)).toThrow()
  })

  it('allowance: execute(usdc, 0, approve(merchant, amount)) like ConfigureAgent, decoded both levels', () => {
    const c = buildOwnerCall({ kind: 'allowance', amount: 10_000_000n }, BOOK)
    const outer = decodeFunctionData({ abi: ABI.wallet, data: c.data })
    expect(outer.functionName).toBe('execute')
    expect(outer.args!.slice(0, 2)).toEqual([BOOK.usdc, 0n])
    expect(decodeFunctionData({ abi: ABI.usdc, data: outer.args![2] as Hex })).toMatchObject({ functionName: 'approve', args: [BOOK.merchant, 10_000_000n] })
    expect(c.decoded.inner).toMatchObject({ contract: 'mUSDC', functionName: 'approve' })
    expect(c.decoded.inner!.args.map((a) => a.note)).toEqual(['merchant', '10 mUSDC'])
    expect(c.expect).toMatchObject({ eventName: 'Approval', emitter: BOOK.usdc })
  })
})

// Logs as a node would return them.
const policyLog = (agent: string, max: bigint, daily: bigint, address: string = BOOK.wallet) => ({
  address,
  topics: encodeEventTopics({ abi: ABI.wallet, eventName: 'PolicySet', args: { agent, token: BOOK.usdc } }) as Hex[],
  data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [max, daily]),
})

function deps(over: { receipt?: 'success' | 'reverted'; logs?: unknown[]; simulateError?: Error } = {}) {
  const simulateContract = vi.fn(async (args: unknown) => {
    if (over.simulateError) throw over.simulateError
    return { request: args }
  })
  const writeContract = vi.fn(async () => TX)
  const waitForTransactionReceipt = vi.fn(async () => ({ status: over.receipt ?? 'success', logs: over.logs ?? [] }))
  const d = { publicClient: { simulateContract, waitForTransactionReceipt }, walletClient: { writeContract }, owner: BOOK.owner } as unknown as OwnerTxDeps
  return { d, simulateContract, writeContract }
}

describe('simulate, send, receipt, event', () => {
  const call: OwnerCall = buildOwnerCall({ kind: 'setPolicy', agent: AGENT, maxPerTx: 500_000n, dailyLimit: 5_000_000n }, BOOK)

  it('simulates from the owner, sends once, and checks the PolicySet event', async () => {
    const { d, simulateContract, writeContract } = deps({ logs: [policyLog(AGENT, 500_000n, 5_000_000n)] })
    const states: string[] = []
    const end = await runOwnerTx(d, call, (s) => states.push(s.phase))
    expect(end).toMatchObject({ phase: 'done', txHash: TX })
    expect((end as { event: string }).event).toContain('maxPerTx=500000')
    expect(states).toEqual(['simulating', 'awaitingWallet', 'mining', 'done'])
    expect(simulateContract.mock.calls[0][0]).toMatchObject({ account: BOOK.owner, address: BOOK.wallet, functionName: 'setPolicy' })
    expect(writeContract).toHaveBeenCalledTimes(1)
  })

  it('a missing, different or foreign event is not success', async () => {
    for (const logs of [[], [policyLog(OTHER, 500_000n, 5_000_000n)], [policyLog(AGENT, 1n, 5_000_000n)], [policyLog(AGENT, 500_000n, 5_000_000n, OTHER)]]) {
      const { d } = deps({ logs })
      expect((await runOwnerTx(d, call, () => {})).phase).toBe('noEvent')
    }
    expect(findExpectedEvent(call, [policyLog(AGENT, 500_000n, 5_000_000n)])).toContain('PolicySet')
  })

  it('a failed simulation opens no wallet; a reverted receipt is reported', async () => {
    const a = deps({ simulateError: new Error('UnauthorizedCaller') })
    expect((await runOwnerTx(a.d, call, () => {})).phase).toBe('simulateFailed')
    expect(a.writeContract).not.toHaveBeenCalled()
    const b = deps({ receipt: 'reverted' })
    expect(await runOwnerTx(b.d, call, () => {})).toMatchObject({ phase: 'reverted', txHash: TX })
  })
})
