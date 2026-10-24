import { describe, expect, it } from 'vitest'
import type { HttpErrorCode, RequestErrorCode } from '../src/api/types'
import { WARNINGS } from '../src/api/types'
import { HTTP_ERROR_TEXT, REQUEST_ERROR_TEXT, httpErrorText, requestErrorText, warningText } from '../src/lib/messages'

// Every code in BACKEND_API.md v1 (HTTP table and stored error_code table) plus the additive CHAIN_MISMATCH.
const HTTP: HttpErrorCode[] = [
  'INVALID_INPUT', 'NOT_FOUND', 'WRONG_STATUS', 'BUSY', 'TX_ALREADY_USED', 'TX_NOT_FOUND', 'TX_REVERTED',
  'NOT_OWNER_TX', 'NO_PURCHASE_EVENT', 'CREDITS_MISMATCH', 'TX_TOO_OLD', 'RPC_ERROR', 'LLM_ERROR', 'INTERNAL',
]
const STORED: RequestErrorCode[] = [
  'AA21', 'AA22', 'AA23', 'AA24', 'AA25', 'AA95', 'ExceedsPerTxLimit', 'ExceedsDailyLimit', 'RecipientNotAllowed',
  'CallNotAllowed', 'AgentNotValid', 'NativeValueNotAllowed', 'InvalidTokenCall', 'UnauthorizedCaller',
  'IncorrectPayment', 'ZeroCredits', 'SafeERC20FailedOperation', 'ERC20InsufficientAllowance',
  'ERC20InsufficientBalance', 'PRECHECK_BLOCKED', 'SUBMITTER_LOW', 'NO_PURCHASE_EVENT', 'CHAIN_MISMATCH', 'UNKNOWN',
]

describe('error text', () => {
  it('has a message for every HTTP error code', () => {
    for (const code of HTTP) expect(httpErrorText(code).length, code).toBeGreaterThan(10)
    expect(Object.keys(HTTP_ERROR_TEXT).sort()).toEqual([...HTTP, 'NETWORK', 'TIMEOUT', 'BAD_RESPONSE', 'UNKNOWN_HTTP'].sort())
  })

  it('has a message for every stored request error code', () => {
    for (const code of STORED) expect(requestErrorText(code)).not.toBe(code)
    expect(Object.keys(REQUEST_ERROR_TEXT).sort()).toEqual([...STORED].sort())
  })

  it('shows unknown codes raw instead of failing', () => {
    expect(requestErrorText('SomethingNew')).toBe('SomethingNew')
    expect(httpErrorText('NEW_CODE', 499)).toContain('NEW_CODE')
    expect(requestErrorText('toString')).toBe('toString')
  })

  it('has a banner for every warning, and grey for unknown ones', () => {
    for (const w of WARNINGS) expect(['red', 'yellow']).toContain(warningText(w).tone)
    expect(warningText('NEW_WARNING')).toEqual({ tone: 'grey', text: 'Backend warning NEW_WARNING', fix: null })
  })
})
