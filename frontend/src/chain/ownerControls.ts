// Owner controls in the browser, mirroring integration/owner-configure.mjs: simulate from the owner, send with the
// owner's injected wallet, wait for the receipt, check receipt.status and the expected event. Only functions from
// abi/AgentWallet.json (setPolicy, revokeAgent, execute) and abi/MockUSDC.json (approve) are used. The merchant
// allowance is set like contracts/script/ConfigureAgent.s.sol: execute(usdc, 0, approve(merchant, amount)), which
// replaces the allowance (approve sets it, it does not add).
import {
  decodeFunctionData, encodeFunctionData, formatUnits, getAddress, isAddress, parseEventLogs, zeroAddress,
  type Abi, type Hash, type Hex, type PublicClient, type WalletClient,
} from 'viem'
import type { Address } from '../api/types'
import { ABI, USDC_DECIMALS, type Deployment } from '../config'
import type { SigningCheck } from './wallet'
import { explainError } from './approval'
import { parseMusdc } from '../lib/format'

export type OwnerAction =
  | { kind: 'setPolicy'; agent: Address; maxPerTx: bigint; dailyLimit: bigint }
  | { kind: 'revokeAgent'; agent: Address }
  | { kind: 'allowance'; amount: bigint }

export type DecodedArg = { name: string; value: string; note?: string }
export type DecodedCall = { to: Address; contract: string; functionName: string; args: DecodedArg[]; inner?: DecodedCall }

/** What will be sent: always AgentWallet.<fn>(...) from the owner, plus the event the receipt must contain. */
export type OwnerCall = {
  action: OwnerAction
  address: Address
  functionName: 'setPolicy' | 'revokeAgent' | 'execute'
  args: readonly unknown[]
  data: Hex
  /** Decoded back from `data`, the bytes that will be sent. */
  decoded: DecodedCall
  expect: { emitter: Address; abi: Abi; eventName: 'PolicySet' | 'AgentRevoked' | 'Approval'; args: Record<string, string> }
}

const mUSDC = (v: bigint) => `${formatUnits(v, USDC_DECIMALS)} mUSDC`
const lower = (v: unknown) => String(v).toLowerCase()

/** Owner controls are enabled only when the owner is connected on the backend's chain and startup checks passed. */
export function ownerGate(check: SigningCheck, blocked: string | null): { enabled: boolean; reason: string | null } {
  if (blocked) return { enabled: false, reason: `Owner controls disabled: ${blocked}` }
  if (!check.canSign) return { enabled: false, reason: check.reason ?? 'Connect the owner wallet.' }
  return { enabled: true, reason: null }
}

/** maxPerTx and dailyLimit typed in mUSDC (parseUnits(x, 6)); zero and maxPerTx > dailyLimit are refused. */
export function validatePolicy(maxText: string, dailyText: string): { ok: true; maxPerTx: bigint; dailyLimit: bigint } | { ok: false; reason: string } {
  const maxPerTx = parseMusdc(maxText)
  const dailyLimit = parseMusdc(dailyText)
  if (maxPerTx === null || dailyLimit === null) return { ok: false, reason: 'Enter both limits in mUSDC (up to 6 decimals).' }
  if (maxPerTx === 0n || dailyLimit === 0n) return { ok: false, reason: 'A limit of zero is not allowed. To stop the agent, revoke it.' }
  if (maxPerTx > dailyLimit) return { ok: false, reason: `maxPerTx ${mUSDC(maxPerTx)} is above dailyLimit ${mUSDC(dailyLimit)}.` }
  return { ok: true, maxPerTx, dailyLimit }
}

export function validateAllowance(text: string): { ok: true; amount: bigint } | { ok: false; reason: string } {
  const amount = parseMusdc(text)
  if (amount === null) return { ok: false, reason: 'Enter the new allowance in mUSDC (up to 6 decimals).' }
  if (amount === 0n) return { ok: false, reason: 'An allowance of zero stops every purchase. Revoke the agent instead.' }
  return { ok: true, amount }
}

export const REVOKE_WORD = 'REVOKE'
export const revokeConfirmed = (typed: string) => typed.trim() === REVOKE_WORD

export function validAgent(agent: unknown): agent is Address {
  return typeof agent === 'string' && isAddress(agent) && lower(agent) !== zeroAddress
}

/** Encodes the action. The agent comes from the startup checks (GET /health agent = GET /wallet/status agent). */
export function buildOwnerCall(action: OwnerAction, d: Deployment): OwnerCall {
  const address = d.wallet
  if (action.kind === 'setPolicy') {
    if (!validAgent(action.agent)) throw new Error('Invalid agent address')
    const args = [getAddress(action.agent), d.usdc, action.maxPerTx, action.dailyLimit] as const
    const data = encodeFunctionData({ abi: ABI.wallet, functionName: 'setPolicy', args })
    return {
      action, address, functionName: 'setPolicy', args, data, decoded: decodeOwnerCall(data, d),
      expect: { emitter: d.wallet, abi: ABI.wallet, eventName: 'PolicySet', args: { agent: args[0], token: d.usdc, maxPerTx: String(action.maxPerTx), dailyLimit: String(action.dailyLimit) } },
    }
  }
  if (action.kind === 'revokeAgent') {
    if (!validAgent(action.agent)) throw new Error('Invalid agent address')
    const args = [getAddress(action.agent)] as const
    const data = encodeFunctionData({ abi: ABI.wallet, functionName: 'revokeAgent', args })
    return {
      action, address, functionName: 'revokeAgent', args, data, decoded: decodeOwnerCall(data, d),
      expect: { emitter: d.wallet, abi: ABI.wallet, eventName: 'AgentRevoked', args: { agent: args[0] } },
    }
  }
  const approve = encodeFunctionData({ abi: ABI.usdc, functionName: 'approve', args: [d.merchant, action.amount] })
  const args = [d.usdc, 0n, approve] as const
  const data = encodeFunctionData({ abi: ABI.wallet, functionName: 'execute', args })
  return {
    action, address, functionName: 'execute', args, data, decoded: decodeOwnerCall(data, d),
    expect: { emitter: d.usdc, abi: ABI.usdc, eventName: 'Approval', args: { owner: d.wallet, spender: d.merchant, value: String(action.amount) } },
  }
}

const ADDRESS_NAMES = (d: Deployment): Record<string, string> => ({
  [lower(d.usdc)]: 'mUSDC', [lower(d.merchant)]: 'merchant', [lower(d.wallet)]: 'AgentWallet',
})
const AMOUNT_ARGS = new Set(['maxPerTx', 'dailyLimit', 'amount', 'value'])

/** Decodes the calldata with the ABI of its target, naming known addresses, and decodes execute's inner call. */
export function decodeOwnerCall(data: Hex, d: Deployment, to: Address = d.wallet): DecodedCall {
  const names = ADDRESS_NAMES(d)
  const abi = lower(to) === lower(d.usdc) ? ABI.usdc : ABI.wallet
  const { functionName, args = [] } = decodeFunctionData({ abi, data })
  const item = abi.find((x) => x.type === 'function' && x.name === functionName) as { inputs?: { name?: string; type: string }[] } | undefined
  const out: DecodedCall = { to, contract: names[lower(to)] ?? 'unknown', functionName, args: [] }
  args.forEach((v, i) => {
    const input = item?.inputs?.[i]
    const name = input?.name || `arg${i}`
    const value = typeof v === 'bigint' ? v.toString() : String(v)
    const note = input?.type === 'address' ? names[lower(value)] : typeof v === 'bigint' && AMOUNT_ARGS.has(name) && !(functionName === 'execute' && name === 'value') ? mUSDC(v) : undefined
    out.args.push({ name, value: input?.type === 'bytes' ? `${value.slice(0, 10)}… (${(value.length - 2) / 2} bytes)` : value, note })
  })
  if (functionName === 'execute') out.inner = decodeOwnerCall(args[2] as Hex, d, args[0] as Address)
  return out
}

export type OwnerTxState =
  | { phase: 'idle' }
  | { phase: 'simulating' }
  | { phase: 'simulateFailed'; reason: string }
  | { phase: 'awaitingWallet' }
  | { phase: 'sendFailed'; reason: string }
  | { phase: 'mining'; txHash: Hash }
  | { phase: 'reverted'; txHash: Hash }
  | { phase: 'noEvent'; txHash: Hash; reason: string }
  | { phase: 'done'; txHash: Hash; event: string }

export const ownerTxBusy = (s: OwnerTxState) => s.phase === 'simulating' || s.phase === 'awaitingWallet' || s.phase === 'mining'

export type OwnerTxDeps = {
  publicClient: Pick<PublicClient, 'simulateContract' | 'waitForTransactionReceipt'>
  walletClient: Pick<WalletClient, 'writeContract'>
  owner: Address
}

/** Simulate → wallet prompt → receipt → status and expected event. Resolves with the final state; never throws. */
export async function runOwnerTx(deps: OwnerTxDeps, call: OwnerCall, onState: (s: OwnerTxState) => void): Promise<OwnerTxState> {
  const step = (s: OwnerTxState) => {
    onState(s)
    return s
  }
  step({ phase: 'simulating' })
  let request: unknown
  try {
    ;({ request } = await deps.publicClient.simulateContract({
      account: deps.owner, address: call.address, abi: ABI.wallet, functionName: call.functionName, args: call.args,
    }))
  } catch (e) {
    return step({ phase: 'simulateFailed', reason: explainError(e) })
  }
  step({ phase: 'awaitingWallet' })
  let txHash: Hash
  try {
    txHash = await deps.walletClient.writeContract(request as Parameters<WalletClient['writeContract']>[0])
  } catch (e) {
    return step({ phase: 'sendFailed', reason: explainError(e) })
  }
  step({ phase: 'mining', txHash })
  let receipt: Awaited<ReturnType<PublicClient['waitForTransactionReceipt']>>
  try {
    receipt = await deps.publicClient.waitForTransactionReceipt({ hash: txHash })
  } catch (e) {
    return step({ phase: 'noEvent', txHash, reason: `Could not read the receipt: ${explainError(e)}. Check the transaction before trying again.` })
  }
  if (receipt.status !== 'success') return step({ phase: 'reverted', txHash })
  const found = findExpectedEvent(call, receipt.logs ?? [])
  if (!found) return step({ phase: 'noEvent', txHash, reason: `The transaction succeeded but no matching ${call.expect.eventName} event from ${call.expect.emitter} was found.` })
  return step({ phase: 'done', txHash, event: found })
}

/** The expected event, emitted by the expected contract, with the expected arguments. Returns a readable line. */
export function findExpectedEvent(call: OwnerCall, logs: readonly { address: string; data: Hex; topics: readonly Hex[] }[]): string | null {
  const own = logs.filter((l) => lower(l.address) === lower(call.expect.emitter))
  const parsed = parseEventLogs({ abi: call.expect.abi, logs: own as Parameters<typeof parseEventLogs>[0]['logs'], strict: false }) as unknown as { eventName: string; args: Record<string, unknown> }[]
  const hit = parsed.find((l) => l.eventName === call.expect.eventName && Object.entries(call.expect.args).every(([k, v]) => lower(typeof l.args?.[k] === 'bigint' ? (l.args[k] as bigint).toString() : l.args?.[k]) === lower(v)))
  if (!hit) return null
  return `${hit.eventName}(${Object.entries(hit.args ?? {}).map(([k, v]) => `${k}=${typeof v === 'bigint' ? v.toString() : String(v)}`).join(', ')})`
}
