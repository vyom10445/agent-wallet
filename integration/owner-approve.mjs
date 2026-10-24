// Owner approval of an out-of-policy purchase (frontend + owner wallet). The agent's request (e.g. a SQLite row) is only
// a proposal: this owner-signed executeBatch is the on-chain authorization. Mirrors script/utils/OwnerApproval.sol.
// Env: OWNER_PRIVATE_KEY (testnet/Anvil only; in a browser use the injected wallet), CREDITS, MAX_PRICE (base units).
import { encodeFunctionData, decodeFunctionData } from "viem";
import { publicClient, walletClientFor, addr, abi, requireEnv, explainError, fmtUsdc, readOpResult } from "./lib.mjs";

const owner = walletClientFor(requireEnv("OWNER_PRIVATE_KEY"));
const credits = BigInt(requireEnv("CREDITS"));
const maxPrice = BigInt(requireEnv("MAX_PRICE"));
const read = (address, a, functionName, args = []) => publicClient.readContract({ address, abi: a, functionName, args });

// 1. Build from on-chain facts, never from the agent's numbers.
const price = await read(addr.merchant, abi.merchant, "quote", [credits]);
const standing = await read(addr.usdc, abi.usdc, "allowance", [addr.wallet, addr.merchant]);
const dest = [addr.usdc, addr.merchant];
const func = [
  encodeFunctionData({ abi: abi.usdc, functionName: "approve", args: [addr.merchant, standing + price] }),
  encodeFunctionData({ abi: abi.merchant, functionName: "purchase", args: [credits, price] }),
];

// 2. Show the owner exactly what they sign, decoded back from the calldata that will be sent.
const shown = func.map((data, i) => {
  const d = decodeFunctionData({ abi: i === 0 ? abi.usdc : abi.merchant, data });
  return `${dest[i]}.${d.functionName}(${d.args.join(", ")})`;
});
console.log("Owner approval request\n  credits:", credits, "\n  price:  ", fmtUsdc(price), "(max you allowed:", fmtUsdc(maxPrice) + ")");
console.log("  calls:\n   ", shown.join("\n    "), "\n  allowance stays at", fmtUsdc(standing), "afterwards");
if (price > maxPrice) {
  console.log("NOT APPROVED: quote is above MAX_PRICE");
  process.exit(1);
}

// 3. Owner explicitly signs with owner authority (executeBatch is owner/EntryPoint-only).
try {
  const { request } = await publicClient.simulateContract({ account: owner.account, address: addr.wallet, abi: abi.wallet, functionName: "executeBatch", args: [dest, [], func] });
  const hash = await owner.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const { events } = readOpResult(receipt);
  const purchase = events.find((e) => e.eventName === "CreditsPurchased");
  console.log(receipt.status === "success" && purchase ? "APPROVED AND RECORDED" : "FAILED", hash, purchase?.args);
} catch (e) {
  console.log("FAILED:", explainError(e));
  process.exitCode = 1;
}
