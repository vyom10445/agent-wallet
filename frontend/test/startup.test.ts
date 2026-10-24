import { describe, expect, it } from 'vitest'
import { createApiClient } from '../src/api/client'
import { compareAddresses, runStartupChecks } from '../src/lib/startup'
import { AGENT, BOOK, health, mockFetch, walletStatus } from './helpers/fixtures'

const api = (routes: Parameters<typeof mockFetch>[0]) => createApiClient({ baseUrl: 'http://127.0.0.1:8787', fetch: mockFetch(routes).fetch })
const OTHER = '0x0000000000000000000000000000000000000001'

describe('compareAddresses', () => {
  it('matches the real deployment file, ignoring checksum case', () => {
    const status = walletStatus({ wallet: BOOK.wallet.toLowerCase() as `0x${string}` })
    expect(compareAddresses(health(), status, BOOK)).toEqual([])
  })

  it.each(['wallet', 'owner', 'entryPoint', 'usdc', 'merchant'] as const)('flags a different %s', (key) => {
    const m = compareAddresses(health(), walletStatus({ [key]: OTHER }), BOOK)
    expect(m).toEqual([{ field: `addresses.${key}`, backend: OTHER, file: BOOK[key] }])
  })

  it('flags /health wallet, chain id and agent disagreements', () => {
    expect(compareAddresses(health({ wallet: OTHER }), walletStatus(), BOOK).map((m) => m.field)).toEqual(['health.wallet'])
    expect(compareAddresses(health({ chainId: 31337 }), walletStatus(), BOOK).map((m) => m.field)).toContain('chainId')
    expect(compareAddresses(health(), walletStatus({ agent: OTHER }), BOOK).map((m) => m.field)).toEqual(['addresses.agent (vs /health agent)'])
  })

  it('flags an edited address book (the manual acceptance check)', () => {
    const edited = { ...BOOK, merchant: OTHER as `0x${string}` }
    expect(compareAddresses(health(), walletStatus(), edited).map((m) => m.field)).toEqual(['addresses.merchant'])
  })
})

describe('runStartupChecks', () => {
  it('is ready with approval allowed when everything matches', async () => {
    const s = await runStartupChecks(api({ '/health': [200, health()], '/wallet/status': [200, walletStatus()] }))
    expect(s.phase).toBe('ready')
    if (s.phase !== 'ready') return
    expect(s.deployment.wallet).toBe(BOOK.wallet)
    expect(s.health.agent).toBe(AGENT)
    expect(s.approvalAllowed).toBe(true)
  })

  it('disables approval on any mismatch', async () => {
    const s = await runStartupChecks(api({ '/health': [200, health()], '/wallet/status': [200, walletStatus({ owner: OTHER })] }))
    expect(s.phase === 'ready' && !s.approvalAllowed && s.mismatches.length === 1).toBe(true)
  })

  it('says "backend not reachable" when the backend is down', async () => {
    const down = createApiClient({ baseUrl: 'http://127.0.0.1:8787', fetch: async () => { throw new TypeError('Failed to fetch') } })
    const s = await runStartupChecks(down)
    expect(s.phase).toBe('unreachable')
    expect(s.phase === 'unreachable' && s.message).toMatch(/^Backend not reachable.*127\.0\.0\.1:8787/)
  })

  it('refuses another API version, ok: false and an unknown chain', async () => {
    const v2 = await runStartupChecks(api({ '/health': [200, health({ apiVersion: '2' })] }))
    expect(v2.phase === 'error' && v2.message).toContain('version 2')
    const notOk = await runStartupChecks(api({ '/health': [200, health({ ok: false })] }))
    expect(notOk.phase).toBe('error')
    const unknown = await runStartupChecks(api({ '/health': [200, health({ chainId: 1 })] }))
    expect(unknown.phase === 'error' && unknown.message).toContain('No address book for chain 1')
  })

  it('reports a failing /wallet/status (RPC_ERROR) as an error, not ready', async () => {
    const s = await runStartupChecks(api({ '/health': [200, health()], '/wallet/status': [502, { error: { code: 'RPC_ERROR', message: 'Chain read failed' } }] }))
    expect(s.phase === 'error' && s.message).toContain('could not read the chain')
  })
})
