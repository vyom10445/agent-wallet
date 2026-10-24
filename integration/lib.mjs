// Shared setup for the examples. Addresses come from contracts/deployments/<chainId>.json, ABIs from abi/.
// Env: CHAIN_ID (84532 default, 31337 for local Anvil), RPC_URL (optional).
import { readFileSync } from "node:fs";
import {
  createPublicClient, createWalletClient, http, pad, toHex, parseEventLogs, decodeErrorResult, BaseError,
  ContractFunctionRevertedError,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, anvil } from "viem/chains";

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));

export const CHAIN_ID = Number(process.env.CHAIN_ID ?? 84532);
if (CHAIN_ID !== 84532 && CHAIN_ID !== 31337) throw new Error("CHAIN_ID must be 84532 (Base Sepolia) or 31337 (Anvil)");
export const chain = CHAIN_ID === 84532 ? baseSepolia : anvil;
const transport = http(process.env.RPC_URL ?? chain.rpcUrls.default.http[0]);

export const addr = json(`../contracts/deployments/${CHAIN_ID}.json`);
export const abi = {
  wallet: json("../abi/AgentWallet.json"),
  usdc: json("../abi/MockUSDC.json"),
  merchant: json("../abi/MockMerchant.json"),
  entryPoint: json("../abi/EntryPoint.v0.7.0.json"),
};
// Every error/event the flow can produce, for decoding receipts and reverts in one place.
export const allAbi = [...abi.wallet, ...abi.usdc, ...abi.merchant, ...abi.entryPoint];

export const USDC_DECIMALS = 6; // mUSDC base units: 1_000_000 = 1 mUSDC
export const publicClient = createPublicClient({ chain, transport });
export const walletClientFor = (privateKey) =>
  createWalletClient({ account: privateKeyToAccount(privateKey), chain, transport });
export const requireEnv = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name}`);
  return v;
};

// ---------------------------------------------------------------- UserOperations (EntryPoint v0.7, packed)

export const GAS = { verification: 500_000n, call: 500_000n, preVerification: 60_000n };
// handleOps must be sent with at least the op's declared gas, or the EntryPoint reverts with "AA95 out of gas".
export const BUNDLE_GAS_LIMIT = GAS.verification + GAS.call + GAS.preVerification + 200_000n;

/** Agent nonce: key = the agent's address (uint192), never key 0 (that sequence belongs to the owner). */
export const agentNonce = (agent) =>
  publicClient.readContract({ address: addr.entryPoint, abi: abi.entryPoint, functionName: "getNonce", args: [addr.wallet, BigInt(agent)] });

export async function buildUserOp({ nonce, callData, maxFeePerGas, maxPriorityFeePerGas }) {
  if (maxFeePerGas === undefined) ({ maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas());
  return {
    sender: addr.wallet,
    nonce,
    initCode: "0x", // wallet is already deployed
    callData,
    accountGasLimits: pad(toHex((GAS.verification << 128n) | GAS.call), { size: 32 }),
    preVerificationGas: GAS.preVerification,
    gasFees: pad(toHex((maxPriorityFeePerGas << 128n) | maxFeePerGas), { size: 32 }),
    paymasterAndData: "0x", // no paymaster: gas is paid from the wallet's EntryPoint deposit
    signature: "0x",
  };
}

/** 65-byte r||s||v over EIP-191 personal_sign of getUserOpHash(op). Same for owner and agent. */
export async function signUserOp(op, account) {
  const hash = await publicClient.readContract({ address: addr.entryPoint, abi: abi.entryPoint, functionName: "getUserOpHash", args: [op] });
  return { ...op, signature: await account.signMessage({ message: { raw: hash } }), userOpHash: hash };
}

/** No bundler: a funded EOA calls handleOps directly. Simulates first so validation errors surface before sending. */
export async function submitUserOp(op, submitter) {
  const { userOpHash, ...packed } = op;
  const request = { address: addr.entryPoint, abi: abi.entryPoint, functionName: "handleOps", args: [[packed], submitter.account.address], gas: BUNDLE_GAS_LIMIT, account: submitter.account };
  await publicClient.simulateContract(request); // throws FailedOp(…, "AA2x …") on validation failure
  const hash = await submitter.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { hash, receipt, ...readOpResult(receipt, userOpHash) };
}

/** A mined handleOps tx can still contain a FAILED op: always check UserOperationEvent.success. */
export function readOpResult(receipt, userOpHash) {
  const logs = parseEventLogs({ abi: allAbi, logs: receipt.logs });
  const opEvent = logs.find((l) => l.eventName === "UserOperationEvent" && (!userOpHash || l.args.userOpHash === userOpHash));
  const revert = logs.find((l) => l.eventName === "UserOperationRevertReason");
  return {
    success: opEvent?.args.success ?? false,
    actualGasCost: opEvent?.args.actualGasCost,
    revertReason: revert ? explainRevertData(revert.args.revertReason) : undefined,
    events: logs.filter((l) => ["AgentSpent", "AgentExecuted", "CreditsPurchased"].includes(l.eventName)),
  };
}

export function explainRevertData(data) {
  try {
    const { errorName, args } = decodeErrorResult({ abi: allAbi, data });
    return `${errorName}(${(args ?? []).join(", ")})`;
  } catch {
    return data;
  }
}

/** Turns viem errors (FailedOp / FailedOpWithRevert / custom errors) into one readable line. */
export function explainError(err) {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted?.data) {
      const { errorName, args } = reverted.data;
      if (errorName === "FailedOpWithRevert") return `${args[1]} -> ${explainRevertData(args[2])}`;
      if (errorName === "FailedOp") return args[1];
      return `${errorName}(${(args ?? []).join(", ")})`;
    }
    return err.shortMessage;
  }
  return String(err);
}

export const fmtUsdc = (v) => `${Number(v) / 10 ** USDC_DECIMALS} mUSDC`;
