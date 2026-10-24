// Security suite, secrets (P3 plan Phase 11, item 8 and Rule 6): build the app the way `npm run build` does (into a
// temporary folder, so the real dist/ is untouched), then search the bundle and src/ for anything that looks like a key.
// Only public addresses and hashes may appear. The built-in check is also available as `npm run scan:keys`.
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { beforeAll, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))
const walk = (dir: string, out: string[] = []): string[] => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/** 0x + 64 hex (or 64 bare hex) with "key" within 40 characters before or after it. */
const KEY_NEAR_HEX = /key[\s\S]{0,40}?\b(?:0x)?[0-9a-fA-F]{64}\b|\b(?:0x)?[0-9a-fA-F]{64}\b[\s\S]{0,40}?key/gi
const NAMED_SECRETS = /PRIVATE_KEY|OWNER_PRIVATE|AGENT_PRIVATE|SUBMITTER_PRIVATE|LLM_API_KEY|seed phrase|\bmnemonic\b|BEGIN (?:EC |RSA )?PRIVATE KEY/gi
// 12 or 24 lowercase words in a row inside one string literal, the shape of a BIP-39 phrase.
const PHRASE = /["'`](?:[a-z]{3,8} ){11}[a-z]{3,8}(?: [a-z]{3,8}){0,12}["'`]/g

function findings(files: string[]) {
  const out: string[] = []
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    for (const m of text.matchAll(KEY_NEAR_HEX)) out.push(`${relative(root, f)}: key next to 64 hex digits: ${m[0].slice(0, 120)}`)
    for (const m of text.matchAll(NAMED_SECRETS)) out.push(`${relative(root, f)}: ${m[0]}`)
    for (const m of text.matchAll(PHRASE)) out.push(`${relative(root, f)}: word sequence like a seed phrase: ${m[0].slice(0, 60)}`)
  }
  return out
}

let distFiles: string[] = []

beforeAll(async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'agent-wallet-dist-'))
  await build({ root, logLevel: 'silent', build: { outDir, emptyOutDir: true } })
  distFiles = walk(outDir).filter((f) => /\.(js|html|css|map)$/.test(f))
}, 120_000)

describe('8. no secrets in the bundle or the source', () => {
  it('the production bundle was built', () => {
    expect(distFiles.some((f) => f.endsWith('.js'))).toBe(true)
  })

  it('dist/: no key next to 64 hex digits, no key env names, no seed phrases', () => {
    expect(findings(distFiles)).toEqual([])
  })

  it('src/: the same, and no key or mnemonic APIs', () => {
    const src = walk(join(root, 'src')).filter((f) => /\.(ts|tsx|js|jsx|css|html|json)$/.test(f))
    expect(findings(src)).toEqual([])
    // Key and mnemonic APIs, and calls to off-chain signing (the method names themselves appear only in the deny list in
    // src/chain/wallet.ts, which blocks them).
    const apis = /privateKeyToAccount|mnemonicToAccount|hdKeyToAccount|generatePrivateKey|generateMnemonic|viem\/accounts|\.(?:signMessage|signTypedData|signTransaction)\(/
    expect(src.filter((f) => apis.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f))).toEqual([])
  })

  it('env files hold only VITE_API_URL (the only variable the app reads)', () => {
    for (const name of ['.env', '.env.local', '.env.example', '.env.development', '.env.production']) {
      const p = join(root, name)
      if (!existsSync(p)) continue
      const keys = readFileSync(p, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split('=')[0].trim())
      expect(keys.filter((k) => k !== 'VITE_API_URL'), name).toEqual([])
    }
  })

  it('the patterns do catch a planted key (self-check)', () => {
    const planted = join(mkdtempSync(join(tmpdir(), 'plant-')), 'x.js')
    const fs = { write: (p: string, t: string) => import('node:fs').then((m) => m.writeFileSync(p, t)) }
    return fs.write(planted, `const ownerKey = "0x${'4c'.repeat(32)}"; // PRIVATE_KEY\nconst s = "abandon ability able about above absent absorb abstract absurd abuse access accident"`).then(() => {
      expect(findings([planted])).toHaveLength(3)
    })
  })
})
