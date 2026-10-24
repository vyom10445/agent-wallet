// What the owner must sign for an over-limit request (BACKEND_API.md §4.5). Rebuilt from on-chain reads every
// time, exactly like integration/owner-approve.mjs and contracts/script/utils/OwnerApproval.sol:
//   wallet.executeBatch([usdc, merchant], [], [approve(merchant, standing + price), purchase(credits, price)])
// The price is MockMerchant.quote(credits) read now. A price the agent proposed is never reused.
// The backend never signs this: the owner does, from their own wallet.
import { encodeFunctionData, formatUnits } from "viem";
import { abi, USDC_DECIMALS } from "../config.js";

const amount = (v) => ({ base: v.toString(), mUSDC: formatUnits(v, USDC_DECIMALS) });

export const SIGN_WITH = "owner wallet (injected), integration/owner-approve.mjs, or script/OwnerApprovePurchase.s.sol";

/** @returns the OwnerApproval object of §4.5. Throws (-> 502 RPC_ERROR) if a read fails, so no stale calldata is shown. */
export async function buildOwnerApproval({ config, reads }, request) {
  const a = config.addresses;
  const credits = BigInt(request.credits);
  const [price, standing] = await Promise.all([reads.quote(credits), reads.merchantAllowance()]);
  const func = [
    encodeFunctionData({ abi: abi.usdc, functionName: "approve", args: [a.merchant, standing + price] }),
    encodeFunctionData({ abi: abi.merchant, functionName: "purchase", args: [credits, price] }),
  ];
  return {
    wallet: a.wallet,
    function: "executeBatch",
    price: amount(price),
    standingAllowance: amount(standing),
    args: { dest: [a.usdc, a.merchant], value: [], func },
    calls: [
      { to: a.usdc, function: "approve", args: { spender: a.merchant, value: amount(standing + price) } },
      { to: a.merchant, function: "purchase", args: { credits: request.credits, payment: amount(price) } },
    ],
    signWith: SIGN_WITH,
    readAt: Math.floor(Date.now() / 1000),
  };
}
