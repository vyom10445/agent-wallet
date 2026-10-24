// H12 go/no-go: drives the running backend through POST /agent/chat and checks every stage independently on chain.
//   1. buy 10 credits  -> must be a real ERC-4337 purchase: handleOps tx to the EntryPoint, UserOperationEvent.success,
//                         CreditsPurchased for the wallet, spentToday up by exactly quote(10)
//   2. buy 500 credits -> must be needs_owner_approval with no transaction sent
// Read-only on its own: it uses no keys. Start the backend first (npm start), then: npm run h12
// Env (backend/.env): CHAIN_ID, RPC_URL, PORT. Optional BACKEND_URL, H12_CREDITS (10), H12_OVER_LIMIT (500).
import { createPublicClient, http, parseEventLogs, decodeFunctionData, formatUnits } from "viem";
import { loadDeployment, abi, allAbi, SUPPORTED_CHAINS } from "../src/config.js";

const chainId = Number(process.env.CHAIN_ID || 84532);
const BASE = process.env.BACKEND_URL || `http://127.0.0.1:${process.env.PORT || 8787}`;
const CREDITS = Number(process.env.H12_CREDITS || 10);
const OVER = Number(process.env.H12_OVER_LIMIT || 500);
const EXPLORER = { 84532: "https://sepolia.basescan.org/tx/" }[chainId];
const a = loadDeployment(chainId);
const client = createPublicClient({ chain: SUPPORTED_CHAINS[chainId], transport: http(process.env.RPC_URL || undefined) });
const m = (v) => `${formatUnits(BigInt(v), 6)} mUSDC`;

const results = [];
let stage = 0;
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  return ok;
}
const head = (title) => console.log(`\n[${++stage}] ${title}`);

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new Error(`Backend not reachable at ${BASE} (${e.cause?.code ?? e.message}). Start it with: npm start`);
  }
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status} ${json.error?.code}: ${json.error?.message}`);
  return json;
}

const HINTS = {
  "backend health": "Is `npm start` running in another window with the same CHAIN_ID?",
  "agent ready": "Agent expired or misconfigured: revoke + rerun ConfigureAgent (docs/PHASE12_FINAL.md §8).",
  "purchase request": "Read error.code on the request and look it up in docs/PHASE11_DEBUGGING.md (AA21 deposit, AA22 expired, AA24 signer/nonce key, AA25 nonce, ERC20InsufficientAllowance ...).",
  "on-chain proof": "The tx exists but the proof failed: open it on BaseScan and decode UserOperationRevertReason (docs/PHASE11_DEBUGGING.md, second table).",
};

async function main() {
  console.log(`H12 live check on chain ${chainId} via ${BASE}`);

  head("Backend health");
  const h = await api("GET", "/health");
  if (!check("backend health", h.ok && h.chainId === chainId && h.wallet === a.wallet, `chain ${h.chainId}, wallet ${h.wallet}, agent ${h.agent}, llm ${h.llm}`)) return "backend health";

  head("Wallet and agent before");
  const before = await api("GET", "/wallet/status");
  const quote = await client.readContract({ address: a.merchant, abi: abi.merchant, functionName: "quote", args: [BigInt(CREDITS)] });
  const submitterTxs0 = await client.getTransactionCount({ address: before.submitter.address });
  console.log(`   agent valid until ${before.agent.validUntilIso}, maxPerTx ${before.agent.maxPerTx.mUSDC}, spentToday ${before.agent.spentToday.mUSDC}, remaining ${before.agent.remainingDailyAllowance.mUSDC}`);
  console.log(`   wallet ${before.wallet.balance.mUSDC} mUSDC, allowance ${before.wallet.merchantAllowance.mUSDC}, deposit ${before.wallet.entryPointDeposit} wei, credits ${before.wallet.credits}; quote(${CREDITS}) = ${m(quote)}`);
  if (before.warnings.length) console.log(`   warnings: ${before.warnings.join(", ")}`);
  const ready =
    check("agent active and valid now", before.agent.active && before.agent.validNow) &
    check("purchase allowed (call + recipient)", before.agent.canPurchase && before.agent.merchantAllowed) &
    check(`quote(${CREDITS}) within maxPerTx and remaining today`, quote <= BigInt(before.agent.maxPerTx.base) && quote <= BigInt(before.agent.remainingDailyAllowance.base));
  if (!ready) return "agent ready";

  head(`POST /agent/chat "buy ${CREDITS} credits"`);
  const chat = await api("POST", "/agent/chat", { message: `buy ${CREDITS} credits`, conversationId: "h12" });
  console.log(`   planner ${chat.planner}; reply:\n     ${chat.reply.replace(/\n+/g, "\n     ")}`);
  if (!check("one request created", chat.requestIds.length === 1, chat.requestIds.join(", "))) return "purchase request";

  head("Request record (GET /requests/:id)");
  const req = await api("GET", `/requests/${chat.requestIds[0]}`);
  console.log(`   status ${req.status}, precheck ${req.precheck}, path ${req.path}, price ${req.price?.mUSDC} mUSDC`);
  console.log(`   userOpHash ${req.userOpHash}`);
  console.log(`   txHash     ${req.txHash}`);
  if (EXPLORER && req.txHash) console.log(`   BaseScan   ${EXPLORER}${req.txHash}`);
  if (req.error) console.log(`   error      ${req.error.code}: ${req.error.message}`);
  if (!check("request succeeded", req.status === "succeeded")) return "purchase request";

  head("On-chain proof (read directly from the chain, not from the backend)");
  const [tx, receipt] = await Promise.all([client.getTransaction({ hash: req.txHash }), client.getTransactionReceipt({ hash: req.txHash })]);
  const logs = parseEventLogs({ abi: allAbi, logs: receipt.logs });
  const opEvent = logs.find((l) => l.eventName === "UserOperationEvent" && l.args.userOpHash === req.userOpHash);
  const bought = logs.find((l) => l.eventName === "CreditsPurchased" && l.address.toLowerCase() === a.merchant.toLowerCase());
  const spent = logs.find((l) => l.eventName === "AgentSpent" && l.address.toLowerCase() === a.wallet.toLowerCase());
  let call;
  try {
    call = decodeFunctionData({ abi: abi.entryPoint, data: tx.input });
  } catch {}
  const proof =
    check("tx mined with status success", receipt.status === "success", `block ${receipt.blockNumber}`) &
    check("tx went to the EntryPoint (ERC-4337, not a bypass)", tx.to?.toLowerCase() === a.entryPoint.toLowerCase() && call?.functionName === "handleOps", `${tx.to} ${call?.functionName}`) &
    check("UserOperationEvent.success == true for our userOpHash", opEvent?.args.success === true, opEvent ? `sender ${opEvent.args.sender}, gas cost ${opEvent.args.actualGasCost} wei` : "event missing") &
    check("UserOp sender is the wallet, nonce key is the agent", opEvent?.args.sender === a.wallet && opEvent?.args.nonce >> 64n === BigInt(h.agent), opEvent ? `nonce key 0x${(opEvent.args.nonce >> 64n).toString(16)}` : "") &
    check(`CreditsPurchased: buyer wallet, ${CREDITS} credits, paid quote`, bought?.args.buyer === a.wallet && bought?.args.credits === BigInt(CREDITS) && bought?.args.amountPaid === quote, bought ? `#${bought.args.purchaseId}, ${m(bought.args.amountPaid)}` : "event missing") &
    check("AgentSpent emitted by the wallet", Boolean(spent), spent ? `${m(spent.args.amount)}, spentToday ${m(spent.args.spentToday)}` : "event missing");
  if (!proof) return "on-chain proof";

  head("Wallet and agent after");
  const after = await api("GET", "/wallet/status");
  const delta = BigInt(after.agent.spentToday.base) - BigInt(before.agent.spentToday.base);
  const rolledOver = BigInt(after.agent.spentToday.base) < BigInt(before.agent.spentToday.base);
  check("spentToday rose by exactly the quote", delta === quote || (rolledOver && BigInt(after.agent.spentToday.base) === quote), rolledOver ? `UTC day rolled over; spentToday now ${after.agent.spentToday.mUSDC}` : `${before.agent.spentToday.mUSDC} -> ${after.agent.spentToday.mUSDC} (+${m(delta)})`);
  check(`credits rose by ${CREDITS}`, after.wallet.credits - before.wallet.credits === CREDITS, `${before.wallet.credits} -> ${after.wallet.credits}`);

  head(`POST /agent/chat "buy ${OVER} credits" (over the limit)`);
  const submitterTxs1 = await client.getTransactionCount({ address: after.submitter.address });
  const over = await api("POST", "/agent/chat", { message: `buy ${OVER} credits`, conversationId: "h12" });
  console.log(`   reply:\n     ${over.reply.replace(/\n+/g, "\n     ")}`);
  const oreq = over.requestIds[0] ? await api("GET", `/requests/${over.requestIds[0]}`) : null;
  const final = await api("GET", "/wallet/status");
  const submitterTxs2 = await client.getTransactionCount({ address: final.submitter.address });
  check("request is needs_owner_approval", oreq?.status === "needs_owner_approval", oreq ? `${oreq.id}, precheck ${oreq.precheck}, price ${oreq.price.mUSDC} mUSDC` : "no request");
  check("no txHash and no userOpHash on it", oreq && oreq.txHash === null && oreq.userOpHash === null);
  check("no transaction sent (submitter nonce unchanged)", submitterTxs2 === submitterTxs1, `${submitterTxs1} -> ${submitterTxs2}`);
  check("agent UserOp nonce unchanged", final.agent.nextNonce === after.agent.nextNonce);
  check("no funds moved (balance, spentToday, credits unchanged)", final.wallet.balance.base === after.wallet.balance.base && final.agent.spentToday.base === after.agent.spentToday.base && final.wallet.credits === after.wallet.credits);
  if (oreq?.ownerApproval) console.log(`   owner must sign wallet.executeBatch: approve(merchant, ${oreq.ownerApproval.calls[0].args.value.mUSDC}) + purchase(${OVER}, ${oreq.ownerApproval.price.mUSDC})`);
  console.log(`   (submitter sent ${submitterTxs1 - submitterTxs0} tx for the whole run: the one handleOps)`);
  return null;
}

let firstFailing;
try {
  firstFailing = await main();
} catch (e) {
  console.log(`\nERROR: ${e.message}`);
  firstFailing = firstFailing ?? "backend health";
  results.push({ name: "run", ok: false });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? "H12: NO-GO" : "H12: GO"}  (${results.length - failed.length}/${results.length} checks passed)`);
if (failed.length) {
  const where = firstFailing ?? failed[0].name;
  console.log(`First failing stage: ${where}. ${HINTS[where] ?? "See docs/PHASE11_DEBUGGING.md."}`);
  console.log("Then run the P-1 reference purchase: cd ..\\integration; node agent-purchase.mjs  (if that works and the backend doesn't, the bug is in the backend)");
  process.exitCode = 1;
}
