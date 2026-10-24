// Agent UserOperations (EntryPoint v0.7, packed), ported from integration/lib.mjs with identical behaviour:
// fixed gas limits, nonce key = agent address, EIP-191 signature over getUserOpHash, simulate then send handleOps
// from the submitter with BUNDLE_GAS_LIMIT, success only when UserOperationEvent.success is true for our userOpHash.
//
// The app uses createPurchaser(...).purchaseCredits({ credits }) only. It builds every address and calldata itself.
// The lower-level functions are exported for tests and for the decoders; they are not for arbitrary calls.
import {
  createWalletClient, http, pad, toHex, encodeFunctionData, parseEventLogs, decodeErrorResult, BaseError,
  ContractFunctionRevertedError,
} from "viem";
import { abi, allAbi } from "../config.js";

export const GAS = { verification: 500_000n, call: 500_000n, preVerification: 60_000n };
// handleOps must be sent with at least the op's declared gas, or the EntryPoint reverts with "AA95 out of gas".
export const BUNDLE_GAS_LIMIT = GAS.verification + GAS.call + GAS.preVerification + 200_000n;
export const MAX_CREDITS_PER_REQUEST = 10_000;
export const DEFAULT_MIN_DEPOSIT_WEI = 1_000_000_000_000_000n; // 0.001 ETH: warn below this (AA21 risk)

// ---------------------------------------------------------------- ported from integration/lib.mjs

export async function buildUserOp(ctx, { nonce, callData, maxFeePerGas, maxPriorityFeePerGas }) {
  if (maxFeePerGas === undefined) ({ maxFeePerGas, maxPriorityFeePerGas } = await ctx.client.estimateFeesPerGas());
  return {
    sender: ctx.addresses.wallet,
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

/** 65-byte r||s||v over EIP-191 personal_sign of getUserOpHash(op). */
export async function signUserOp(ctx, op, account) {
  const hash = await ctx.client.readContract({ address: ctx.addresses.entryPoint, abi: abi.entryPoint, functionName: "getUserOpHash", args: [op] });
  return { ...op, signature: await account.signMessage({ message: { raw: hash } }), userOpHash: hash };
}

/** No bundler: the submitter calls handleOps directly. Simulates first so validation errors surface before sending. */
export async function submitUserOp(ctx, op, submitter, { gas = BUNDLE_GAS_LIMIT } = {}) {
  const { userOpHash, ...packed } = op;
  const request = { address: ctx.addresses.entryPoint, abi: abi.entryPoint, functionName: "handleOps", args: [[packed], submitter.account.address], gas, account: submitter.account };
  await ctx.client.simulateContract(request); // throws FailedOp(…, "AA2x …") on validation failure
  const hash = await submitter.writeContract(request);
  let receipt;
  try {
    receipt = await ctx.client.waitForTransactionReceipt({ hash });
  } catch (e) {
    e.txHash = hash; // sent but not confirmed: the caller must resolve it from the chain later
    throw e;
  }
  return { hash, receipt, ...readOpResult(receipt, userOpHash) };
}

/** A mined handleOps tx can still contain a FAILED op: always check UserOperationEvent.success. */
export function readOpResult(receipt, userOpHash) {
  const logs = parseEventLogs({ abi: allAbi, logs: receipt.logs });
  const opEvent = logs.find((l) => l.eventName === "UserOperationEvent" && (!userOpHash || l.args.userOpHash === userOpHash));
  const revert = logs.find((l) => l.eventName === "UserOperationRevertReason" && (!userOpHash || l.args.userOpHash === userOpHash));
  return {
    success: opEvent?.args.success ?? false,
    actualGasCost: opEvent?.args.actualGasCost,
    revertReason: revert ? explainRevertData(revert.args.revertReason) : undefined,
    revertData: revert?.args.revertReason,
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

// ---------------------------------------------------------------- error codes (new)

/**
 * Machine-readable code for a thrown error or a decoded revert line:
 * "AA21"... from FailedOp / FailedOpWithRevert, otherwise the custom error name (ExceedsPerTxLimit,
 * ERC20InsufficientAllowance, ...), "RPC_ERROR" when the node could not be reached, else "UNKNOWN".
 */
export function errorCode(errOrLine) {
  const line = typeof errOrLine === "string" ? errOrLine : explainError(errOrLine);
  const aa = /^(AA\d\d)\b/.exec(line ?? "");
  if (aa) return aa[1];
  const custom = /^([A-Z][A-Za-z0-9_]*)\(/.exec(line ?? "");
  if (custom) return custom[1];
  if (errOrLine instanceof BaseError && errOrLine.walk((e) => e.name === "HttpRequestError" || e.name === "TimeoutError")) return "RPC_ERROR";
  return "UNKNOWN";
}

// ---------------------------------------------------------------- purchase pipeline (new)

/**
 * The only entry point the app uses. purchaseCredits({ credits }) builds purchase(credits, quote(credits)),
 * wraps it in executeAsAgent(agent, merchant, 0, inner), and sends it as one UserOp. One op in flight per agent.
 *
 * Result: { outcome: "succeeded" | "failed_onchain" | "not_sent" | "submitted", code, message, credits, price, nonce, userOpHash,
 *           txHash, blockNumber, actualGasCost, purchase, events, warnings }
 * "not_sent" means nothing reached the chain (bad input, low submitter ETH, low deposit, or simulation rejected it).
 * "submitted" means handleOps was sent but its receipt could not be read yet (code RECEIPT_TIMEOUT); resolve it by txHash later.
 */
export function createPurchaser(config, reads, { walletClient, minDepositWei = DEFAULT_MIN_DEPOSIT_WEI } = {}) {
  const ctx = { client: reads.client, addresses: config.addresses };
  const submitter = walletClient ?? createWalletClient({ account: config.submitter, chain: config.chain, transport: http(config.rpcUrl) });
  const agent = config.agent;
  const queues = new Map(); // agent address -> tail of its promise chain

  function enqueue(key, job) {
    const run = (queues.get(key) ?? Promise.resolve()).then(job, job);
    const tail = run.catch(() => {});
    queues.set(key, tail);
    tail.then(() => queues.get(key) === tail && queues.delete(key));
    return run;
  }

  async function purchaseOnce(credits) {
    const base = { credits, price: null, nonce: null, userOpHash: null, txHash: null, blockNumber: null, actualGasCost: null, purchase: null, events: [], warnings: [] };
    const notSent = (code, message, extra = {}) => ({ ...base, ...extra, outcome: "not_sent", code, message });
    try {
      const price = await reads.quote(credits);
      const inner = encodeFunctionData({ abi: abi.merchant, functionName: "purchase", args: [BigInt(credits), price] });
      // Outer callData: executeAsAgent(agent, target, value = 0, data). The agent address MUST equal the signer.
      const callData = encodeFunctionData({ abi: abi.wallet, functionName: "executeAsAgent", args: [agent.address, config.addresses.merchant, 0n, inner] });
      const nonce = await reads.agentNonce(agent.address); // read right before building, never cached
      const op = await signUserOp(ctx, await buildUserOp(ctx, { nonce, callData }), agent);
      Object.assign(base, { price, nonce, userOpHash: op.userOpHash });

      // Funds checks before sending.
      const maxFeePerGas = BigInt(op.gasFees) & ((1n << 128n) - 1n);
      const prefund = (GAS.verification + GAS.call + GAS.preVerification) * maxFeePerGas;
      const [deposit, submitterEth] = await Promise.all([reads.getDeposit(), ctx.client.getBalance({ address: submitter.account.address })]);
      if (deposit < prefund) return notSent("AA21", `Wallet EntryPoint deposit ${deposit} wei is below the op's prefund ${prefund} wei. The owner must top it up (rerun ConfigureAgent).`);
      if (deposit < minDepositWei) base.warnings.push("DEPOSIT_LOW");
      const submitterCost = BUNDLE_GAS_LIMIT * maxFeePerGas;
      if (submitterEth < submitterCost) return notSent("SUBMITTER_LOW", `Submitter ${submitter.account.address} has ${submitterEth} wei, needs ${submitterCost} wei for handleOps.`);

      let r;
      try {
        r = await submitUserOp(ctx, op, submitter);
      } catch (e) {
        if (e.txHash) return { ...base, outcome: "submitted", txHash: e.txHash, code: "RECEIPT_TIMEOUT", message: `Sent, receipt not confirmed yet: ${explainError(e)}` };
        // Simulation (or the send itself) failed: nothing was sent for this op.
        return notSent(errorCode(e), explainError(e));
      }
      const bought = r.events.find((e) => e.eventName === "CreditsPurchased" && e.address.toLowerCase() === config.addresses.merchant.toLowerCase());
      const mined = { txHash: r.hash, blockNumber: r.receipt.blockNumber, actualGasCost: r.actualGasCost ?? null, events: r.events };
      if (!r.success) {
        const message = r.revertReason ?? (r.receipt.status === "success" ? "UserOperationEvent.success is false" : "handleOps transaction reverted");
        return { ...base, ...mined, outcome: "failed_onchain", code: r.revertReason ? errorCode(r.revertReason) : "UNKNOWN", message };
      }
      if (!bought) return { ...base, ...mined, outcome: "failed_onchain", code: "NO_PURCHASE_EVENT", message: "Op succeeded but no CreditsPurchased event from the merchant" };
      return {
        ...base, ...mined, outcome: "succeeded", code: null, message: "PURCHASE OK",
        purchase: { purchaseId: bought.args.purchaseId, credits: bought.args.credits, amountPaid: bought.args.amountPaid },
      };
    } catch (e) {
      return notSent(errorCode(e), explainError(e));
    }
  }

  return {
    submitterAddress: submitter.account.address,
    /** @param {{ credits: number }} intent  Only a credit count; no target, recipient or calldata is accepted. */
    purchaseCredits(intent) {
      const keys = intent && typeof intent === "object" ? Object.keys(intent) : [];
      const credits = intent?.credits;
      if (keys.length !== 1 || keys[0] !== "credits" || !Number.isSafeInteger(credits) || credits < 1 || credits > MAX_CREDITS_PER_REQUEST) {
        return Promise.resolve({ outcome: "not_sent", code: "INVALID_INPUT", message: `Intent must be exactly { credits } with an integer from 1 to ${MAX_CREDITS_PER_REQUEST}.`, credits: credits ?? null, warnings: [] });
      }
      return enqueue(agent.address, () => purchaseOnce(credits));
    },
  };
}
