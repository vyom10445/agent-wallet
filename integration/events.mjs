// Frontend event feed for the wallet: agent spends, purchases, policy changes, UserOp results.
// Env: FROM_BLOCK (default: last 5000 blocks).
import { publicClient, addr, abi, fmtUsdc } from "./lib.mjs";

const latest = await publicClient.getBlockNumber();
const fromBlock = process.env.FROM_BLOCK ? BigInt(process.env.FROM_BLOCK) : latest > 5000n ? latest - 5000n : 0n;
const get = (address, a, eventName, args) => publicClient.getContractEvents({ address, abi: a, eventName, args, fromBlock, toBlock: latest });

for (const l of await get(addr.wallet, abi.wallet, "AgentSpent"))
  console.log("AgentSpent      ", l.args.agent, "->", l.args.recipient, fmtUsdc(l.args.amount), "spentToday", fmtUsdc(l.args.spentToday), l.transactionHash);
for (const l of await get(addr.merchant, abi.merchant, "CreditsPurchased", { buyer: addr.wallet }))
  console.log("CreditsPurchased", "#" + l.args.purchaseId, l.args.credits, "credits for", fmtUsdc(l.args.amountPaid), l.transactionHash);
for (const name of ["AgentAdded", "PolicySet", "CallPermissionSet", "RecipientPermissionSet", "AgentRevoked"])
  for (const l of await get(addr.wallet, abi.wallet, name)) console.log(name.padEnd(16), l.args, l.transactionHash);
for (const l of await get(addr.entryPoint, abi.entryPoint, "UserOperationEvent", { sender: addr.wallet }))
  console.log("UserOperation   ", l.args.success ? "success" : "FAILED", "nonce key", "0x" + (l.args.nonce >> 64n).toString(16), "seq", l.args.nonce & 0xffffffffffffffffn, "gas cost", l.args.actualGasCost, "wei", l.transactionHash);
