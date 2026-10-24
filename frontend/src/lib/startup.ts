// Startup checks (docs/UI_SPEC.md §1.1): the backend and the address book must describe the same wallet before the app
// trusts either. GET /health picks the deployment by chainId; GET /health and GET /wallet/status addresses must equal
// contracts/deployments/<chainId>.json. Any difference is blocking and disables the owner approval flow.
import { isApiError, type ApiClient } from '../api/client'
import type { Health, WalletStatus } from '../api/types'
import { DEPLOYMENTS, type Deployment } from '../config'
import { sameAddress } from './format'

export type Mismatch = { field: string; backend: string | null; file: string | null }

/** Pure comparison. The deployment file has no agent key, so the agent is checked between /health and /wallet/status. */
export function compareAddresses(health: Health, status: WalletStatus, deployment: Deployment): Mismatch[] {
  const out: Mismatch[] = []
  const expect = (field: string, backend: string | undefined, file: string | undefined) => {
    if (!sameAddress(backend, file)) out.push({ field, backend: backend ?? null, file: file ?? null })
  }
  if (health.chainId !== deployment.chainId) out.push({ field: 'chainId', backend: String(health.chainId), file: String(deployment.chainId) })
  if (status.chainId !== health.chainId) out.push({ field: 'wallet/status chainId', backend: String(status.chainId), file: String(health.chainId) })
  expect('health.wallet', health.wallet, deployment.wallet)
  for (const key of ['wallet', 'owner', 'entryPoint', 'usdc', 'merchant'] as const) {
    expect(`addresses.${key}`, status.addresses?.[key], deployment[key])
  }
  if (!sameAddress(health.agent, status.addresses?.agent)) {
    out.push({ field: 'addresses.agent (vs /health agent)', backend: status.addresses?.agent ?? null, file: health.agent ?? null })
  }
  return out
}

export type StartupState =
  | { phase: 'unreachable'; message: string }
  | { phase: 'error'; message: string; health?: Health }
  | {
      phase: 'ready'
      health: Health
      status: WalletStatus
      deployment: Deployment
      mismatches: Mismatch[]
      /** false whenever anything above is off: the approval flow stays disabled. */
      approvalAllowed: boolean
    }

const describe = (e: unknown) =>
  isApiError(e) ? `${e.message}${e.serverMessage ? ` (${e.serverMessage})` : ''}` : e instanceof Error ? e.message : String(e)

export async function runStartupChecks(api: ApiClient, deployments: Readonly<Record<number, Deployment>> = DEPLOYMENTS): Promise<StartupState> {
  let health: Health
  try {
    health = await api.health()
  } catch (e) {
    if (isApiError(e) && (e.code === 'NETWORK' || e.code === 'TIMEOUT')) return { phase: 'unreachable', message: `${e.message} (${api.baseUrl})` }
    return { phase: 'error', message: describe(e) }
  }
  if (health.ok !== true) return { phase: 'error', message: 'The backend reports ok: false.', health }
  if (health.apiVersion !== '1') return { phase: 'error', message: `Backend API version ${health.apiVersion} is not supported (expected 1).`, health }
  const deployment = deployments[health.chainId]
  if (!deployment) return { phase: 'error', message: `No address book for chain ${health.chainId} (contracts/deployments/${health.chainId}.json).`, health }

  let status: WalletStatus
  try {
    status = await api.walletStatus()
  } catch (e) {
    return { phase: 'error', message: `GET /wallet/status failed: ${describe(e)}`, health }
  }
  const mismatches = compareAddresses(health, status, deployment)
  return { phase: 'ready', health, status, deployment, mismatches, approvalAllowed: mismatches.length === 0 }
}
