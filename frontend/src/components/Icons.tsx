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

/** The brand mark: a hexagon (the smart wallet) with a spark (the agent) inside. */
export function Logo({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <defs>
        <linearGradient id="aw-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="0.55" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#ec4899" />
        </linearGradient>
      </defs>
      <path d="M20 2.5 35.2 11.25v17.5L20 37.5 4.8 28.75v-17.5Z" fill="rgba(139,92,246,0.14)" stroke="url(#aw-grad)" strokeWidth="2.2" strokeLinejoin="round" />
      <path d="M21.6 9.5 13.5 21.5h5.8l-1 9 8.2-12.2h-5.9l1-8.8Z" fill="url(#aw-grad)" />
    </svg>
  )
}
