// Server start-up for the database: open, apply the schema, resolve `submitted` rows from the chain,
// and expire overdue owner approvals. Call once before serving requests.
import { openDb, createStore } from "./store.js";
import { resolveSubmitted } from "./recovery.js";

export { openDb, createStore, STATUSES, TRANSITIONS, TransitionError, SecretLeakError } from "./store.js";
export { resolveSubmitted } from "./recovery.js";

export async function startStore(config, reads, { dbPath = config.dbPath } = {}) {
  const store = createStore(openDb(dbPath));
  const recovered = await resolveSubmitted(store, reads);
  const expired = store.expireDue();
  return { store, recovered, expired };
}
