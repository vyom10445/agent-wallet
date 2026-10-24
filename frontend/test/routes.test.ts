import { describe, expect, it } from 'vitest'
import { approvalHref, parseRoute } from '../src/lib/routes'

describe('routes', () => {
  it('parses tabs and approval links', () => {
    expect(parseRoute('')).toEqual({ tab: 'chat' })
    expect(parseRoute('#/dashboard')).toEqual({ tab: 'dashboard' })
    expect(parseRoute(approvalHref('req_3f9a0c1b7d2e4a65'))).toEqual({ tab: 'approve', requestId: 'req_3f9a0c1b7d2e4a65' })
    expect(parseRoute('#/approve/<script>')).toEqual({ tab: 'approve', requestId: null })
  })
})

describe('request routes', () => {
  it('parses the requests list and detail', async () => {
    const { requestHref } = await import('../src/lib/routes')
    expect(parseRoute('#/requests')).toEqual({ tab: 'requests', requestId: null })
    expect(parseRoute(requestHref('req_3f9a0c1b7d2e4a65'))).toEqual({ tab: 'requests', requestId: 'req_3f9a0c1b7d2e4a65' })
    expect(parseRoute('#/requests/../../x')).toEqual({ tab: 'requests', requestId: null })
  })
})
