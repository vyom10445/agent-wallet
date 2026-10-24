// Readable text for every error code (docs/UI_SPEC.md §4). The backend's own message is shown under this text, as
// plain text. An unknown code falls back to a generic line, so a future code never breaks the page.
import type { HttpErrorCode, RequestErrorCode, Warning } from '../api/types'

/** Client-side codes for failures that never reached a backend response. */
export type ClientErrorCode = 'NETWORK' | 'TIMEOUT' | 'BAD_RESPONSE' | 'UNKNOWN_HTTP'

export const HTTP_ERROR_TEXT: Readonly<Record<HttpErrorCode | ClientErrorCode, string>> = {
  NETWORK:
    'Backend not reachable. Is npm start running in backend/? If it is, open the app at http://localhost:5173 exactly (CORS).',
  TIMEOUT: 'The backend did not answer in time. It may still be working; reload to see the result.',
  BAD_RESPONSE: 'The backend sent a response the app could not read.',
  UNKNOWN_HTTP: 'Unexpected response from the backend.',
  INVALID_INPUT: 'The request was not accepted.',
  NOT_FOUND: 'No such request (or endpoint).',
  WRONG_STATUS: "This request can't do that in its current status. Reload it.",
  BUSY: 'The agent is still working on the previous message. Try again in a moment.',
  TX_ALREADY_USED: 'That transaction already proved another request. Each purchase can fulfil only one request.',
  TX_NOT_FOUND: 'Transaction not found on this network yet. Check the hash and network, or wait for it to be mined.',
  TX_REVERTED: 'That transaction reverted, so nothing was bought.',
  NOT_OWNER_TX: 'That transaction was not the wallet owner calling executeBatch.',
  NO_PURCHASE_EVENT: 'That transaction did not buy credits for this wallet.',
  CREDITS_MISMATCH: 'That transaction bought a different number of credits than this request.',
  TX_TOO_OLD: "That transaction is older than this request, so it can't fulfil it.",
  RPC_ERROR: 'The backend could not read the chain. Try again in a few seconds.',
  LLM_ERROR: 'The agent could not answer (LLM and fallback both failed). Try again.',
  INTERNAL: 'The backend hit an internal error. Check the backend window.',
}

export const REQUEST_ERROR_TEXT: Readonly<Record<RequestErrorCode, string>> = {
  AA21: "The wallet's gas deposit is too low to pay for the agent's operation.",
  AA22: "The agent's operation was outside its time window (expired or not yet valid).",
  AA23: "The wallet rejected the agent's operation during validation.",
  AA24: 'The signature did not match an authorised signer.',
  AA25: 'Nonce conflict: another operation was in flight. Try again.',
  AA95: 'The operation ran out of gas.',
  ExceedsPerTxLimit: "Above the agent's per-purchase limit.",
  ExceedsDailyLimit: 'Above what the agent may still spend today.',
  RecipientNotAllowed: 'The merchant is not an allowed recipient for this agent.',
  CallNotAllowed: 'The agent is not allowed to call this function.',
  AgentNotValid: 'The agent is not valid (expired, not started or revoked).',
  NativeValueNotAllowed: 'The agent may not send ETH.',
  InvalidTokenCall: 'The token call was not a valid transfer or approval.',
  UnauthorizedCaller: 'The call did not come from the EntryPoint or the owner.',
  IncorrectPayment: "The payment did not match the merchant's price (the price may have changed).",
  ZeroCredits: "Zero credits can't be bought.",
  SafeERC20FailedOperation: 'The mUSDC transfer to the merchant failed.',
  ERC20InsufficientAllowance: 'The merchant allowance is too low.',
  ERC20InsufficientBalance: 'The wallet does not have enough mUSDC.',
  PRECHECK_BLOCKED: "Blocked by the agent's policy before sending (see the message).",
  SUBMITTER_LOW: "The backend's gas payer is out of ETH. Nothing was sent.",
  NO_PURCHASE_EVENT: 'The operation ran but no purchase was recorded, so it counts as failed.',
  CHAIN_MISMATCH: "The backend's chain did not match the expected network. Nothing was sent.",
  UNKNOWN: 'The transaction failed with an undecodable reason (raw data below).',
}

export const WARNING_TEXT: Readonly<Record<Warning, { tone: 'red' | 'yellow'; text: string }>> = {
  AGENT_NOT_VALID: { tone: 'red', text: 'The agent is not valid now (expired, not started or revoked). It cannot buy anything until the owner renews it.' },
  AGENT_EXPIRES_SOON: { tone: 'yellow', text: "The agent's permission ends in under 24 hours." },
  DEPOSIT_LOW: { tone: 'yellow', text: "The wallet's EntryPoint gas deposit is low. Agent purchases may fail with AA21 until it is topped up." },
  ALLOWANCE_LOW: { tone: 'yellow', text: 'The merchant allowance is below one maximum purchase. Larger purchases will need the owner.' },
  BALANCE_LOW: { tone: 'yellow', text: "The wallet's mUSDC balance is below one maximum purchase." },
  SUBMITTER_LOW: { tone: 'red', text: "The backend's gas payer is low on ETH. The agent cannot send purchases until it is funded." },
}

const has = <K extends string>(map: Readonly<Record<K, unknown>>, key: string): key is K => Object.hasOwn(map, key)

/** Text for an HTTP or client error code. */
export function httpErrorText(code: string, status?: number): string {
  if (has(HTTP_ERROR_TEXT, code)) return HTTP_ERROR_TEXT[code]
  return status ? `${HTTP_ERROR_TEXT.UNKNOWN_HTTP} (HTTP ${status}, ${code})` : `${HTTP_ERROR_TEXT.UNKNOWN_HTTP} (${code})`
}

/** Text for a code stored on a purchase request (PurchaseRequest.error.code). Unknown codes are shown raw. */
export function requestErrorText(code: string): string {
  return has(REQUEST_ERROR_TEXT, code) ? REQUEST_ERROR_TEXT[code] : code
}

/** Banner for a /wallet/status warning. Unknown values are shown as their raw code in grey. */
export function warningText(code: string): { tone: 'red' | 'yellow' | 'grey'; text: string } {
  return has(WARNING_TEXT, code) ? WARNING_TEXT[code] : { tone: 'grey', text: code }
}
