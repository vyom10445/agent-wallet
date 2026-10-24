// Frontend reads: wallet, agent policy, spend counter, balances, credits.   AGENT_ADDRESS optional.
import { publicClient, addr, abi, fmtUsdc, chain } from "./lib.mjs";

const read = (address, a, functionName, args = []) => publicClient.readContract({ address, abi: a, functionName, args });

console.log("chain", chain.id, "wallet", addr.wallet);
console.log("owner          ", await read(addr.wallet, abi.wallet, "owner"));
console.log("entryPoint     ", await read(addr.wallet, abi.wallet, "entryPoint"));
console.log("mUSDC decimals ", await read(addr.usdc, abi.usdc, "decimals"));
console.log("wallet balance ", fmtUsdc(await read(addr.usdc, abi.usdc, "balanceOf", [addr.wallet])));
console.log("merchant allow.", fmtUsdc(await read(addr.usdc, abi.usdc, "allowance", [addr.wallet, addr.merchant])));
console.log("gas deposit    ", await read(addr.wallet, abi.wallet, "getDeposit"), "wei");
console.log("price/credit   ", fmtUsdc(await read(addr.merchant, abi.merchant, "pricePerCredit")));
console.log("credits owned  ", await read(addr.merchant, abi.merchant, "creditsOf", [addr.wallet]));

const agent = process.env.AGENT_ADDRESS;
if (agent) {
  const info = await read(addr.wallet, abi.wallet, "getAgent", [agent]);
  // spentToday is already rolled over for the current UTC day: show it as-is, no client-side reset needed.
  console.log("agent", agent, {
    active: info.active,
    validNow: await read(addr.wallet, abi.wallet, "isAgentValid", [agent]),
    validAfter: new Date(Number(info.validAfter) * 1000).toISOString(),
    validUntil: new Date(Number(info.validUntil) * 1000).toISOString(),
    token: info.token,
    maxPerTx: fmtUsdc(info.maxPerTx),
    dailyLimit: fmtUsdc(info.dailyLimit),
    spentToday: fmtUsdc(info.spentToday),
    remainingToday: fmtUsdc(await read(addr.wallet, abi.wallet, "remainingDailyAllowance", [agent])),
    canPurchase: await read(addr.wallet, abi.wallet, "isCallAllowed", [agent, addr.merchant, "0x70876c98"]), // purchase(uint256,uint256)
    merchantAllowed: await read(addr.wallet, abi.wallet, "isRecipientAllowed", [agent, addr.merchant]),
  });
}
