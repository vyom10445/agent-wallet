// Security suite, CORS (P3 plan Phase 11, item 9; Facts 9 and 10). The backend allows exactly one origin,
// FRONTEND_ORIGIN = http://localhost:5173, and has no authentication. These tests pin the dev server to that origin and
// check that the app tells the user so when the backend cannot be reached. See docs/SECURITY.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import config from '../../vite.config'
import { HTTP_ERROR_TEXT } from '../../src/lib/messages'

const root = fileURLToPath(new URL('../..', import.meta.url))

describe('9. the app runs at http://localhost:5173 only', () => {
  it('dev server and preview are pinned to localhost:5173 and never fall back to another port', () => {
    const c = config as { server: { host: string; port: number; strictPort: boolean }; preview: { host: string; port: number; strictPort: boolean } }
    for (const s of [c.server, c.preview]) expect(s).toMatchObject({ host: 'localhost', port: 5173, strictPort: true })
  })

  it('the dev server serves nothing from backend/ (only frontend/, abi/ and contracts/deployments/)', () => {
    const allow = (config as { server: { fs: { allow: string[] } } }).server.fs.allow.map((p) => p.replace(/\\/g, '/'))
    expect(allow).toHaveLength(3)
    expect(allow.some((p) => p.includes('backend'))).toBe(false)
  })

  it('a failed call says to open http://localhost:5173 exactly', () => {
    expect(HTTP_ERROR_TEXT.NETWORK).toContain('http://localhost:5173')
  })

  it('the backend URL is the local one and the doc explains the rule', () => {
    expect(readFileSync(`${root}.env.example`, 'utf8')).toMatch(/^VITE_API_URL=http:\/\/127\.0\.0\.1:8787$/m)
    const doc = readFileSync(`${root}docs/SECURITY.md`, 'utf8')
    expect(doc).toContain('http://localhost:5173')
    expect(doc).toContain('127.0.0.1:5173')
  })
})
