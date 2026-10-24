import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { WalletConnectView } from '../src/components/wallet/WalletConnect'
import {
  FORBIDDEN_METHODS, ForbiddenMethodError, LAST_ACCOUNT_KEY, createOwnerWallet, guardProvider, signingCheck, type WalletState,
} from '../src/chain/wallet'
import { mockProvider } from './helpers/eip1193'

const OWNER = '0x815d211D2E85E2C2526f0CC3bB1DEE11513C7b64'
const OTHER = '0x1111111111111111111111111111111111111111'

function memoryStorage() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), map: m }
}

function setup(opts: Parameters<typeof mockProvider>[0] = {}, readOwner = vi.fn(async () => OWNER as `0x${string}`)) {
  const mock = mockProvider(opts)
  const storage = memoryStorage()
  const wallet = createOwnerWallet({ provider: mock.provider, expectedChainId: 84532, readOwner, storage })
  const check = () => signingCheck(wallet.getState())
  return { mock, storage, wallet, check, readOwner }
}

describe('connecting', () => {
  it('shows a clear message when there is no injected wallet', () => {
    const wallet = createOwnerWallet({ provider: null, expectedChainId: 84532, readOwner: async () => OWNER })
    expect(wallet.getState().status).toBe('no_wallet')
    expect(signingCheck(wallet.getState())).toMatchObject({ canSign: false, reason: expect.stringContaining('No browser wallet found') })
  })

  it('asks for accounts only when connect() is called (a click), then shows owner connected', async () => {
    const { mock, wallet, check } = setup()
    expect(mock.calls).toEqual([]) // creating the store sends nothing
    expect(wallet.getState().status).toBe('disconnected')
    await wallet.connect()
    expect(mock.calls.map((c) => c.method)).toEqual(['eth_requestAccounts', 'eth_chainId'])
    expect(check()).toEqual({ canSign: true, reason: null, ownerConnected: true })
  })

  it('a rejected prompt leaves the app disconnected with a readable message', async () => {
    const { mock, wallet } = setup()
    mock.state.rejectConnect = true
    await wallet.connect()
    expect(wallet.getState()).toMatchObject({ status: 'disconnected', error: 'You rejected the request in the wallet.' })
  })

  it('stores only the last connected address', async () => {
    const { storage, wallet, mock } = setup()
    await wallet.connect()
    expect([...storage.map.entries()]).toEqual([[LAST_ACCOUNT_KEY, OWNER]])
    mock.switchAccount([OTHER])
    expect([...storage.map.entries()]).toEqual([[LAST_ACCOUNT_KEY, OTHER]])
  })
})

describe('wrong chain', () => {
  it('keeps signing disabled on another network and switches with wallet_switchEthereumChain', async () => {
    const { mock, wallet, check } = setup({ chainId: 1 })
    await wallet.connect()
    expect(check()).toMatchObject({ canSign: false, reason: expect.stringContaining('Wrong network') })
    await wallet.switchChain()
    expect(mock.calls.filter((c) => c.method === 'wallet_switchEthereumChain')[0].params).toEqual([{ chainId: '0x14a34' }])
    expect(check().canSign).toBe(true)
  })

  it('adds Base Sepolia with wallet_addEthereumChain when the wallet does not know it', async () => {
    const { mock, wallet, check } = setup({ chainId: 1, knownChains: [1] })
    await wallet.connect()
    await wallet.switchChain()
    const methods = mock.calls.map((c) => c.method)
    expect(methods).toContain('wallet_addEthereumChain')
    const add = mock.calls.find((c) => c.method === 'wallet_addEthereumChain')!.params as [{ chainId: string; rpcUrls: string[]; chainName: string }]
    expect(add[0]).toMatchObject({ chainId: '0x14a34', chainName: 'Base Sepolia', rpcUrls: ['https://sepolia.base.org'] })
    expect(check().canSign).toBe(true)
  })

  it('switching the wallet to another network disables signing immediately', async () => {
    const { mock, wallet, check } = setup()
    await wallet.connect()
    expect(check().canSign).toBe(true)
    mock.switchNetwork(1)
    expect(check()).toMatchObject({ canSign: false, reason: expect.stringContaining('Wrong network') })
    mock.switchNetwork(84532)
    await vi.waitFor(() => expect(check().canSign).toBe(true))
  })
})

describe('wrong account', () => {
  it('says the connected account is not the wallet owner and keeps signing disabled', async () => {
    const { wallet, check } = setup({ accounts: [OTHER] })
    await wallet.connect()
    expect(check()).toMatchObject({ canSign: false, ownerConnected: false })
    expect(check().reason).toContain('The connected account is not the wallet owner')
  })

  it('compares with owner() read on chain, case-insensitively', async () => {
    const { wallet, check } = setup({ accounts: [OWNER.toLowerCase()] })
    await wallet.connect()
    expect(check().canSign).toBe(true)
  })

  it('keeps signing disabled when owner() cannot be read', async () => {
    const { wallet, check } = setup({}, vi.fn(async () => { throw new Error('HTTP request failed') }))
    await wallet.connect()
    expect(check()).toMatchObject({ canSign: false, reason: expect.stringContaining('Could not read AgentWallet.owner()') })
  })
})

describe('account switching', () => {
  it('switching to another account disables signing immediately, switching back re-enables it after the re-check', async () => {
    const { mock, wallet, check, readOwner } = setup()
    await wallet.connect()
    expect(check().canSign).toBe(true)
    mock.switchAccount([OTHER])
    expect(check().canSign).toBe(false) // synchronously, before anything else runs
    await vi.waitFor(() => expect(check().reason).toContain('not the wallet owner'))
    mock.switchAccount([OWNER])
    expect(check().canSign).toBe(false) // owner re-check in progress
    await vi.waitFor(() => expect(check().canSign).toBe(true))
    expect(readOwner).toHaveBeenCalledTimes(3) // connect + each account change
  })

  it('an empty accountsChanged (wallet locked or site disconnected) disconnects', async () => {
    const { mock, wallet } = setup()
    await wallet.connect()
    mock.switchAccount([])
    expect(wallet.getState()).toMatchObject({ status: 'disconnected', error: expect.stringContaining('disconnected') })
  })

  it('a slow owner read for an old account never overrides a newer one', async () => {
    let resolveFirst: (a: `0x${string}`) => void = () => {}
    const readOwner = vi.fn()
      .mockImplementationOnce(() => new Promise<`0x${string}`>((r) => (resolveFirst = r)))
      .mockImplementation(async () => OTHER as `0x${string}`)
    const { mock, wallet, check } = setup({}, readOwner)
    const connecting = wallet.connect()
    await vi.waitFor(() => expect(wallet.getState().status).toBe('connected'))
    mock.switchAccount([OWNER]) // second read says the owner is OTHER (e.g. ownership moved)
    await vi.waitFor(() => expect(check().reason).toContain('not the wallet owner'))
    resolveFirst(OWNER as `0x${string}`) // the stale first answer arrives last
    await connecting
    expect(check().canSign).toBe(false)
  })

  it('destroy() removes the wallet listeners', async () => {
    const { mock, wallet } = setup()
    await wallet.connect()
    expect(mock.listenerCount('accountsChanged')).toBe(1)
    wallet.destroy()
    expect(mock.listenerCount('accountsChanged')).toBe(0)
    expect(mock.listenerCount('chainChanged')).toBe(0)
  })
})

describe('no key handling', () => {
  it('refuses eth_sign and the other signing methods before they reach the wallet', async () => {
    const mock = mockProvider()
    const guarded = guardProvider(mock.provider)
    for (const method of FORBIDDEN_METHODS) await expect(guarded.request({ method, params: [] })).rejects.toBeInstanceOf(ForbiddenMethodError)
    expect(mock.calls).toEqual([])
  })

  it('the wallet client it hands out also cannot call eth_sign', async () => {
    const { wallet, mock } = setup()
    await wallet.connect()
    const client = wallet.walletClient()
    expect(client).not.toBeNull()
    await expect(client!.request({ method: 'eth_sign' as never, params: [OWNER, '0x00'] as never })).rejects.toThrow()
    expect(mock.calls.some((c) => c.method === 'eth_sign')).toBe(false)
    mock.switchNetwork(1)
    expect(wallet.walletClient()).toBeNull()
  })

  it('frontend/src contains no private key, mnemonic or eth_sign handling', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx|js|jsx|css|html)$/.test(f)) files.push(p)
      }
    }
    walk(fileURLToPath(new URL('../src', import.meta.url)))
    const forbidden = /privateKeyToAccount|mnemonicToAccount|hdKeyToAccount|generatePrivateKey|generateMnemonic|viem\/accounts|PRIVATE_KEY|seed phrase|\bmnemonic\b/i
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      expect(forbidden.test(text), f).toBe(false)
      // eth_sign may only appear in the deny list in chain/wallet.ts
      if (!f.endsWith(join('chain', 'wallet.ts'))) expect(/['"]eth_sign/.test(text), f).toBe(false)
    }
    expect(files.length).toBeGreaterThan(20)
  })
})

describe('connect button view', () => {
  const view = (state: WalletState, blocked: string | null = null) =>
    renderToStaticMarkup(<WalletConnectView wallet={null} state={state} check={signingCheck(state)} blocked={blocked} />)
  const connected = (over: Partial<Extract<WalletState, { status: 'connected' }>> = {}): WalletState => ({
    status: 'connected', account: OWNER, chainId: 84532, expectedChainId: 84532, owner: { state: 'ok', owner: OWNER }, switching: false, error: null, ...over,
  })

  it('shows "Owner connected" only when every check passes', () => {
    expect(view(connected())).toContain('Owner connected')
    expect(view(connected())).toContain('data-can-sign="true"')
    expect(view(connected({ account: OTHER }))).not.toContain('Owner connected')
    expect(view(connected({ account: OTHER }))).toContain('The connected account is not the wallet owner')
    expect(view(connected({ chainId: 1 }))).toContain('Switch to Base Sepolia')
    expect(view(connected(), 'the backend is not ready')).toContain('data-can-sign="false"')
  })

  it('shows the no-wallet and connect states', () => {
    expect(view({ status: 'no_wallet' })).toContain('No browser wallet found')
    expect(view({ status: 'disconnected', lastAccount: OWNER, error: null })).toContain('Connect wallet')
  })
})
