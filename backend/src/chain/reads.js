// Read-only chain client: the live state the backend needs. No writes here.
// All amounts stay bigint (mUSDC base units, 6 decimals); use formatUsdc/amount only at the edges.
import { createPublicClient, http, formatUnits, BaseError } from "viem";
import { abi, USDC_DECIMALS, PURCHASE_SELECTOR, ENTRYPOINT_V07_INTERFACE_ID } from "../config.js";

export class StartupError extends Error {
  name = "StartupError";
}

export const formatUsdc = (v) => formatUnits(v, USDC_DECIMALS);
/** API shape from BACKEND_API.md §2: { base: "1500000", mUSDC: "1.5" }. */
export const amount = (v) => ({ base: v.toString(), mUSDC: formatUsdc(v) });

export function createReads(config, { publicClient } = {}) {
  const client = publicClient ?? createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) });
  const a = config.addresses;
  const agentAddress = config.agent.address;
  const read = (address, contractAbi, functionName, args = [], blockNumber) =>
    client.readContract({ address, abi: contractAbi, functionName, args, blockNumber });

  const reads = {
    client,
    chainId: () => client.getChainId(),
    blockNumber: () => client.getBlockNumber(),

    // AgentWallet
    owner: (b) => read(a.wallet, abi.wallet, "owner", [], b),
    walletEntryPoint: (b) => read(a.wallet, abi.wallet, "entryPoint", [], b),
    getAgent: (agent = agentAddress, b) => read(a.wallet, abi.wallet, "getAgent", [agent], b),
    isAgentValid: (agent = agentAddress, b) => read(a.wallet, abi.wallet, "isAgentValid", [agent], b),
    isCallAllowed: (agent = agentAddress, b) => read(a.wallet, abi.wallet, "isCallAllowed", [agent, a.merchant, PURCHASE_SELECTOR], b),
    isRecipientAllowed: (agent = agentAddress, b) => read(a.wallet, abi.wallet, "isRecipientAllowed", [agent, a.merchant], b),
    remainingDailyAllowance: (agent = agentAddress, b) => read(a.wallet, abi.wallet, "remainingDailyAllowance", [agent], b),
    getDeposit: (b) => read(a.wallet, abi.wallet, "getDeposit", [], b),

    // MockUSDC
    walletBalance: (b) => read(a.usdc, abi.usdc, "balanceOf", [a.wallet], b),
    merchantAllowance: (b) => read(a.usdc, abi.usdc, "allowance", [a.wallet, a.merchant], b),

    // MockMerchant
    quote: (credits, b) => read(a.merchant, abi.merchant, "quote", [BigInt(credits)], b),
    creditsOf: (b) => read(a.merchant, abi.merchant, "creditsOf", [a.wallet], b),
    pricePerCredit: (b) => read(a.merchant, abi.merchant, "pricePerCredit", [], b),
    purchaseCount: (b) => read(a.merchant, abi.merchant, "purchaseCount", [], b),
    merchantToken: (b) => read(a.merchant, abi.merchant, "token", [], b),

    // EntryPoint. Agent nonce key = the agent's address (uint192), never key 0 (that sequence is the owner's).
    agentNonce: (agent = agentAddress, b) => read(a.entryPoint, abi.entryPoint, "getNonce", [a.wallet, BigInt(agent)], b),
    entryPointIsV07: (b) => read(a.entryPoint, abi.entryPoint, "supportsInterface", [ENTRYPOINT_V07_INTERFACE_ID], b),

    // Factory
    factoryWallet: (b) => read(a.factory, abi.factory, "getAddress", [a.owner, 0n], b),

    /** Everything Status.s.sol prints plus the agent's permissions and nonce, all read at one block. */
    async snapshot(agent = agentAddress) {
      const b = await client.getBlockNumber();
      const [
        isV07, walletEp, factoryWallet, owner, merchantToken, balance, allowance, deposit, credits, purchaseCount, pricePerCredit,
        info, validNow, remaining, canPurchase, merchantAllowed, nonce,
      ] = await Promise.all([
        reads.entryPointIsV07(b), reads.walletEntryPoint(b), reads.factoryWallet(b), reads.owner(b), reads.merchantToken(b),
        reads.walletBalance(b), reads.merchantAllowance(b), reads.getDeposit(b), reads.creditsOf(b), reads.purchaseCount(b),
        reads.pricePerCredit(b), reads.getAgent(agent, b), reads.isAgentValid(agent, b), reads.remainingDailyAllowance(agent, b),
        reads.isCallAllowed(agent, b), reads.isRecipientAllowed(agent, b), reads.agentNonce(agent, b),
      ]);
      return {
        chainId: config.chainId,
        blockNumber: b,
        addresses: { ...a, agent },
        checks: {
          entryPointIsV07: isV07,
          walletEntryPointOk: walletEp === a.entryPoint,
          factoryWalletOk: factoryWallet === a.wallet,
          walletOwnerOk: owner === a.owner,
          merchantTokenOk: merchantToken === a.usdc,
        },
        wallet: { balance, merchantAllowance: allowance, entryPointDeposit: deposit, credits },
        merchant: { pricePerCredit, purchaseCount },
        agent: {
          active: info.active,
          validNow,
          validAfter: info.validAfter,
          validUntil: info.validUntil,
          token: info.token,
          maxPerTx: info.maxPerTx,
          dailyLimit: info.dailyLimit,
          spentToday: info.spentToday, // already rolled over for the current UTC day
          remainingDailyAllowance: remaining,
          canPurchase,
          merchantAllowed,
          nonceKey: BigInt(agent),
          nextNonce: nonce,
        },
      };
    },
  };
  return reads;
}

/**
 * Startup checks. Throws StartupError with a readable message:
 * RPC on the configured chain, wallet deployed, wallet.entryPoint() == deployment EntryPoint, agent key registered.
 */
export async function assertStartup(config, reads) {
  const a = config.addresses;
  let rpcChainId;
  try {
    rpcChainId = await reads.chainId();
  } catch (e) {
    throw new StartupError(`Cannot reach RPC_URL for chain ${config.chainId}: ${e instanceof BaseError ? e.shortMessage : e.message}`);
  }
  if (rpcChainId !== config.chainId) {
    throw new StartupError(`Wrong chain: RPC_URL is chain ${rpcChainId}, but CHAIN_ID is ${config.chainId}.`);
  }
  const code = await reads.client.getCode({ address: a.wallet });
  if (!code || code === "0x") {
    throw new StartupError(`No contract at wallet ${a.wallet} on chain ${config.chainId}. Redeploy, or check contracts/deployments/${config.chainId}.json.`);
  }
  const ep = await reads.walletEntryPoint();
  if (ep !== a.entryPoint) {
    throw new StartupError(`wallet.entryPoint() is ${ep}, but contracts/deployments/${config.chainId}.json says ${a.entryPoint}.`);
  }
  const info = await reads.getAgent(config.agent.address);
  if (!info.active) {
    throw new StartupError(`Wrong agent key: ${config.agent.address} is not an active agent on wallet ${a.wallet} (getAgent(agent).active is false). Check AGENT_PRIVATE_KEY, or have the owner run ConfigureAgent.`);
  }
  return { rpcChainId, agentValidNow: await reads.isAgentValid(config.agent.address) };
}
