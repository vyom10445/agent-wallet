// "Something changed on chain, read the wallet again." Fired after a chat turn and after an owner approval or decline,
// so the dashboard updates spentToday and credits without a page reload.
const bus = new EventTarget()
const EVENT = 'wallet-refresh'

export function requestWalletRefresh() {
  bus.dispatchEvent(new Event(EVENT))
}

/** @returns an unsubscribe function */
export function onWalletRefresh(fn: () => void): () => void {
  bus.addEventListener(EVENT, fn)
  return () => bus.removeEventListener(EVENT, fn)
}
