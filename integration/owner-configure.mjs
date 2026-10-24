// Owner policy transactions (frontend). In a browser, replace walletClientFor(...) with
// createWalletClient({ chain, transport: custom(window.ethereum) }) so the owner signs in their wallet.
// Env: OWNER_PRIVATE_KEY (testnet/Anvil only), AGENT_ADDRESS, MAX_PER_TX (default 1000000), DAILY_LIMIT (default 5000000).
import { publicClient, walletClientFor, addr, abi, requireEnv, explainError, fmtUsdc } from "./lib.mjs";
import { parseEventLogs } from "viem";

const owner = walletClientFor(requireEnv("OWNER_PRIVATE_KEY"));
const agent = requireEnv("AGENT_ADDRESS");
const maxPerTx = BigInt(process.env.MAX_PER_TX ?? 1_000_000);
const dailyLimit = BigInt(process.env.DAILY_LIMIT ?? 5_000_000);

async function ownerTx(functionName, args) {
  try {
    // simulate first: custom errors (UnauthorizedCaller-style "only owner", InvalidAgent, ...) show up here, for free
    const { request } = await publicClient.simulateContract({ account: owner.account, address: addr.wallet, abi: abi.wallet, functionName, args });
    const hash = await owner.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted in ${hash}`);
    const events = parseEventLogs({ abi: abi.wallet, logs: receipt.logs }).map((l) => l.eventName);
    console.log(`${functionName} ok`, hash, events);
  } catch (e) {
    console.log(`${functionName} FAILED:`, explainError(e));
    process.exitCode = 1;
  }
}

const info = await publicClient.readContract({ address: addr.wallet, abi: abi.wallet, functionName: "getAgent", args: [agent] });
if (!info.active) {
  const now = BigInt(Math.floor(Date.now() / 1000));
  await ownerTx("addAgent", [agent, now, now + 7n * 86400n]);
}
await ownerTx("setPolicy", [agent, addr.usdc, maxPerTx, dailyLimit]);
if (!process.exitCode) console.log("policy now", fmtUsdc(maxPerTx), "per tx,", fmtUsdc(dailyLimit), "per UTC day");
