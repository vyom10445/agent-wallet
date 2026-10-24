// Untrusted text (agent replies, reason, revert strings, event args, backend messages) is always a React text node,
// so HTML never runs. This also makes it unable to *hide or reorder* content: bidirectional controls (e.g. U+202E
// right-to-left override) and invisible characters are shown as visible [U+XXXX] markers, and very long strings are
// clipped with a note. Nothing is ever parsed as HTML or Markdown.
export const MAX_TEXT = 4000

// Bidi embeddings/overrides/isolates, marks, zero-width characters, BOM, and other format characters that are invisible.
const INVISIBLE = new RegExp('[\\u202A-\\u202E\\u2066-\\u2069\\u200B-\\u200F\\u061C\\u2028\\u2029\\u2060-\\u2064\\uFEFF\\u00AD\\u180E]', 'g')

const marker = (c: string) => `[U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}]`

export function inert(value: unknown, max = MAX_TEXT): string {
  const s = value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value)
  const visible = s.replace(INVISIBLE, marker)
  if (visible.length <= max) return visible
  return `${visible.slice(0, max)}… (${visible.length - max} more characters not shown)`
}

/** Same as inert, but keeps null/undefined so "—" fallbacks still work. */
export const inertOrNull = (value: string | null | undefined, max = MAX_TEXT) => (value === null || value === undefined ? null : inert(value, max))
