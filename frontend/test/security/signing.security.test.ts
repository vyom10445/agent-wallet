// Security suite, signing (P3 plan Phase 11, items 1, 2, 3, 6, 7): real API client over a mocked backend, real chain
// reads over a fake RPC, real owner wallet store over a mocked EIP-1193 provider. "No wallet prompt" is proven by the
// provider never receiving eth_sendTransaction (the only signing request the app makes).
import { decodeFunctionData, encodeFunctionData, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import type { OwnerApproval } from '../../src/api/types'
import { buildOwnerCall, runOwnerTx } from '../../src/chain/ownerControls'
import { flowGuard, FORBIDDEN_METHODS } from '../../src/chain/wallet'
import { ABI } from '../../src/config'
import { canStartSigning, runSigning, verifyTx, type FlowState } from '../../src/lib/approvalFlow'
import { singleFlight } from '../../src/lib/singleFlight'
import { AGENT, BOOK } from '../helpers/fixtures'
import { OTHER, PRICE, REQ, STANDING, honestApproval, request, setup } from './setup'

type Env = Awaited<ReturnType<typeof setup>>

function sign(env: Env, opts: { maxPrice?: string; blocked?: () => string | null } = {}) {
  const states: FlowState[] = []
  const walletClient = env.wallet.walletClient()
  if (!walletClient) throw new Error('wallet client not available')
  const state = env.wallet.getState()
  if (state.status !== 'connected') throw new Error('not connected')
  const run = runSigning({
    api: env.api, reads: env.reads, deployment: BOOK, requestId: REQ, maxPriceText: opts.maxPrice ?? '1.5',
    onState: (s) => states.push(s),
    guard: flowGuard(env.wallet, opts.blocked),
    send: { publicClient: env.reads.client, walletClient, owner: state.account, deployment: BOOK },
  })
  return { run, states }
}

const tampered: [string, (oa: OwnerApproval) => void, string][] = [
  ['a different merchant', (oa) => { oa.args.dest[1] = OTHER; oa.calls[1].to = OTHER }, 'args.dest[1] (merchant)'],
  ['a different token', (oa) => { oa.args.dest[0] = OTHER; oa.calls[0].to = OTHER }, 'args.dest[0] (mUSDC)'],
  ['a different spender', (oa) => {
    oa.args.func[0] = encodeFunctionData({ abi: ABI.usdc, functionName: 'approve', args: [OTHER, STANDING + PRICE] })
    oa.calls[0].args.spender = OTHER
  }, 'args.func[0] approve calldata'],
  ['a bigger approve amount', (oa) => {
    oa.args.func[0] = encodeFunctionData({ abi: ABI.usdc, functionName: 'approve', args: [BOOK.merchant, 2n ** 256n - 1n] })
  }, 'args.func[0] approve calldata'],
  ['different credits', (oa) => {
    oa.args.func[1] = encodeFunctionData({ abi: ABI.merchant, functionName: 'purchase', args: [5000n, PRICE] })
  }, 'args.func[1] purchase calldata'],
  ['a different price', (oa) => {
    oa.args.func[1] = encodeFunctionData({ abi: ABI.merchant, functionName: 'purchase', args: [150n, PRICE * 3n] })
    oa.price = { base: String(PRICE * 3n), mUSDC: '4.5' }
  }, 'price'],
  ['an extra call', (oa) => {
    ;(oa.args.dest as string[]).push(BOOK.usdc)
    ;(oa.args.func as string[]).push(encodeFunctionData({ abi: ABI.usdc, functionName: 'transfer', args: [OTHER, 99_000_000n] }))
  }, 'args.func length'],
  ['a different wallet', (oa) => { oa.wallet = OTHER }, 'wallet'],
  ['ETH value on a call', (oa) => { (oa.args as { value: unknown }).value = ['1000000000000000000'] }, 'args.value'],
]

describe('1. calldata tampering is refused and opens no wallet prompt', () => {
  it('control: the honest ownerApproval signs exactly what the UI rebuilt, to the AgentWallet, value 0', async () => {
    const env = await setup()
    const { run } = sign(env)
    expect(await run).toMatchObject({ phase: 'verified' })
    expect(env.eth.state.sent).toHaveLength(1)
    const tx = env.eth.state.sent[0] as { to: string; data: Hex; value?: string; from: string }
    expect(tx.to.toLowerCase()).toBe(BOOK.wallet.toLowerCase())
    expect(tx.from.toLowerCase()).toBe(BOOK.owner.toLowerCase())
    expect(BigInt(tx.value ?? '0x0')).toBe(0n)
    const d = decodeFunctionData({ abi: ABI.wallet, data: tx.data })
    expect(d.functionName).toBe('executeBatch')
    expect(d.args).toEqual([[BOOK.usdc, BOOK.merchant], [], honestApproval().args.func])
    // The only methods the app sent to the wallet: account, chain, the one transaction. Never a signing method.
    const methods = env.eth.calls.map((c) => c.method)
    expect(methods.filter((m) => FORBIDDEN_METHODS.has(m))).toEqual([])
    expect(new Set(methods)).toEqual(new Set(['eth_requestAccounts', 'eth_chainId', 'eth_sendTransaction']))
  })

  it.each(tampered)('%s', async (_name, tamper, field) => {
    const oa = honestApproval()
    tamper(oa)
    const env = await setup({ req: request({ ownerApproval: oa }) })
    const end = await sign(env).run
    expect(end.phase).toBe('mismatch')
    expect((end as Extract<FlowState, { phase: 'mismatch' }>).mismatches.map((m) => m.field)).toContain(field)
    expect(env.eth.state.sent).toEqual([])
    expect(env.chain.calls).not.toContain('executeBatch') // not even simulated
  })
})

describe('2. max price', () => {
  it('a quote above the owner max price is refused before simulation and wallet', async () => {
    const env = await setup()
    expect(await sign(env, { maxPrice: '1.499999' }).run).toMatchObject({ phase: 'refused' })
    expect(env.eth.state.sent).toEqual([])
    expect(env.chain.calls).not.toContain('executeBatch')
  })

  it('the price is re-read at signing time: a quote that rose after the preview is refused by the same max', async () => {
    // The preview showed 1.5; by the time the owner clicks, the merchant asks 2.0 and the backend sends the matching approval.
    const env = await setup({ req: request({ ownerApproval: honestApproval(150n, 2_000_000n) }) })
    env.chain.price = 2_000_000n
    expect(await sign(env, { maxPrice: '1.5' }).run).toMatchObject({ phase: 'refused' })
    expect(env.eth.state.sent).toEqual([])
  })
})

describe('3. wrong chain and wrong account', () => {
  it('a non-owner account or the wrong chain gets no wallet client at all', async () => {
    const other = await setup({ accounts: [OTHER] })
    expect(other.wallet.walletClient()).toBeNull()
    const wrong = await setup({ chainId: 1 })
    expect(wrong.wallet.walletClient()).toBeNull()
  })

  it.each([
    ['the account', (env: Env) => env.eth.switchAccount([OTHER])],
    ['the network', (env: Env) => env.eth.switchNetwork(1)],
    ['the account to another owner-looking address', (env: Env) => env.eth.switchAccount(['0x2222222222222222222222222222222222222222'])],
  ])('switching %s mid-flow cancels before the wallet prompt', async (_name, change) => {
    const env = await setup()
    let release!: () => void
    env.chain.pauseSimulate = new Promise((r) => (release = r))
    const { run, states } = sign(env)
    await new Promise((r) => setTimeout(r, 20)) // the flow is now simulating
    expect(states.at(-1)?.phase).toBe('simulating')
    change(env)
    release()
    const end = await run
    expect(end.phase).toBe('cancelled')
    expect(env.eth.state.sent).toEqual([])
  })

  it('startup checks failing mid-flow cancels too', async () => {
    const env = await setup()
    let blocked: string | null = null
    let release!: () => void
    env.chain.pauseSimulate = new Promise((r) => (release = r))
    const { run } = sign(env, { blocked: () => blocked })
    await new Promise((r) => setTimeout(r, 20))
    blocked = 'the backend and contracts/deployments disagree'
    release()
    expect(await run).toMatchObject({ phase: 'cancelled' })
    expect(env.eth.state.sent).toEqual([])
  })

  it('owner controls: switching mid-flow cancels before the wallet prompt', async () => {
    const env = await setup()
    const walletClient = env.wallet.walletClient()!
    const guard = flowGuard(env.wallet)
    env.eth.switchNetwork(1)
    const end = await runOwnerTx({ publicClient: env.reads.client, walletClient, owner: BOOK.owner, guard }, buildOwnerCall({ kind: 'revokeAgent', agent: AGENT }, BOOK), () => {})
    expect(end).toMatchObject({ phase: 'cancelled' })
    expect(env.eth.state.sent).toEqual([])
  })
})

describe('6. double actions', () => {
  it('double-clicking sign sends once', async () => {
    const env = await setup()
    const flight = singleFlight()
    const click = () => flight.run(() => sign(env).run)
    const [a, b] = await Promise.all([click(), click()])
    expect(a).toMatchObject({ phase: 'verified' })
    expect(b).toBeUndefined()
    expect(env.eth.state.sent).toHaveLength(1)
    expect(env.backend.calls.filter((c) => c.url.endsWith('/verify'))).toHaveLength(1)
  })

  it('double-clicking retry verify sends one verify', async () => {
    const env = await setup()
    const flight = singleFlight()
    const ctx = { api: env.api, requestId: REQ, onState: () => {} }
    const tx = `0x${'ab'.repeat(32)}` as const
    await Promise.all([flight.run(() => verifyTx(ctx, tx, 2)), flight.run(() => verifyTx(ctx, tx, 2))])
    expect(env.backend.calls.filter((c) => c.url.endsWith('/verify'))).toHaveLength(1)
  })

  it('after a transaction exists, signing again is not allowed (only verify)', () => {
    const tx = `0x${'ab'.repeat(32)}` as const
    for (const s of [{ phase: 'mining', txHash: tx }, { phase: 'verifyFailed', txHash: tx, code: 'X', message: '', serverMessage: null, checks: [] }] as FlowState[]) {
      expect(canStartSigning(s)).toBe(false)
    }
  })
})

describe('7. backend or RPC down: nothing stale is signed', () => {
  it('GET /requests/:id 502 RPC_ERROR: refused, no wallet prompt', async () => {
    const env = await setup({ requestRoute: [502, { error: { code: 'RPC_ERROR', message: 'Chain read failed' } }] })
    const end = await sign(env).run
    expect(end).toMatchObject({ phase: 'refused' })
    expect((end as { reason: string }).reason).toContain('could not read the chain')
    expect(env.eth.state.sent).toEqual([])
  })

  it('backend unreachable: refused with the NETWORK text', async () => {
    const env = await setup({ requestRoute: undefined })
    const { createApiClient } = await import('../../src/api/client')
    const down = createApiClient({ baseUrl: 'http://127.0.0.1:8787', fetch: (async () => { throw new TypeError('Failed to fetch') }) as typeof fetch })
    const walletClient = env.wallet.walletClient()!
    const end = await runSigning({ api: down, reads: env.reads, deployment: BOOK, requestId: REQ, maxPriceText: '1.5', onState: () => {},
      send: { publicClient: env.reads.client, walletClient, owner: BOOK.owner, deployment: BOOK } })
    expect(end).toMatchObject({ phase: 'refused' })
    expect((end as { reason: string }).reason).toContain('Backend not reachable')
    expect(env.eth.state.sent).toEqual([])
  })

  it('public RPC down: the rebuild fails, refused, the backend copy is never signed instead', async () => {
    const env = await setup()
    env.chain.rpcDown = true
    expect(await sign(env).run).toMatchObject({ phase: 'refused' })
    expect(env.eth.state.sent).toEqual([])
  })

  it('every run re-reads the request and the chain (no cached calldata)', async () => {
    const env = await setup()
    await sign(env).run
    await sign(env).run
    expect(env.backend.calls.filter((c) => c.url.endsWith(`/requests/${REQ}`))).toHaveLength(2)
    expect(env.chain.calls.filter((c) => c === 'quote')).toHaveLength(2)
  })
})
