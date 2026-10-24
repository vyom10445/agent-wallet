// Agent backend: purchase credits through a UserOperation signed by the agent key.
// Env: AGENT_PRIVATE_KEY (agent, needs no ETH), SUBMITTER_PRIVATE_KEY (funded EOA that calls handleOps), CREDITS (default 10).
import { encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  publicClient, walletClientFor, addr, abi, requireEnv, agentNonce, buildUserOp, signUserOp, submitUserOp, explainError, fmtUsdc,
} from "./lib.mjs";

const agent = privateKeyToAccount(requireEnv("AGENT_PRIVATE_KEY"));
const submitter = walletClientFor(requireEnv("SUBMITTER_PRIVATE_KEY"));
const credits = BigInt(process.env.CREDITS ?? 10);

const price = await publicClient.readContract({ address: addr.merchant, abi: abi.merchant, functionName: "quote", args: [credits] });
const inner = encodeFunctionData({ abi: abi.merchant, functionName: "purchase", args: [credits, price] });
// Outer callData: executeAsAgent(agent, target, value = 0, data). The agent address MUST equal the signer.
const callData = encodeFunctionData({ abi: abi.wallet, functionName: "executeAsAgent", args: [agent.address, addr.merchant, 0n, inner] });

const op = await signUserOp(await buildUserOp({ nonce: await agentNonce(agent.address), callData }), agent);
console.log("buying", credits, "credits for", fmtUsdc(price), "userOpHash", op.userOpHash);
try {
  const r = await submitUserOp(op, submitter);
  console.log(r.success ? "PURCHASE OK" : `OP FAILED: ${r.revertReason}`, r.hash);
  for (const e of r.events) console.log(" ", e.eventName, e.args);
  if (!r.success) process.exitCode = 1;
} catch (e) {
  console.log("REJECTED:", explainError(e)); // e.g. "AA24 signature error", "AA25 invalid account nonce"
  process.exitCode = 1;
}
