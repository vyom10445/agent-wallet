// Deterministic fallback planner: used when LLM_PROVIDER=none or the LLM API fails.
// Maps a message to at most one tool call with simple regexes (BACKEND_API.md §6). No model involved.

const ADDRESS = /0x[0-9a-fA-F]{40}/;
// Things the agent can never do; a message asking for them gets a refusal and no tool call.
const FORBIDDEN = /\b(ignore|bypass|override|disable)\b.*\b(limit|rule|polic|instruction)|\b(raise|increase|change|set|remove|lift)\b.*\b(limit|polic|allowance|maxPerTx|daily)|\b(send|transfer|withdraw|drain)\b.*\b(usdc|musdc|funds?|tokens?|eth|money|balance)|\b(approve|sign)\b.*\b(request|purchase|myself|own)|\b(add|revoke)\b.*\bagent\b/i;

export const REFUSAL =
  "I can't do that. I can only check the wallet status, quote prices, buy API credits within the owner's on-chain limits, and list requests. I can't change limits, move funds to other addresses, approve requests or change my own permissions; only the wallet owner can, with their own wallet.";
export const HELP = 'I can help with API credits. Try "buy 50 credits", "price of 200 credits", "status" or "show my requests".';

/** @returns {{ kind: "tool", name, input } | { kind: "reply", text }} */
export function planFallback(message) {
  const text = String(message ?? "");
  if (ADDRESS.test(text) || FORBIDDEN.test(text)) return { kind: "reply", text: REFUSAL };
  let m;
  if ((m = /\b(?:buy|purchase|get)\s+(\d{1,6})\s+(?:api\s+)?credits?\b/i.exec(text))) {
    return { kind: "tool", name: "buy_credits", input: { credits: Number(m[1]), reason: "User asked to buy credits (fallback planner)" } };
  }
  if ((m = /\b(?:price|quote|cost)\b.*?(\d{1,6})/i.exec(text)) || (m = /(\d{1,6})\s+(?:api\s+)?credits?\b.*\b(?:cost|price)/i.exec(text))) {
    return { kind: "tool", name: "quote_credits", input: { credits: Number(m[1]) } };
  }
  if (/\b(requests?|history|orders?)\b/i.test(text)) return { kind: "tool", name: "list_requests", input: { limit: 10 } };
  if (/\b(status|balance|limits?|wallet|remaining)\b/i.test(text)) return { kind: "tool", name: "get_wallet_status", input: {} };
  return { kind: "reply", text: HELP };
}
