// Hash routes, so links work without a router or server config:
// #/chat, #/dashboard, #/requests, #/requests/<requestId>, #/approve/<requestId>, #/activity, #/owner.
export type Route =
  | { tab: 'dashboard' }
  | { tab: 'chat' }
  | { tab: 'requests'; requestId: string | null }
  | { tab: 'approve'; requestId: string | null }
  | { tab: 'activity' }
  | { tab: 'owner' }

const REQUEST_ID = /^req_[0-9a-f]{16}$/

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/')
  if (parts[0] === 'approve') return { tab: 'approve', requestId: REQUEST_ID.test(parts[1] ?? '') ? parts[1] : null }
  if (parts[0] === 'requests') return { tab: 'requests', requestId: REQUEST_ID.test(parts[1] ?? '') ? parts[1] : null }
  if (parts[0] === 'dashboard') return { tab: 'dashboard' }
  if (parts[0] === 'activity') return { tab: 'activity' }
  if (parts[0] === 'owner') return { tab: 'owner' }
  return { tab: 'chat' }
}

export const approvalHref = (requestId: string) => `#/approve/${requestId}`
export const requestHref = (requestId: string) => `#/requests/${requestId}`
