// Owner approval in the browser, mirroring integration/owner-approve.mjs step by step:
//   1. build from on-chain facts: price = merchant.quote(credits), standing = usdc.allowance(wallet, merchant),
//      dest = [usdc, merchant], func = [approve(merchant, standing + price), purchase(credits, price)]
//   2. show the owner exactly what they sign, decoded back from the calldata that will be sent
//   3. refuse if price > max price (APPROVE_MAX_PRICE in the script)
//   4. simulate executeBatch(dest, [], func) from the owner, then send it with the owner's wallet, wait for the receipt
// On top of the script: the backend's ownerApproval is compared byte for byte with this rebuild, and any difference
// refuses to sign. The calldata sent is always this rebuild, never the backend's copy.
import {
  BaseError, ContractFunctionRevertedError, decodeErrorResult, decodeFunctionData, encodeFunctionData, formatUnits,
  type Abi, type Hash, type Hex, type PublicClient, type TransactionReceipt, type WalletClient,
} from 'viem'
import type { Address, Amount, OwnerApproval, PurchaseRequest } from '../api/types'
import { ABI, USDC_DECIMALS, type Deployment } from '../config'
import { parseMusdc } from '../lib/format'
import { inert } from '../lib/text'

export type ApprovalReads = { quote: (credits: number | bigint) => Promise<bigint>; allowance: () => Promise<bigint> }

export type DecodedCall = { to: Address; contract: 'mUSDC' | 'merchant'; functionName: string; args: { name: string; value: string }[] }

export type Rebuilt = {
  credits: bigint
  price: bigint
  standing: bigint
  dest: [Address, Address]
  func: [Hex, Hex]
  /** Decoded from `func`, the calldata that will be sent. */
  calls: DecodedCall[]
  readAt: number
}

export type Mismatch = { field: string; backend: string; chain: string }

export type ApprovalCheck = { ok: true; rebuilt: Rebuilt } | { ok: false; rebuilt: Rebuilt; mismatches: Mismatch[] }

const lower = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : String(v))
const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)) ?? String(v))
export const amountText = (v: bigint) => `${formatUnits(v, USDC_DECIMALS)} mUSDC`

/** Step 1 + 2: fresh chain reads, the two calls encoded, and decoded back for display. */
export async function rebuildFromChain(reads: ApprovalReads, deployment: Deployment, credits: number): Promise<Rebuilt> {
  if (!Number.isInteger(credits) || credits < 1 || credits > 10_000) throw new Error(`Invalid credits ${credits}`)
  const n = BigInt(credits)
  const [price, standing] = await Promise.all([reads.quote(n), reads.allowance()])
  const dest: [Address, Address] = [deployment.usdc, deployment.merchant]
  const func: [Hex, Hex] = [
    encodeFunctionData({ abi: ABI.usdc, functionName: 'approve', args: [deployment.merchant, standing + price] }),
    encodeFunctionData({ abi: ABI.merchant, functionName: 'purchase', args: [n, price] }),
  ]
  return { credits: n, price, standing, dest, func, calls: decodeCalls(dest, func), readAt: Math.floor(Date.now() / 1000) }
}

/** Decodes each func entry with the ABI of its target, like owner-approve.mjs prints them. */
export function decodeCalls(dest: readonly Address[], func: readonly Hex[]): DecodedCall[] {
  return func.map((data, i) => {
    const contract = i === 0 ? 'mUSDC' : 'merchant'
    const abi = (i === 0 ? ABI.usdc : ABI.merchant) as Abi
    const d = decodeFunctionData({ abi, data })
    const item = abi.find((x) => x.type === 'function' && x.name === d.functionName) as { inputs?: { name?: string }[] } | undefined
    return {
      to: dest[i],
      contract,
      functionName: d.functionName,
      args: (d.args ?? []).map((v, j) => ({ name: item?.inputs?.[j]?.name || `arg${j}`, value: typeof v === 'bigint' ? v.toString() : String(v) })),
    }
  })
}

/** Every way the backend's ownerApproval can differ from the deployment file and the fresh rebuild. */
export function compareApproval(oa: OwnerApproval, request: Pick<PurchaseRequest, 'credits'>, deployment: Deployment, rebuilt: Rebuilt): Mismatch[] {
  const out: Mismatch[] = []
  const expect = (field: string, backend: unknown, chain: unknown, eq = lower(backend) === lower(chain)) => {
    if (!eq) out.push({ field, backend: show(backend), chain: show(chain) })
  }
  const args = (oa?.args ?? {}) as Partial<OwnerApproval['args']>
  expect('wallet', oa?.wallet, deployment.wallet)
  expect('function', oa?.function, 'executeBatch')
  expect('credits', request.credits, rebuilt.credits.toString())

  const dest = Array.isArray(args.dest) ? args.dest : []
  const func = Array.isArray(args.func) ? args.func : []
  const value = Array.isArray(args.value) ? args.value : null
  expect('args.dest length', dest.length, 2)
  expect('args.func length', func.length, 2)
  expect('args.value', value === null ? show(args.value) : `[${value.join(',')}]`, '[]')
  expect('args.dest[0] (mUSDC)', dest[0], deployment.usdc)
  expect('args.dest[1] (merchant)', dest[1], deployment.merchant)
  expect('args.func[0] approve calldata', func[0], rebuilt.func[0])
  expect('args.func[1] purchase calldata', func[1], rebuilt.func[1])

  expect('price', oa?.price?.base, rebuilt.price.toString())
  expect('standingAllowance', oa?.standingAllowance?.base, rebuilt.standing.toString())

  // The decoded summary the backend shows must say the same thing.
  const calls = Array.isArray(oa?.calls) ? oa.calls : []
  expect('calls length', calls.length, 2)
  const [approve, purchase] = calls as Partial<OwnerApproval['calls'][number]>[]
  expect('calls[0].to', approve?.to, deployment.usdc)
  expect('calls[0].function', approve?.function, 'approve')
  const aArgs = approve?.args as Partial<{ spender: string; value: Amount }> | undefined
  expect('calls[0].spender', aArgs?.spender, deployment.merchant)
  expect('calls[0].value', aArgs?.value?.base, (rebuilt.standing + rebuilt.price).toString())
  expect('calls[1].to', purchase?.to, deployment.merchant)
  expect('calls[1].function', purchase?.function, 'purchase')
  const pArgs = purchase?.args as Partial<{ credits: number; payment: Amount }> | undefined
  expect('calls[1].credits', pArgs?.credits, rebuilt.credits.toString())
  expect('calls[1].payment', pArgs?.payment?.base, rebuilt.price.toString())
  return out
}

/** Rebuild now and compare. The only path to a sign button. */
export async function checkApproval(reads: ApprovalReads, deployment: Deployment, request: PurchaseRequest): Promise<ApprovalCheck> {
  if (!request.ownerApproval) throw new Error('The backend sent no ownerApproval for this request.')
  const rebuilt = await rebuildFromChain(reads, deployment, request.credits)
  const mismatches = compareApproval(request.ownerApproval, request, deployment, rebuilt)
  return mismatches.length ? { ok: false, rebuilt, mismatches } : { ok: true, rebuilt }
}

/** Step 3: the owner's ceiling, typed in mUSDC. */
export function checkMaxPrice(price: bigint, maxText: string): { ok: true; max: bigint } | { ok: false; reason: string } {
  const max = parseMusdc(maxText)
  if (max === null) return { ok: false, reason: 'Enter a max price in mUSDC (up to 6 decimals).' }
  if (price > max) return { ok: false, reason: `The price ${amountText(price)} is above your max price ${amountText(max)}. Not approved.` }
  return { ok: true, max }
}

export const isApprovable = (r: PurchaseRequest) => (r.status === 'needs_owner_approval' || r.status === 'expired') && Boolean(r.ownerApproval)

/** Readable revert reason, like explainError in integration/lib.mjs (custom errors decoded with all three ABIs). */
export function explainError(err: unknown): string {
  return inert(explainRaw(err))
}

function explainRaw(err: unknown): string {
  const errorAbi = [...ABI.wallet, ...ABI.usdc, ...ABI.merchant] as Abi
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null
    if (reverted?.data) return `${reverted.data.errorName}(${(reverted.data.args ?? []).map(String).join(', ')})`
    if (reverted?.reason) return reverted.reason
    const raw = err.walk((e) => typeof (e as { data?: unknown }).data === 'string') as { data?: Hex } | null
    if (raw?.data && raw.data !== '0x') {
      try {
        const d = decodeErrorResult({ abi: errorAbi, data: raw.data })
        return `${d.errorName}(${(d.args ?? []).map(String).join(', ')})`
      } catch {
        // fall through to the short message
      }
    }
    const code = (err.walk((e) => typeof (e as { code?: unknown }).code === 'number') as { code?: number } | null)?.code
    if (code === 4001) return 'You rejected the transaction in the wallet. Nothing was sent.'
    return err.shortMessage
  }
  const e = err as { code?: number; message?: string }
  if (e?.code === 4001) return 'You rejected the transaction in the wallet. Nothing was sent.'
  return e?.message ?? String(err)
}

export type SendDeps = {
  publicClient: Pick<PublicClient, 'simulateContract' | 'waitForTransactionReceipt'>
  walletClient: Pick<WalletClient, 'writeContract'>
  owner: Address
  deployment: Deployment
}

/** Step 4a: simulate executeBatch(dest, [], func) from the owner. Throws with the decoded reason. */
export async function simulateApproval({ publicClient, owner, deployment }: Omit<SendDeps, 'walletClient'>, rebuilt: Rebuilt) {
  const { request } = await publicClient.simulateContract({
    account: owner,
    address: deployment.wallet,
    abi: ABI.wallet,
    functionName: 'executeBatch',
    args: [rebuilt.dest, [], rebuilt.func],
  })
  return request
}

/** Step 4b: send the simulated request with the owner's injected wallet. Resolves with the tx hash. */
export async function sendApproval({ walletClient }: Pick<SendDeps, 'walletClient'>, request: Awaited<ReturnType<typeof simulateApproval>>): Promise<Hash> {
  return walletClient.writeContract(request as Parameters<WalletClient['writeContract']>[0])
}

export async function waitForApproval({ publicClient }: Pick<SendDeps, 'publicClient'>, hash: Hash): Promise<TransactionReceipt> {
  return publicClient.waitForTransactionReceipt({ hash })
}
