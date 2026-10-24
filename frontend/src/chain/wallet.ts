// The owner's injected wallet (window.ethereum, EIP-1193). The frontend never holds a key: it asks the wallet for the
// account (only when the user clicks Connect), checks the network and that the account is AgentWallet.owner() read on
// chain through the public RPC, and only then allows signing. Any accountsChanged / chainChanged disables signing at
// once and re-runs the checks. Only the last connected address is stored (localStorage), never anything else.
import { createWalletClient, custom, getAddress, isAddress, numberToHex, type Chain, type EIP1193Provider, type WalletClient } from 'viem'
import { SUPPORTED_CHAINS } from '../config'
import type { Address } from '../api/types'

/** Methods this app never sends to the wallet: raw-hash signing, message/typed-data signing, offline tx signing. */
export const FORBIDDEN_METHODS: ReadonlySet<string> = new Set([
  'eth_sign', 'personal_sign', 'eth_signTypedData', 'eth_signTypedData_v1', 'eth_signTypedData_v3', 'eth_signTypedData_v4',
  'eth_signTransaction',
])

export class ForbiddenMethodError extends Error {
  constructor(method: string) {
    super(`This app never calls ${method}`)
    this.name = 'ForbiddenMethodError'
  }
}

type Listener = (...args: unknown[]) => void
export type Eip1193 = {
  request(args: { method: string; params?: unknown }): Promise<unknown>
  on?(event: string, listener: Listener): void
  removeListener?(event: string, listener: Listener): void
}

/** A provider wrapper that refuses the forbidden methods, whoever asks (this code, viem, a future change). */
export function guardProvider(provider: Eip1193): Eip1193 {
  return {
    request: (args) => (FORBIDDEN_METHODS.has(args.method) ? Promise.reject(new ForbiddenMethodError(args.method)) : provider.request(args)),
    on: provider.on?.bind(provider),
    removeListener: provider.removeListener?.bind(provider),
  }
}

export const injectedProvider = (): Eip1193 | null => {
  const eth = (globalThis as { ethereum?: Eip1193 }).ethereum
  return eth && typeof eth.request === 'function' ? eth : null
}

export type OwnerCheck = { state: 'idle' } | { state: 'loading' } | { state: 'ok'; owner: Address } | { state: 'error'; message: string }

export type WalletState =
  | { status: 'no_wallet' }
  | { status: 'disconnected'; lastAccount: Address | null; error: string | null }
  | { status: 'connecting' }
  | {
      status: 'connected'
      account: Address
      chainId: number
      expectedChainId: number
      owner: OwnerCheck
      switching: boolean
      error: string | null
    }

export type SigningCheck = { canSign: boolean; reason: string | null; ownerConnected: boolean }

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const chainName = (id: number) => SUPPORTED_CHAINS[id]?.name ?? `chain ${id}`

/** Whether the owner may sign now, and if not, the one message to show. Pure. */
export function signingCheck(state: WalletState): SigningCheck {
  const no = (reason: string): SigningCheck => ({ canSign: false, reason, ownerConnected: false })
  switch (state.status) {
    case 'no_wallet':
      return no('No browser wallet found. Install MetaMask (in a testnet-only browser profile), or use the tx-hash option.')
    case 'disconnected':
      return no('Connect the owner wallet to sign.')
    case 'connecting':
      return no('Waiting for the wallet…')
    case 'connected': {
      if (state.chainId !== state.expectedChainId) return no(`Wrong network: the wallet is on ${chainName(state.chainId)}, the backend uses ${chainName(state.expectedChainId)}.`)
      if (state.owner.state === 'loading' || state.owner.state === 'idle') return no('Checking the wallet owner on chain…')
      if (state.owner.state === 'error') return no(`Could not read AgentWallet.owner() on chain: ${state.owner.message}`)
      if (state.account.toLowerCase() !== state.owner.owner.toLowerCase()) {
        return no(`The connected account is not the wallet owner (connected ${shortAddr(state.account)}, owner ${shortAddr(state.owner.owner)}).`)
      }
      return { canSign: true, reason: null, ownerConnected: true }
    }
  }
}

export const LAST_ACCOUNT_KEY = 'agent-wallet.lastAccount'

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const browserStorage = (): StorageLike | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

type Options = {
  /** The injected provider (window.ethereum), or null when there is none. */
  provider: Eip1193 | null
  /** The backend's chainId from GET /health. */
  expectedChainId: number
  /** AgentWallet.owner() through the public RPC (chain/reads.ts), never through the wallet. */
  readOwner: () => Promise<Address>
  storage?: StorageLike | null
}

const parseChainId = (v: unknown) => (typeof v === 'string' ? Number.parseInt(v, v.startsWith('0x') ? 16 : 10) : Number(v))
const errorMessage = (e: unknown) => {
  const err = e as { code?: number; shortMessage?: string; message?: string }
  if (err?.code === 4001) return 'You rejected the request in the wallet.'
  if (err?.code === -32002) return 'The wallet already has a pending request: open it and answer there.'
  return err?.shortMessage ?? err?.message ?? String(e)
}

export function createOwnerWallet({ provider: raw, expectedChainId, readOwner, storage = browserStorage() }: Options) {
  const provider = raw ? guardProvider(raw) : null
  let state: WalletState = provider
    ? { status: 'disconnected', lastAccount: readLast(), error: null }
    : { status: 'no_wallet' }
  const listeners = new Set<() => void>()
  let ownerRun = 0

  function readLast(): Address | null {
    try {
      const v = storage?.getItem(LAST_ACCOUNT_KEY) ?? null
      return v && isAddress(v) ? getAddress(v) : null
    } catch {
      return null
    }
  }
  function writeLast(a: Address | null) {
    try {
      if (a) storage?.setItem(LAST_ACCOUNT_KEY, a)
      else storage?.removeItem(LAST_ACCOUNT_KEY)
    } catch {
      // storage unavailable: nothing is remembered, which is fine
    }
  }

  const set = (next: WalletState) => {
    state = next
    for (const l of listeners) l()
  }

  /** Reads owner() again; the latest run wins, so a slow old answer never overrides a newer one. */
  async function checkOwner() {
    if (state.status !== 'connected') return
    const run = ++ownerRun
    set({ ...state, owner: { state: 'loading' } })
    let owner: OwnerCheck
    try {
      const a = await readOwner()
      owner = { state: 'ok', owner: getAddress(a) }
    } catch (e) {
      owner = { state: 'error', message: errorMessage(e) }
    }
    if (run === ownerRun && state.status === 'connected') set({ ...state, owner })
  }

  function onAccounts(accounts: unknown) {
    const list = Array.isArray(accounts) ? accounts.filter((a): a is string => typeof a === 'string' && isAddress(a)) : []
    if (state.status !== 'connected' && state.status !== 'connecting') return
    if (!list.length) {
      set({ status: 'disconnected', lastAccount: readLast(), error: 'The wallet disconnected this site.' })
      return
    }
    const account = getAddress(list[0])
    writeLast(account)
    if (state.status === 'connected') {
      // Signing is disabled at once (owner check goes back to loading), then re-checked.
      set({ ...state, account, error: null })
      void checkOwner()
    }
  }

  function onChain(chainId: unknown) {
    if (state.status !== 'connected') return
    set({ ...state, chainId: parseChainId(chainId), error: null })
    void checkOwner()
  }

  let subscribed = false
  function subscribe() {
    if (subscribed || !provider?.on) return
    provider.on('accountsChanged', onAccounts)
    provider.on('chainChanged', onChain)
    subscribed = true
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    /** Asks the wallet for the account. Only call this from a user click. */
    async connect() {
      if (!provider) return
      set({ status: 'connecting' })
      try {
        const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as unknown[]
        const first = accounts.find((a): a is string => typeof a === 'string' && isAddress(a))
        if (!first) throw new Error('The wallet returned no account.')
        const chainId = parseChainId(await provider.request({ method: 'eth_chainId' }))
        const account = getAddress(first)
        writeLast(account)
        subscribe()
        set({ status: 'connected', account, chainId, expectedChainId, owner: { state: 'idle' }, switching: false, error: null })
        await checkOwner()
      } catch (e) {
        set({ status: 'disconnected', lastAccount: readLast(), error: errorMessage(e) })
      }
    },

    /** Forget the connection in this app (the wallet itself keeps its own permission; revoke it there if you want). */
    disconnect() {
      ownerRun++
      set({ status: 'disconnected', lastAccount: readLast(), error: null })
    },

    /** wallet_switchEthereumChain to the backend's chain; for Base Sepolia, wallet_addEthereumChain if it is missing. */
    async switchChain() {
      if (!provider || state.status !== 'connected') return
      const hex = numberToHex(expectedChainId)
      set({ ...state, switching: true, error: null })
      try {
        try {
          await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] })
        } catch (e) {
          const code = (e as { code?: number; data?: { originalError?: { code?: number } } })?.code ?? (e as { data?: { originalError?: { code?: number } } })?.data?.originalError?.code
          const chain = SUPPORTED_CHAINS[expectedChainId]
          if (code !== 4902 || expectedChainId !== 84532 || !chain) throw e
          await provider.request({ method: 'wallet_addEthereumChain', params: [addChainParams(chain)] })
          await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] })
        }
        // Use what the wallet reports now, not what we asked for (chainChanged usually arrives too).
        const chainId = parseChainId(await provider.request({ method: 'eth_chainId' }))
        if (state.status === 'connected') set({ ...state, chainId, switching: false })
        await checkOwner()
      } catch (e) {
        if (state.status === 'connected') set({ ...state, switching: false, error: errorMessage(e) })
      }
    },

    recheck: () => checkOwner(),

    /**
     * A viem wallet client for the owner, only while every check passes. Phase 8 uses it to send executeBatch as a
     * normal transaction (eth_sendTransaction); the forbidden signing methods stay blocked by the guard.
     */
    walletClient(): WalletClient | null {
      if (!provider || state.status !== 'connected' || !signingCheck(state).canSign) return null
      const chain = SUPPORTED_CHAINS[state.chainId]
      return createWalletClient({ account: state.account, chain, transport: custom(provider as EIP1193Provider) })
    },

    destroy() {
      if (subscribed && provider?.removeListener) {
        provider.removeListener('accountsChanged', onAccounts)
        provider.removeListener('chainChanged', onChain)
      }
      subscribed = false
      listeners.clear()
    },
  }
}

export type OwnerWallet = ReturnType<typeof createOwnerWallet>

/**
 * A guard for one signing flow, taken when the flow starts: it returns a reason to cancel when the account or network
 * changed since then, when the owner check no longer passes, or when `blocked()` reports a startup problem.
 */
export function flowGuard(wallet: Pick<OwnerWallet, 'getState'>, blocked: () => string | null = () => null): () => string | null {
  const first = wallet.getState()
  const start = first.status === 'connected' ? { account: first.account.toLowerCase(), chainId: first.chainId } : null
  return () => {
    const b = blocked()
    if (b) return `Signing disabled: ${b}.`
    const s = wallet.getState()
    const c = signingCheck(s)
    if (!start || s.status !== 'connected' || !c.canSign) return c.reason ?? 'The owner wallet is no longer connected.'
    if (s.account.toLowerCase() !== start.account || s.chainId !== start.chainId) return 'The wallet account or network changed during the flow.'
    return null
  }
}

/** EIP-3085 parameters for wallet_addEthereumChain, from viem's chain definition (Base Sepolia: sepolia.base.org). */
export function addChainParams(chain: Chain) {
  return {
    chainId: numberToHex(chain.id),
    chainName: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: chain.rpcUrls.default.http,
    blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : undefined,
  }
}
