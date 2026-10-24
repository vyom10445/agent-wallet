// Connect button and owner status. Signing (Phase 8) is allowed only when this shows "Owner connected": right network,
// and the connected account equals AgentWallet.owner() read on chain. The app never asks for wallet secrets of any kind.
import { explorerAddressUrl, SUPPORTED_CHAINS } from '../../config'
import { useOwnerWallet } from '../../hooks/useOwnerWallet'
import { shortAddress } from '../../lib/format'
import type { OwnerWallet, SigningCheck, WalletState } from '../../chain/wallet'

export function WalletConnect({ compact = false, blocked = null }: { compact?: boolean; blocked?: string | null }) {
  const { wallet, state, check } = useOwnerWallet()
  return <WalletConnectView wallet={wallet} state={state} check={check} compact={compact} blocked={blocked} />
}

type ViewProps = { wallet: Pick<OwnerWallet, 'connect' | 'disconnect' | 'switchChain' | 'recheck'> | null; state: WalletState; check: SigningCheck; compact?: boolean; blocked?: string | null }

export function WalletConnectView({ wallet, state, check, compact = false, blocked = null }: ViewProps) {
  const canSign = check.canSign && !blocked
  return (
    <div className={`wallet ${compact ? 'compact' : ''} ${canSign ? 'ok' : 'not-ok'}`} data-wallet={state.status} data-can-sign={String(canSign)}>
      {state.status === 'no_wallet' && <span className="msg">No browser wallet found.{compact ? '' : ' Install MetaMask in a testnet-only browser profile, or use the tx-hash option to verify a purchase you signed elsewhere.'}</span>}

      {state.status === 'disconnected' && (
        <>
          <button onClick={() => void wallet?.connect()} disabled={!wallet}>Connect wallet</button>
          {!compact && state.lastAccount && <span className="muted">Last used: <code>{shortAddress(state.lastAccount)}</code></span>}
          {state.error && <span className="error">{state.error}</span>}
        </>
      )}

      {state.status === 'connecting' && <span className="msg">Waiting for the wallet… (answer the prompt in your wallet)</span>}

      {state.status === 'connected' && (
        <>
          <span className="account">
            <Address chainId={state.chainId} value={state.account} /> on {SUPPORTED_CHAINS[state.chainId]?.name ?? `chain ${state.chainId}`}
          </span>
          {check.ownerConnected && !blocked && <span className="badge green" data-owner="connected">Owner connected</span>}
          {state.chainId !== state.expectedChainId && (
            <button onClick={() => void wallet?.switchChain()} disabled={state.switching}>
              {state.switching ? 'Switching…' : `Switch to ${SUPPORTED_CHAINS[state.expectedChainId]?.name ?? `chain ${state.expectedChainId}`}`}
            </button>
          )}
          {state.owner.state === 'error' && <button onClick={() => void wallet?.recheck()}>Check again</button>}
          {!compact && <button className="link" onClick={() => wallet?.disconnect()}>Disconnect</button>}
          {state.error && <span className="error">{state.error}</span>}
        </>
      )}

      {!canSign && state.status !== 'no_wallet' && state.status !== 'disconnected' && (
        <span className="reason" role="status">Signing disabled: {blocked ?? check.reason}</span>
      )}
    </div>
  )
}

function Address({ chainId, value }: { chainId: number; value: string }) {
  const href = explorerAddressUrl(chainId, value)
  return href ? <a href={href} target="_blank" rel="noreferrer noopener"><code>{shortAddress(value)}</code></a> : <code>{shortAddress(value)}</code>
}
