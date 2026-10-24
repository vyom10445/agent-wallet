// Small inline icons (24×24 stroke paths), so the app needs no icon library or network request.
import type { SVGProps } from 'react'

const PATHS = {
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z M8.5 12h.01 M12 12h.01 M15.5 12h.01',
  dashboard: 'M4 4h7v9H4z M13 4h7v5h-7z M13 11h7v9h-7z M4 15h7v5H4z',
  requests: 'M8 6h12 M8 12h12 M8 18h12 M4 6h.01 M4 12h.01 M4 18h.01',
  approve: 'M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3Z M8.5 12l2.5 2.5 4.5-5',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  owner: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M4 21a8 8 0 0 1 16 0',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7l1-8Z',
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 18, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {PATHS[name].split(' M').map((d, i) => <path key={i} d={i === 0 ? d : `M${d}`} />)}
    </svg>
  )
}

/** The brand mark: a rounded square (the smart wallet) with a spark (the agent) inside. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="currentColor" />
      <path d="M17.4 6.5 10 17.4h5.2l-.9 8.1 7.5-11h-5.3l.9-8Z" fill="#fff" />
    </svg>
  )
}
