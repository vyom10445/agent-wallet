// One action at a time, decided synchronously: a double click (two events before React re-renders the disabled
// button) can never start the action twice. Used for sign, verify, decline, owner transactions and chat send.
export function singleFlight() {
  let running = false
  return {
    get running() {
      return running
    },
    /** Runs fn unless one is already running; resolves undefined when the call was dropped. */
    async run<T>(fn: () => Promise<T>): Promise<T | undefined> {
      if (running) return undefined
      running = true
      try {
        return await fn()
      } finally {
        running = false
      }
    },
  }
}
