// Off-chain policy pre-check: picks the path for a purchase before anything is signed or sent.
//
// ADVISORY ONLY. The contract still decides. A pre-check result is never permission to spend and never proof that
// a purchase happened: AGENT_OK only means "worth sending a UserOp"; success is proven only by
// UserOperationEvent.success + CreditsPurchased (agent path) or a verified owner tx (owner path).
// Every call reads fresh on-chain values at one block. Nothing here is cached.
import { MAX_CREDITS_PER_REQUEST } from "../chain/userop.js";
import { formatUsdc } from "../chain/reads.js";

export const PRECHECK = Object.freeze({
  AGENT_OK: "AGENT_OK",
  NEEDS_OWNER: "NEEDS_OWNER",
  NEEDS_OWNER_TOPUP: "NEEDS_OWNER_TOPUP",
  BLOCKED: "BLOCKED",
});

const usdc = (v) => `${formatUsdc(v)} mUSDC`;

/**
 * Pure decision from a state snapshot (all amounts bigint base units). Exported for unit tests.
 * Order: BLOCKED > NEEDS_OWNER > NEEDS_OWNER_TOPUP > AGENT_OK. `reasons` lists every failed rule, not just the first.
 */
export function evaluatePrecheck(s) {
  const reasons = [];
  const add = (code, message) => reasons.push({ code, message });

  if (!Number.isSafeInteger(s.credits) || s.credits < 1 || s.credits > MAX_CREDITS_PER_REQUEST) {
    add("INVALID_CREDITS", `credits must be an integer from 1 to ${MAX_CREDITS_PER_REQUEST}`);
    return { result: PRECHECK.BLOCKED, reasons };
  }
  // Agent and permissions: nothing the owner can approve per purchase fixes these.
  if (!s.agent.active) add("AGENT_NOT_ACTIVE", "The agent is not registered or was revoked.");
  else if (!s.agent.validNow) add("AGENT_NOT_VALID", "The agent is outside its validity window (expired or not yet valid).");
  if (s.agent.token.toLowerCase() !== s.usdc.toLowerCase()) add("WRONG_POLICY_TOKEN", "The agent's policy token is not mUSDC.");
  if (!s.agent.canPurchase) add("CALL_NOT_ALLOWED", "The agent may not call merchant.purchase.");
  if (!s.agent.merchantAllowed) add("RECIPIENT_NOT_ALLOWED", "The merchant is not an allowed recipient for this agent.");
  if (reasons.length) return { result: PRECHECK.BLOCKED, reasons };

  // Agent limits: the owner must sign this purchase instead.
  if (s.price > s.agent.maxPerTx) add("EXCEEDS_PER_TX", `Price ${usdc(s.price)} is above maxPerTx ${usdc(s.agent.maxPerTx)}.`);
  if (s.price > s.agent.remainingDailyAllowance) add("EXCEEDS_DAILY", `Price ${usdc(s.price)} is above the ${usdc(s.agent.remainingDailyAllowance)} left today (UTC).`);
  const overLimit = reasons.length > 0;

  // Funding: the owner must re-approve the merchant or fund the wallet.
  if (s.price > s.merchantAllowance) add("ALLOWANCE_TOO_LOW", `Merchant allowance ${usdc(s.merchantAllowance)} is below the price ${usdc(s.price)}.`);
  if (s.price > s.walletBalance) add("BALANCE_TOO_LOW", `Wallet balance ${usdc(s.walletBalance)} is below the price ${usdc(s.price)}.`);

  if (overLimit) return { result: PRECHECK.NEEDS_OWNER, reasons };
  if (reasons.length) return { result: PRECHECK.NEEDS_OWNER_TOPUP, reasons };
  return { result: PRECHECK.AGENT_OK, reasons };
}

/**
 * Reads the live state at the latest block and evaluates it.
 * @param reads  from createReads(config)
 * @param intent { credits }
 * @param agent  agent address (default: the configured agent)
 */
export async function precheck(reads, intent, { agent } = {}) {
  const credits = intent?.credits;
  if (!Number.isSafeInteger(credits) || credits < 1 || credits > MAX_CREDITS_PER_REQUEST) {
    return Object.freeze({ advisory: true, credits: credits ?? null, price: null, blockNumber: null, state: null, ...evaluatePrecheck({ credits }) });
  }
  const b = await reads.client.getBlockNumber({ cacheTime: 0 }); // fresh head, never a cached block number
  const [price, info, validNow, remaining, canPurchase, merchantAllowed, merchantAllowance, walletBalance] = await Promise.all([
    reads.quote(credits, b),
    reads.getAgent(agent, b),
    reads.isAgentValid(agent, b),
    reads.remainingDailyAllowance(agent, b),
    reads.isCallAllowed(agent, b),
    reads.isRecipientAllowed(agent, b),
    reads.merchantAllowance(b),
    reads.walletBalance(b),
  ]);
  const state = {
    credits,
    price,
    usdc: reads.addresses.usdc,
    agent: { active: info.active, validNow, token: info.token, maxPerTx: info.maxPerTx, remainingDailyAllowance: remaining, canPurchase, merchantAllowed },
    merchantAllowance,
    walletBalance,
  };
  return Object.freeze({ advisory: true, credits, price, blockNumber: b, state, ...evaluatePrecheck(state) });
}
