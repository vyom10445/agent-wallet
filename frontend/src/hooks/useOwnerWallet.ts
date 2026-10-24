// One owner-wallet store for the app, created once the backend's chain and address book are known.
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react'
import { createChainReads } from '../chain/reads'
import { createOwnerWallet, injectedProvider, signingCheck, type OwnerWallet, type WalletState } from '../chain/wallet'
import type { StartupState } from '../lib/startup'

export function useCreateOwnerWallet(startup: StartupState | null): OwnerWallet | null {
  const deployment = startup?.phase === 'ready' ? startup.deployment : null
  const wallet = useMemo(() => {
    if (!deployment) return null
    const reads = createChainReads(deployment)
    return createOwnerWallet({ provider: injectedProvider(), expectedChainId: deployment.chainId, readOwner: reads.owner })
  }, [deployment])
  useEffect(() => () => wallet?.destroy(), [wallet])
  return wallet
}

export const OwnerWalletContext = createContext<OwnerWallet | null>(null)

const NOT_READY: WalletState = { status: 'disconnected', lastAccount: null, error: null }
const noop = () => () => {}

/** The wallet state and the signing decision; re-renders on every wallet change. */
export function useOwnerWallet() {
  const wallet = useContext(OwnerWalletContext)
  const state = useSyncExternalStore(wallet?.subscribe ?? noop, () => wallet?.getState() ?? NOT_READY)
  return { wallet, state, check: signingCheck(state) }
}
