// Response types for the backend API v1 (backend/docs/BACKEND_API.md, plus the additive fields in
// backend/docs/BACKEND_FINAL.md §3). Copied from docs/UI_SPEC.md §6; change both together.

export type Amount = { base: string; mUSDC: string }
export type Wei = string
export type Address = `0x${string}`
export type Hash = `0x${string}`

export type Status =
  | 'received' | 'precheck_failed' | 'submitted' | 'succeeded' | 'failed_onchain'
  | 'needs_owner_approval' | 'fulfilled_by_owner' | 'rejected' | 'expired'
export type Precheck = 'AGENT_OK' | 'NEEDS_OWNER' | 'NEEDS_OWNER_TOPUP' | 'BLOCKED'

export type HttpErrorCode =
  | 'INVALID_INPUT' | 'NOT_FOUND' | 'WRONG_STATUS' | 'BUSY' | 'TX_ALREADY_USED'
  | 'TX_NOT_FOUND' | 'TX_REVERTED' | 'NOT_OWNER_TX' | 'NO_PURCHASE_EVENT' | 'CREDITS_MISMATCH' | 'TX_TOO_OLD'
  | 'RPC_ERROR' | 'LLM_ERROR' | 'INTERNAL'
export type RequestErrorCode =
  | 'AA21' | 'AA22' | 'AA23' | 'AA24' | 'AA25' | 'AA95'
  | 'ExceedsPerTxLimit' | 'ExceedsDailyLimit' | 'RecipientNotAllowed' | 'CallNotAllowed' | 'AgentNotValid'
  | 'NativeValueNotAllowed' | 'InvalidTokenCall' | 'UnauthorizedCaller'
  | 'IncorrectPayment' | 'ZeroCredits' | 'SafeERC20FailedOperation'
  | 'ERC20InsufficientAllowance' | 'ERC20InsufficientBalance'
  | 'PRECHECK_BLOCKED' | 'SUBMITTER_LOW' | 'NO_PURCHASE_EVENT' | 'CHAIN_MISMATCH' | 'UNKNOWN'

export type VerifyCheckName =
  | 'request_status' | 'tx_unused' | 'receipt_success' | 'owner_authorized' | 'credits_purchased' | 'after_request'
export type Check = { name: string; ok: boolean; detail?: string }

// details.checks is present on verify failures
export type ErrorBody = { error: { code: HttpErrorCode | string; message: string; details?: { checks?: Check[] } & Record<string, unknown> } }

// 4.1
export type Health = {
  ok: boolean; apiVersion: string; chainId: number; wallet: Address; agent: Address
  llm: 'available' | 'fallback'; dbPath: string
  events?: { indexedToBlock: number | null; lastError: string | null; polling: boolean }  // additive (Phase 10)
}

// 4.2
export type ChatRequest = { message: string; conversationId?: string }
export type ToolCall = {
  name: 'get_wallet_status' | 'quote_credits' | 'buy_credits' | 'list_requests'
  args: Record<string, unknown>
  result: { requestId?: string; status?: Status } & Record<string, unknown>
}
export type ChatResponse = {
  conversationId: string; reply: string; requestIds: string[]; toolCalls: ToolCall[]; planner: 'llm' | 'fallback'
}

// 4.3
export type ChatMessage = { id: number; role: 'user' | 'assistant'; content: string; requestId: string | null; createdAt: number }
export type MessagesResponse = { conversationId: string; messages: ChatMessage[] }

// 4.4 / 4.5
export type OwnerApproval = {
  wallet: Address
  function: 'executeBatch'
  price: Amount
  standingAllowance: Amount
  args: { dest: [Address, Address]; value: []; func: [Hash, Hash] }
  calls: [
    { to: Address; function: 'approve'; args: { spender: Address; value: Amount } },
    { to: Address; function: 'purchase'; args: { credits: number; payment: Amount } },
  ]
  signWith: string
  readAt: number
}
export type PurchaseRequest = {
  id: string
  status: Status
  path: 'agent' | 'owner' | null
  precheck: Precheck | null
  credits: number
  reason: string | null                 // untrusted
  price: Amount | null
  amountPaid: Amount | null
  purchaseId: string | null
  agent: Address
  nonce: string | null
  userOpHash: Hash | null
  txHash: Hash | null
  blockNumber: number | null
  actualGasCost: Wei | null
  error: { code: RequestErrorCode | string; message: string | null } | null
  explorerUrl: string | null            // null on Anvil
  conversationId: string | null
  expiresAt: number | null
  createdAt: number
  updatedAt: number
  ownerApproval?: OwnerApproval         // GET /requests/:id, needs_owner_approval or expired only
  proofVerified?: boolean | null        // additive (Phase 9): paid statuses only
  proofChecks?: Check[]                 // additive (Phase 9): GET /requests/:id only, when freshly checked
}
export type RequestsQuery = { status?: Status[]; limit?: number; before?: number }
export type RequestsResponse = { requests: PurchaseRequest[] }

// 4.6
export type VerifyRequest = { txHash: Hash }
export type VerifyResponse = {
  request: Pick<PurchaseRequest, 'id' | 'status' | 'txHash' | 'purchaseId' | 'amountPaid'> & Partial<PurchaseRequest>
  checks: { name: VerifyCheckName; ok: boolean }[]
}

// 4.7
export type RejectRequest = { note?: string }
export type RejectResponse = { request: PurchaseRequest }

// 4.8
export type Warning = 'AGENT_NOT_VALID' | 'AGENT_EXPIRES_SOON' | 'DEPOSIT_LOW' | 'ALLOWANCE_LOW' | 'BALANCE_LOW' | 'SUBMITTER_LOW'
export type WalletStatus = {
  chainId: number; blockNumber: number; readAt: number
  addresses: { wallet: Address; owner: Address; entryPoint: Address; usdc: Address; merchant: Address; agent: Address }
  agent: {
    active: boolean; validNow: boolean
    validAfter: number; validUntil: number; validUntilIso: string
    token: Address
    maxPerTx: Amount; dailyLimit: Amount; spentToday: Amount; remainingDailyAllowance: Amount
    canPurchase: boolean; merchantAllowed: boolean
    nonceKey: string; nextNonce: string
  }
  wallet: { balance: Amount; merchantAllowance: Amount; entryPointDeposit: Wei; credits: number }
  merchant: { pricePerCredit: Amount; purchaseCount: number }
  submitter: { address: Address; ethBalance: Wei }
  warnings: (Warning | string)[]
}

// 4.9
export type EventType =
  | 'AgentSpent' | 'AgentExecuted' | 'AgentRevoked' | 'PolicySet'
  | 'CreditsPurchased' | 'UserOperationEvent' | 'UserOperationRevertReason'
type EventBase<T extends EventType, A> = {
  type: T; emitter: 'wallet' | 'merchant' | 'entryPoint'
  blockNumber: number; timestamp: number | null; txHash: Hash; logIndex: number
  label: 'agent' | 'owner' | 'other'; requestId: string | null
  args: A
}
export type ChainEvent =
  | EventBase<'AgentSpent', { agent: Address; token: Address; recipient: Address; amount: Amount; spentToday: Amount }>
  | EventBase<'AgentExecuted', { agent: Address; target: Address; selector: string; value: string }>
  | EventBase<'AgentRevoked', { agent: Address }>
  | EventBase<'PolicySet', { agent: Address; token: Address; maxPerTx: Amount; dailyLimit: Amount }>
  | EventBase<'CreditsPurchased', { purchaseId: string; buyer: Address; credits: string; amountPaid: Amount }>
  | EventBase<'UserOperationEvent', { userOpHash: Hash; sender: Address; paymaster: Address; nonce: string; nonceKey: string;
      nonceSequence: string; success: boolean; actualGasCost: string; actualGasUsed: string }>
  | EventBase<'UserOperationRevertReason', { userOpHash: Hash; sender: Address; nonce: string; nonceKey: string;
      nonceSequence: string; revertReason: string; reason: string | null }>
export type EventsQuery = { type?: EventType[]; limit?: number; before?: number }
export type EventsResponse = { fromBlock: number | null; toBlock: number | null; indexedToBlock: number | null; events: ChainEvent[] }

// Runtime lists of the closed value sets above (BACKEND_API.md §3, §4.8, §4.9).
export const STATUSES: readonly Status[] = [
  'received', 'precheck_failed', 'submitted', 'succeeded', 'failed_onchain',
  'needs_owner_approval', 'fulfilled_by_owner', 'rejected', 'expired',
]
export const EVENT_TYPES: readonly EventType[] = [
  'AgentSpent', 'AgentExecuted', 'AgentRevoked', 'PolicySet',
  'CreditsPurchased', 'UserOperationEvent', 'UserOperationRevertReason',
]
export const WARNINGS: readonly Warning[] = [
  'AGENT_NOT_VALID', 'AGENT_EXPIRES_SOON', 'DEPOSIT_LOW', 'ALLOWANCE_LOW', 'BALANCE_LOW', 'SUBMITTER_LOW',
]
