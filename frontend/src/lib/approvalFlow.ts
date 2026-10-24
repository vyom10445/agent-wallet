// The owner-approval sequence and its state, outside React so it can be tested with mocks:
//   reload request → rebuild from chain + compare → max price → simulate → wallet prompt → receipt → verify
// Never sign twice: from the wallet prompt until verify succeeds the sign button stays disabled, and once a tx hash
// exists only "retry verify" is offered (the purchase is already on chain). A reverted tx bought nothing, so signing
// may be tried again after it.
import type { Hash } from 'viem'
import type { ApiClient } from '../api/client'
import { isApiError } from '../api/client'
import type { Check, PurchaseRequest, VerifyResponse } from '../api/types'
import {
  checkApproval, checkMaxPrice, explainError, isApprovable, sendApproval, simulateApproval, waitForApproval,
  type ApprovalReads, type Mismatch, type Rebuilt, type SendDeps,
} from '../chain/approval'
import type { Deployment } from '../config'

export type FlowState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'mismatch'; mismatches: Mismatch[]; rebuilt: Rebuilt }
  | { phase: 'refused'; reason: string }
  | { phase: 'cancelled'; reason: string }
  | { phase: 'simulating' }
  | { phase: 'simulateFailed'; reason: string }
  | { phase: 'awaitingWallet' }
  | { phase: 'sendFailed'; reason: string }
  | { phase: 'mining'; txHash: Hash }
  | { phase: 'reverted'; txHash: Hash }
  | { phase: 'verifying'; txHash: Hash; attempt: number }
  | { phase: 'verifyFailed'; txHash: Hash; code: string; message: string; serverMessage: string | null; checks: Check[] }
  | { phase: 'verified'; txHash: Hash; result: VerifyResponse }

/** Phases in which no new wallet prompt may open. */
const BUSY: readonly FlowState['phase'][] = ['checking', 'simulating', 'awaitingWallet', 'mining', 'verifying']

export const isBusy = (s: FlowState) => BUSY.includes(s.phase)

/** A tx is on chain (or about to be): only verify is allowed for it, never a second signature. */
export const hasLiveTx = (s: FlowState) => s.phase === 'mining' || s.phase === 'verifying' || s.phase === 'verifyFailed' || s.phase === 'verified'

export const canStartSigning = (s: FlowState) => !isBusy(s) && !hasLiveTx(s)

export const canRetryVerify = (s: FlowState): s is Extract<FlowState, { phase: 'verifyFailed' }> => s.phase === 'verifyFailed'

export type SignContext = {
  api: Pick<ApiClient, 'request' | 'verify'>
  reads: ApprovalReads
  deployment: Deployment
  send: SendDeps
  requestId: string
  maxPriceText: string
  onState: (s: FlowState) => void
  /** Called when the request on the backend changed (verified): reload it, refresh the dashboard. */
  onDone?: () => void
  /**
   * Checked before the simulation and again right before the wallet prompt: a reason string cancels the flow (the
   * account or network changed, the owner check no longer passes, startup checks failed). null means go on.
   */
  guard?: () => string | null
}

/** Runs the whole sequence once. Resolves with the final state; never throws. */
export async function runSigning(ctx: SignContext): Promise<FlowState> {
  const step = (s: FlowState) => {
    ctx.onState(s)
    return s
  }
  step({ phase: 'checking' })

  // 1. Fresh request and fresh chain reads right before the wallet opens.
  let request: PurchaseRequest
  try {
    request = await ctx.api.request(ctx.requestId)
  } catch (e) {
    return step({ phase: 'refused', reason: isApiError(e) ? `${e.message}${e.serverMessage ? ` (${e.serverMessage})` : ''}` : explainError(e) })
  }
  if (!isApprovable(request)) return step({ phase: 'refused', reason: `This request is ${request.status}; it cannot be approved now.` })

  let rebuilt: Rebuilt
  try {
    const check = await checkApproval(ctx.reads, ctx.deployment, request)
    if (!check.ok) return step({ phase: 'mismatch', mismatches: check.mismatches, rebuilt: check.rebuilt })
    rebuilt = check.rebuilt
  } catch (e) {
    return step({ phase: 'refused', reason: `Could not read the chain to check the approval: ${explainError(e)}` })
  }

  // 2. The owner's max price.
  const max = checkMaxPrice(rebuilt.price, ctx.maxPriceText)
  if (!max.ok) return step({ phase: 'refused', reason: max.reason })
  const stop = (): FlowState | null => {
    const reason = ctx.guard?.() ?? null
    return reason ? step({ phase: 'cancelled', reason }) : null
  }
  const early = stop()
  if (early) return early

  // 3. Simulate from the owner.
  step({ phase: 'simulating' })
  let simulated: Awaited<ReturnType<typeof simulateApproval>>
  try {
    simulated = await simulateApproval(ctx.send, rebuilt)
  } catch (e) {
    return step({ phase: 'simulateFailed', reason: explainError(e) })
  }

  // 4. The wallet prompt. From here on there is at most one transaction.
  const late = stop()
  if (late) return late
  step({ phase: 'awaitingWallet' })
  let txHash: Hash
  try {
    txHash = await sendApproval(ctx.send, simulated)
  } catch (e) {
    return step({ phase: 'sendFailed', reason: explainError(e) })
  }

  step({ phase: 'mining', txHash })
  try {
    const receipt = await waitForApproval(ctx.send, txHash)
    if (receipt.status !== 'success') return step({ phase: 'reverted', txHash })
  } catch {
    // The tx exists but the receipt could not be read: verify can still settle it, so offer retry verify.
    return step({ phase: 'verifyFailed', txHash, code: 'RECEIPT_UNKNOWN', message: 'Could not read the receipt yet. The transaction may still be mining: retry verify in a moment.', serverMessage: null, checks: [] })
  }

  return verifyTx(ctx, txHash, 1)
}

/** POST /approvals/:id/verify. Safe to retry: it only reads the chain and the tx is already there. */
export async function verifyTx(ctx: Pick<SignContext, 'api' | 'requestId' | 'onState' | 'onDone'>, txHash: Hash, attempt = 1): Promise<FlowState> {
  ctx.onState({ phase: 'verifying', txHash, attempt })
  try {
    const result = await ctx.api.verify(ctx.requestId, txHash)
    const done: FlowState = { phase: 'verified', txHash, result }
    ctx.onState(done)
    ctx.onDone?.()
    return done
  } catch (e) {
    const failed: FlowState = isApiError(e)
      ? { phase: 'verifyFailed', txHash, code: String(e.code), message: e.message, serverMessage: e.serverMessage, checks: e.checks }
      : { phase: 'verifyFailed', txHash, code: 'UNKNOWN', message: explainError(e), serverMessage: null, checks: [] }
    ctx.onState(failed)
    return failed
  }
}
