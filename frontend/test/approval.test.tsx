import { renderToStaticMarkup } from 'react-dom/server'
import { decodeFunctionData, encodeFunctionData, type Hash, type Hex } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../src/api/client'
import type { OwnerApproval, PurchaseRequest, VerifyResponse } from '../src/api/types'
import {
  checkApproval, checkMaxPrice, compareApproval, explainError, isApprovable, rebuildFromChain, type ApprovalReads, type SendDeps,
} from '../src/chain/approval'
import { ApprovalDetails, MismatchList } from '../src/components/approve/ApprovalDetails'
import { FlowStatus } from '../src/components/approve/FlowStatus'
import { TX_HASH } from '../src/components/approve/ApprovalPanel'
import { ABI } from '../src/config'
import { canRetryVerify, canStartSigning, hasLiveTx, isBusy, runSigning, verifyTx, type FlowState } from '../src/lib/approvalFlow'
import { AGENT, BOOK } from './helpers/fixtures'

const PRICE = 1_500_000n // 150 credits at 0.01 mUSDC
const STANDING = 9_800_000n
const TX = `0x${'ef'.repeat(32)}` as Hash
const OTHER = '0x1111111111111111111111111111111111111111' as const
const amt = (v: bigint) => ({ base: v.toString(), mUSDC: (Number(v) / 1e6).toString() })

const reads = (price = PRICE, standing = STANDING): ApprovalReads => ({
  quote: vi.fn(async (c: number | bigint) => (BigInt(c) * price) / 150n),
  allowance: vi.fn(async () => standing),
})

/** What an honest backend sends: the same rebuild as owner-approve.mjs. */
function honest(credits = 150n, price = PRICE, standing = STANDING): OwnerApproval {
  const approve = encodeFunctionData({ abi: ABI.usdc, functionName: 'approve', args: [BOOK.merchant, standing + price] })
  const purchase = encodeFunctionData({ abi: ABI.merchant, functionName: 'purchase', args: [credits, price] })
  return {
    wallet: BOOK.wallet, function: 'executeBatch', price: amt(price), standingAllowance: amt(standing),
    args: { dest: [BOOK.usdc, BOOK.merchant], value: [], func: [approve, purchase] },
    calls: [
      { to: BOOK.usdc, function: 'approve', args: { spender: BOOK.merchant, value: amt(standing + price) } },
      { to: BOOK.merchant, function: 'purchase', args: { credits: Number(credits), payment: amt(price) } },
    ],
    signWith: 'script/OwnerApprovePurchase.s.sol', readAt: 1761317000,
  }
}

const request = (over: Partial<PurchaseRequest> = {}): PurchaseRequest => ({
  id: 'req_00000000000000aa', status: 'needs_owner_approval', path: null, precheck: 'NEEDS_OWNER', credits: 150, reason: 'user asked',
  price: amt(PRICE), amountPaid: null, purchaseId: null, agent: AGENT, nonce: null, userOpHash: null, txHash: null, blockNumber: null,
  actualGasCost: null, error: null, explorerUrl: null, conversationId: 'default', expiresAt: null, createdAt: 1761317000,
  updatedAt: 1761317000, ownerApproval: honest(), ...over,
})

const verified = (): VerifyResponse => ({
  request: { id: 'req_00000000000000aa', status: 'fulfilled_by_owner', txHash: TX, purchaseId: '9', amountPaid: amt(PRICE) },
  checks: ['request_status', 'tx_unused', 'receipt_success', 'owner_authorized', 'credits_purchased', 'after_request'].map((name) => ({ name, ok: true })) as VerifyResponse['checks'],
})

function sendDeps(over: { receipt?: 'success' | 'reverted'; simulateError?: Error; sendError?: unknown } = {}) {
  const simulateContract = vi.fn(async (args: { args: [string[], unknown[], Hex[]] }) => {
    if (over.simulateError) throw over.simulateError
    return { request: { ...args, kind: 'simulated' } }
  })
  const writeContract = vi.fn(async () => {
    if (over.sendError) throw over.sendError
    return TX
  })
  const waitForTransactionReceipt = vi.fn(async () => ({ status: over.receipt ?? 'success' }))
  const deps = { publicClient: { simulateContract, waitForTransactionReceipt }, walletClient: { writeContract }, owner: BOOK.owner, deployment: BOOK } as unknown as SendDeps
  return { deps, simulateContract, writeContract, waitForTransactionReceipt }
}

function context(req: PurchaseRequest, opts: { maxPrice?: string; verify?: () => Promise<VerifyResponse>; send?: ReturnType<typeof sendDeps> } = {}) {
  const states: FlowState[] = []
  const send = opts.send ?? sendDeps()
  const api = { request: vi.fn(async () => req), verify: vi.fn(opts.verify ?? (async () => verified())) }
  const onDone = vi.fn()
  const ctx = { api, reads: reads(), deployment: BOOK, send: send.deps, requestId: req.id, maxPriceText: opts.maxPrice ?? '1.5', onState: (s: FlowState) => states.push(s), onDone }
  return { ctx, states, send, api, onDone }
}

const fields = async (oa: OwnerApproval, over: Partial<PurchaseRequest> = {}) => {
  const check = await checkApproval(reads(), BOOK, request({ ownerApproval: oa, ...over }))
  return check.ok ? [] : check.mismatches.map((m) => m.field)
}

describe('rebuild from chain', () => {
  it('encodes approve(merchant, standing + price) and purchase(credits, price) like owner-approve.mjs', async () => {
    const r = await rebuildFromChain(reads(), BOOK, 150)
    expect(r.price).toBe(PRICE)
    expect(r.standing).toBe(STANDING)
    expect(r.dest).toEqual([BOOK.usdc, BOOK.merchant])
    expect(decodeFunctionData({ abi: ABI.usdc, data: r.func[0] })).toMatchObject({ functionName: 'approve', args: [BOOK.merchant, STANDING + PRICE] })
    expect(decodeFunctionData({ abi: ABI.merchant, data: r.func[1] })).toMatchObject({ functionName: 'purchase', args: [150n, PRICE] })
    expect(r.calls.map((c) => [c.contract, c.functionName])).toEqual([['mUSDC', 'approve'], ['merchant', 'purchase']])
    expect(r.calls[0].args).toEqual([{ name: 'spender', value: BOOK.merchant }, { name: 'value', value: '11300000' }])
  })

  it('rejects silly credits before reading the chain', async () => {
    await expect(rebuildFromChain(reads(), BOOK, 0)).rejects.toThrow()
    await expect(rebuildFromChain(reads(), BOOK, 1.5)).rejects.toThrow()
  })
})

describe('a tampered ownerApproval is refused', () => {
  it('an honest ownerApproval passes, also with checksum case differences', async () => {
    expect(await fields(honest())).toEqual([])
    const oa = honest()
    oa.wallet = oa.wallet.toLowerCase() as typeof oa.wallet
    expect(await fields(oa)).toEqual([])
  })

  it('other merchant', async () => {
    const oa = honest()
    oa.args.dest[1] = OTHER
    oa.args.func[0] = encodeFunctionData({ abi: ABI.usdc, functionName: 'approve', args: [OTHER, STANDING + PRICE] })
    oa.calls[0].args.spender = OTHER
    oa.calls[1].to = OTHER
    expect(await fields(oa)).toEqual(expect.arrayContaining(['args.dest[1] (merchant)', 'args.func[0] approve calldata', 'calls[0].spender', 'calls[1].to']))
  })

  it('other credits (calldata buys 500, request says 150)', async () => {
    const oa = honest()
    oa.args.func[1] = encodeFunctionData({ abi: ABI.merchant, functionName: 'purchase', args: [500n, PRICE] })
    oa.calls[1].args.credits = 500
    expect(await fields(oa)).toEqual(['args.func[1] purchase calldata', 'calls[1].credits'])
  })

  it('other price (backend approves more than the quote)', async () => {
    expect(await fields(honest(150n, 5_000_000n))).toEqual(
      expect.arrayContaining(['args.func[0] approve calldata', 'args.func[1] purchase calldata', 'price', 'calls[0].value', 'calls[1].payment']),
    )
  })

  it('extra call', async () => {
    const oa = honest()
    const drain = encodeFunctionData({ abi: ABI.usdc, functionName: 'transfer', args: [OTHER, 1_000_000n] })
    ;(oa.args.dest as string[]).push(BOOK.usdc)
    ;(oa.args.func as string[]).push(drain)
    expect(await fields(oa)).toEqual(['args.dest length', 'args.func length'])
  })

  it('other wallet, non-empty value, other function, stale standing allowance', async () => {
    const oa = honest()
    oa.wallet = OTHER
    ;(oa.args as { value: unknown }).value = ['1']
    ;(oa as { function: string }).function = 'execute'
    expect(await fields(oa)).toEqual(['wallet', 'function', 'args.value'])
    expect(await fields(honest(150n, PRICE, 1n))).toEqual(expect.arrayContaining(['args.func[0] approve calldata', 'standingAllowance']))
  })

  it('missing args never throw, they are mismatches', async () => {
    const oa = { wallet: BOOK.wallet, function: 'executeBatch' } as unknown as OwnerApproval
    const r = await rebuildFromChain(reads(), BOOK, 150)
    expect(compareApproval(oa, { credits: 150 }, BOOK, r).length).toBeGreaterThan(5)
  })

  it.each([
    ['other merchant', (oa: OwnerApproval) => { oa.args.dest[1] = OTHER }],
    ['other credits', (oa: OwnerApproval) => { oa.args.func[1] = encodeFunctionData({ abi: ABI.merchant, functionName: 'purchase', args: [151n, PRICE] }) }],
    ['other price', (oa: OwnerApproval) => { oa.price = amt(PRICE + 1n) }],
    ['extra call', (oa: OwnerApproval) => { (oa.args.func as string[]).push('0x') }],
  ])('runSigning with %s never simulates and never opens the wallet', async (_name, tamper) => {
    const oa = honest()
    tamper(oa)
    const { ctx, states, send, api } = context(request({ ownerApproval: oa }))
    const end = await runSigning(ctx)
    expect(end.phase).toBe('mismatch')
    expect(states.map((s) => s.phase)).toEqual(['checking', 'mismatch'])
    expect(send.simulateContract).not.toHaveBeenCalled()
    expect(send.writeContract).not.toHaveBeenCalled()
    expect(api.verify).not.toHaveBeenCalled()
  })

  it('the mismatch banner names the field and says nothing was signed', () => {
    const out = renderToStaticMarkup(<MismatchList mismatches={[{ field: 'args.dest[1] (merchant)', backend: OTHER, chain: BOOK.merchant }]} />)
    expect(out).toContain('args.dest[1] (merchant)')
    expect(out).toContain(OTHER)
    expect(out).toContain('No wallet prompt was opened')
  })
})

describe('max price', () => {
  it('price above max is refused, equal or above passes, bad text is refused', () => {
    expect(checkMaxPrice(PRICE, '1.49')).toMatchObject({ ok: false })
    expect((checkMaxPrice(PRICE, '1.49') as { reason: string }).reason).toContain('above your max price')
    expect(checkMaxPrice(PRICE, '1.5')).toEqual({ ok: true, max: PRICE })
    expect(checkMaxPrice(PRICE, '2')).toMatchObject({ ok: true })
    for (const bad of ['', 'abc', '-1', '1.1234567', '1e3']) expect(checkMaxPrice(PRICE, bad)).toMatchObject({ ok: false })
  })

  it('runSigning with price > maxPrice stops before simulation', async () => {
    const { ctx, send } = context(request(), { maxPrice: '1' })
    const end = await runSigning(ctx)
    expect(end).toMatchObject({ phase: 'refused' })
    expect(send.simulateContract).not.toHaveBeenCalled()
    expect(send.writeContract).not.toHaveBeenCalled()
  })
})

describe('signing sequence', () => {
  it('the honest path: simulate executeBatch(dest, [], func) from the owner, send once, wait, verify', async () => {
    const { ctx, states, send, api, onDone } = context(request())
    const end = await runSigning(ctx)
    expect(end).toMatchObject({ phase: 'verified', txHash: TX })
    expect(states.map((s) => s.phase)).toEqual(['checking', 'simulating', 'awaitingWallet', 'mining', 'verifying', 'verified'])
    const sim = send.simulateContract.mock.calls[0][0] as unknown as { account: string; address: string; functionName: string; args: [string[], unknown[], Hex[]] }
    expect(sim).toMatchObject({ account: BOOK.owner, address: BOOK.wallet, functionName: 'executeBatch' })
    expect(sim.args[0]).toEqual([BOOK.usdc, BOOK.merchant])
    expect(sim.args[1]).toEqual([])
    expect(sim.args[2]).toEqual(honest().args.func)
    expect(send.writeContract).toHaveBeenCalledTimes(1)
    expect(api.verify).toHaveBeenCalledWith('req_00000000000000aa', TX)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('a request that is no longer approvable is refused before any chain work', async () => {
    for (const r of [request({ status: 'fulfilled_by_owner' }), request({ status: 'rejected' }), request({ ownerApproval: undefined })]) {
      const { ctx, send } = context(r)
      expect((await runSigning(ctx)).phase).toBe('refused')
      expect(send.simulateContract).not.toHaveBeenCalled()
    }
    expect(isApprovable(request({ status: 'expired' }))).toBe(true)
    expect(isApprovable(request({ status: 'received' }))).toBe(false)
  })

  it('a 502 RPC_ERROR on the reload is shown and nothing is signed', async () => {
    const { ctx, send } = context(request())
    ctx.api.request = vi.fn(async () => { throw new ApiError('RPC_ERROR', 502, 'upstream timeout') })
    const end = await runSigning(ctx)
    expect(end.phase).toBe('refused')
    expect((end as { reason: string }).reason).toContain('could not read the chain')
    expect(send.writeContract).not.toHaveBeenCalled()
  })

  it('a failed simulation sends nothing; a wallet rejection says nothing was sent', async () => {
    const a = context(request(), { send: sendDeps({ simulateError: new Error('IncorrectPayment()') }) })
    expect(await runSigning(a.ctx)).toMatchObject({ phase: 'simulateFailed' })
    expect(a.send.writeContract).not.toHaveBeenCalled()
    const b = context(request(), { send: sendDeps({ sendError: Object.assign(new Error('User rejected'), { code: 4001 }) }) })
    const end = await runSigning(b.ctx)
    expect(end).toMatchObject({ phase: 'sendFailed' })
    expect((end as { reason: string }).reason).toContain('Nothing was sent')
    expect(explainError({ code: 4001 })).toContain('rejected')
  })

  it('a reverted receipt is not verified and allows signing again', async () => {
    const { ctx, api } = context(request(), { send: sendDeps({ receipt: 'reverted' }) })
    const end = await runSigning(ctx)
    expect(end).toMatchObject({ phase: 'reverted', txHash: TX })
    expect(api.verify).not.toHaveBeenCalled()
    expect(canStartSigning(end)).toBe(true)
  })
})

describe('verify failure keeps the tx hash and allows retry', () => {
  const failing = () => Promise.reject(new ApiError('TX_NOT_FOUND', 404, 'not mined yet', { checks: [{ name: 'receipt_success', ok: false, detail: 'no receipt' }] }))

  it('keeps the hash, shows the code and checks, blocks a second signature, and a retry can succeed', async () => {
    const { ctx, send, api, onDone } = context(request(), { verify: failing })
    const end = await runSigning(ctx)
    expect(end).toMatchObject({ phase: 'verifyFailed', txHash: TX, code: 'TX_NOT_FOUND', serverMessage: 'not mined yet' })
    expect((end as { checks: unknown[] }).checks).toEqual([{ name: 'receipt_success', ok: false, detail: 'no receipt' }])
    expect(canRetryVerify(end)).toBe(true)
    expect(canStartSigning(end)).toBe(false)
    expect(hasLiveTx(end)).toBe(true)
    expect(onDone).not.toHaveBeenCalled()

    const out = renderToStaticMarkup(<FlowStatus flow={end} chainId={84532} onRetryVerify={() => {}} />)
    expect(out).toContain(TX)
    expect(out).toContain('TX_NOT_FOUND')
    expect(out).toContain('receipt_success')
    expect(out).toContain('Retry verify')
    expect(out).toContain('Do not sign again')
    expect(out).toContain(`https://sepolia.basescan.org/tx/${TX}`)

    api.verify.mockImplementation(async () => verified())
    const states: FlowState[] = []
    const again = await verifyTx({ ...ctx, onState: (s) => states.push(s) }, TX, 2)
    expect(states[0]).toEqual({ phase: 'verifying', txHash: TX, attempt: 2 })
    expect(again).toMatchObject({ phase: 'verified', txHash: TX })
    expect(send.writeContract).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledTimes(1)
    const ok = renderToStaticMarkup(<FlowStatus flow={again} chainId={84532} onRetryVerify={() => {}} />)
    expect(ok).toContain('fulfilled_by_owner')
    expect(ok.match(/✓/g)).toHaveLength(6)
  })

  it('an unreadable receipt goes to verifyFailed (retry verify), never back to signing', async () => {
    const send = sendDeps()
    send.waitForTransactionReceipt.mockImplementation(async () => { throw new Error('timeout') })
    const { ctx } = context(request(), { send })
    const end = await runSigning(ctx)
    expect(end).toMatchObject({ phase: 'verifyFailed', code: 'RECEIPT_UNKNOWN', txHash: TX })
    expect(canStartSigning(end)).toBe(false)
  })

  it('no explorer link on Anvil', () => {
    const out = renderToStaticMarkup(<FlowStatus flow={{ phase: 'mining', txHash: TX }} chainId={31337} onRetryVerify={() => {}} />)
    expect(out).toContain(TX)
    expect(out).not.toContain('basescan')
  })
})

describe('never sign twice', () => {
  it('busy and live-tx phases block signing', () => {
    const blocked: FlowState[] = [
      { phase: 'checking' }, { phase: 'simulating' }, { phase: 'awaitingWallet' }, { phase: 'mining', txHash: TX },
      { phase: 'verifying', txHash: TX, attempt: 1 }, { phase: 'verified', txHash: TX, result: verified() },
      { phase: 'verifyFailed', txHash: TX, code: 'X', message: '', serverMessage: null, checks: [] },
    ]
    for (const s of blocked) expect(canStartSigning(s), s.phase).toBe(false)
    for (const s of [{ phase: 'idle' }, { phase: 'refused', reason: '' }, { phase: 'sendFailed', reason: '' }, { phase: 'simulateFailed', reason: '' }] as FlowState[]) {
      expect(canStartSigning(s), s.phase).toBe(true)
    }
    expect(isBusy({ phase: 'awaitingWallet' })).toBe(true)
  })

  it('tx hash fallback accepts only 0x + 64 hex', () => {
    expect(TX_HASH.test(TX)).toBe(true)
    expect(TX_HASH.test(TX.slice(0, 65))).toBe(false)
    expect(TX_HASH.test(`${TX} `.trim() + 'a')).toBe(false)
    expect(TX_HASH.test('0x' + 'g'.repeat(64))).toBe(false)
  })
})

describe('decoded view', () => {
  it('shows calls, price, standing allowance and credits from the rebuild', async () => {
    const r = await rebuildFromChain(reads(), BOOK, 150)
    const out = renderToStaticMarkup(<ApprovalDetails rebuilt={r} wallet={BOOK.wallet} />)
    expect(out).toContain('approve')
    expect(out).toContain('purchase')
    expect(out).toContain(BOOK.merchant)
    expect(out).toContain('1.5 mUSDC')
    expect(out).toContain('9.8 mUSDC')
    expect(out).toContain('unchanged afterwards')
    expect(out).toContain('11.3 mUSDC')
    expect(out).toContain('spentToday')
  })
})
