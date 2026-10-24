// Hash routes, so links work without a router or server config: #/dashboard, #/chat, #/approve/<requestId>.
export type Route = { tab: 'dashboard' } | { tab: 'chat' } | { tab: 'approve'; requestId: string | null }

const REQUEST_ID = /^req_[0-9a-f]{16}$/

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/')
  if (parts[0] === 'approve') return { tab: 'approve', requestId: REQUEST_ID.test(parts[1] ?? '') ? parts[1] : null }
  if (parts[0] === 'dashboard') return { tab: 'dashboard' }
  return { tab: 'chat' }
}

export const approvalHref = (requestId: string) => `#/approve/${requestId}`
