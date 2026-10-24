// A scripted EIP-1193 provider: accounts and chain can be changed from the test, and every request is recorded.
type Listener = (...args: unknown[]) => void

export function mockProvider({ accounts = ['0x815d211D2E85E2C2526f0CC3bB1DEE11513C7b64'], chainId = 84532, knownChains = [1, 84532, 31337] } = {}) {
  const listeners = new Map<string, Set<Listener>>()
  const calls: { method: string; params?: unknown }[] = []
  const state = { accounts, chainId, knownChains: new Set(knownChains), rejectConnect: false, txHash: `0x${'ab'.repeat(32)}`, sent: [] as unknown[] }
  const emit = (event: string, ...args: unknown[]) => listeners.get(event)?.forEach((l) => l(...args))
  const provider = {
    async request({ method, params }: { method: string; params?: unknown }) {
      calls.push({ method, params })
      switch (method) {
        case 'eth_requestAccounts':
          if (state.rejectConnect) throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
          return state.accounts
        case 'eth_accounts':
          return state.accounts
        case 'eth_chainId':
          return `0x${state.chainId.toString(16)}`
        case 'wallet_switchEthereumChain': {
          const id = Number.parseInt((params as [{ chainId: string }])[0].chainId, 16)
          if (!state.knownChains.has(id)) throw Object.assign(new Error('Unrecognized chain ID'), { code: 4902 })
          state.chainId = id
          emit('chainChanged', `0x${id.toString(16)}`)
          return null
        }
        case 'eth_sendTransaction':
          // The only signing request this app sends. Recorded so tests can prove when it was (not) sent.
          state.sent.push((params as unknown[])[0])
          return state.txHash
        case 'wallet_addEthereumChain':
          state.knownChains.add(Number.parseInt((params as [{ chainId: string }])[0].chainId, 16))
          return null
        default:
          throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 })
      }
    },
    on(event: string, l: Listener) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(l)
    },
    removeListener(event: string, l: Listener) {
      listeners.get(event)?.delete(l)
    },
  }
  return {
    provider,
    calls,
    state,
    /** The user picks another account in the wallet. */
    switchAccount(a: string[]) {
      state.accounts = a
      emit('accountsChanged', a)
    },
    /** The user picks another network in the wallet. */
    switchNetwork(id: number) {
      state.chainId = id
      emit('chainChanged', `0x${id.toString(16)}`)
    },
    listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
  }
}
