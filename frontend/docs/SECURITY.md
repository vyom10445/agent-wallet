# Frontend security (P-3 Phase 11)

Run the whole suite with `npm test` (or only the security part with `npm run test:security`). It uses Vitest, a
mocked backend (`fetch`), a fake public RPC (viem `custom` transport) and a mocked EIP-1193 wallet. Nothing touches a
real chain. The secrets test builds the app itself (into a temporary folder), so it needs no prior `npm run build`.

## Open the app at http://localhost:5173 (CORS)

The backend allows exactly one browser origin, `FRONTEND_ORIGIN`, default `http://localhost:5173`, and it has **no
authentication** (it listens on 127.0.0.1 only).

- Open `http://localhost:5173`. `http://127.0.0.1:5173` is a different origin: every API call fails with a CORS error,
  and the app shows "Backend not reachable … open the app at http://localhost:5173 exactly".
- The dev server is pinned to `localhost:5173` with `strictPort`, so it never moves to 5174 (also a different origin).
- Never deploy this frontend publicly pointing at the backend, and never change `FRONTEND_ORIGIN` to `*`.
- The dev server serves only `frontend/`, `abi/` and `contracts/deployments/`. `backend/` (whose `.env` has the agent
  and submitter keys) is not reachable through it.

## Rules → tests

| Rule (P3_FRONTEND_PLAN.md) | Where it is tested | Notes |
|---|---|---|
| 1. Inspect before implementing | not testable | A process rule. Endpoints, fields and statuses come from `src/api/types.ts`, copied from BACKEND_API.md v1 and type-checked; `test/client.test.ts` checks every endpoint path. |
| 2. One phase at a time | not testable | A process rule. |
| 3. Backend API is frozen | `test/client.test.ts` | The client only calls the v1 endpoints. Nothing under `backend/` is changed by any phase. |
| 4. Contract is the authority; honest status | `security/display` §4, `test/requests.test.tsx`, `test/approval.test.tsx` | Paid only with `proofVerified === true`; needs_owner_approval is never "approved"; a "bought" reply shows the real status; a mined tx is success only after receipt + verify (owner approval) or receipt + event (owner controls). |
| 5. Owner signs only what they can read and check | `security/signing` §1–3, §7, `test/approval.test.tsx`, `test/ownerControls.test.tsx` | Rebuild from chain, byte-for-byte compare, refuse on any difference, no wallet prompt; the decoded calldata is what is sent. |
| 6. No private keys | `security/secrets` §8, `npm run scan:keys` | Bundle and src scanned; env files hold only `VITE_API_URL`; the wallet guard blocks eth_sign, personal_sign, eth_signTypedData*, eth_signTransaction (`test/wallet.test.tsx`). |
| 7. Backend and chain text is untrusted | `security/display` §5 | HTML, scripts, javascript: links, Markdown, right-to-left override and zero-width characters, 50 000-character strings and fake "approved" text are shown as inert text. |

## Suite items → tests

1. Calldata tampering (merchant, token, spender, approve amount, credits, price, extra call, wallet, ETH value):
   `security/signing.security.test.ts` §1. The mocked wallet never receives `eth_sendTransaction`, and the batch is not
   even simulated. The honest control case checks the one transaction that is sent.
2. Max price: §2, including a price that rose between the preview and the click.
3. Wrong chain / wrong account: §3. No wallet client at all; switching the account or network during the flow (or the
   startup checks failing) cancels before the wallet prompt, for approvals and owner controls.
4. Honest status: `security/display.security.test.tsx` §4.
5. Injection in text: §5.
6. Double actions: `security/signing` §6 (sign and verify go through `lib/singleFlight.ts`), `security/display` §6
   (chat reducer; `Chat.tsx` also guards the API call with `singleFlight`).
7. Backend or RPC down: `security/signing` §7 (502 RPC_ERROR, backend unreachable, public RPC down: refused, nothing
   signed; every run re-reads request and chain) and `security/display` §7 (offline and stale dashboard).
8. Secrets: `security/secrets.security.test.ts`.
9. CORS: `security/cors.security.test.ts` and this file.

## Fixes made while writing the suite

- **Switching account or network mid-flow did not cancel.** The flow kept the wallet client it started with. Now
  `flowGuard` (src/chain/wallet.ts) is checked before the simulation and right before the wallet prompt, in the
  approval flow and in owner controls.
- **Double click could send twice.** Retry verify, the tx-hash verify, decline, owner transactions and chat send relied
  on React state that updates one render later. They now go through `singleFlight` (a synchronous guard).
- **Right-to-left override and invisible characters were rendered as is.** HTML never ran (React text nodes), but
  U+202E could visually reorder text (for example a file name or an amount). `lib/text.ts` `inert()` now shows such
  characters as `[U+202E]` markers and clips text over 4 000 characters; it is applied to agent replies, reasons, error
  and revert strings, backend messages, check details and event args.

## Manual checks (Step 11.2)

During one owner approval, with the browser dev tools open:

1. Network tab: no request to the backend contains a signature. The wallet receives exactly one signing request,
   `eth_sendTransaction` for `executeBatch`, sent to the AgentWallet address.
2. In the MetaMask prompt: **to** is the AgentWallet `0x74cD…5c1A` (Base Sepolia), **value** is 0, and the data starts
   with the `executeBatch` selector. The amounts shown by the app match the decoded calls.
3. The app never asks you to sign a message (no `personal_sign` or typed-data prompt).
