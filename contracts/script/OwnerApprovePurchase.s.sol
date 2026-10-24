// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AgentWallet} from "../src/AgentWallet.sol";
import {MockMerchant} from "../src/MockMerchant.sol";
import {Deployments} from "./utils/Deployments.sol";
import {OwnerApproval} from "./utils/OwnerApproval.sol";

/// @notice The owner approves one out-of-policy purchase on chain. A request stored off chain (e.g. SQLite) is only a
///         proposal; this owner-signed transaction is the authorization.
///
/// Env:
///   APPROVE_CREDITS    required. Credits to buy.
///   APPROVE_MAX_PRICE  required. The most the owner agrees to pay, in mUSDC base units (6 decimals).
///                      The script refuses if the merchant's quote is higher.
/// Run without --broadcast first to review the exact details, then add --broadcast to sign and send.
contract OwnerApprovePurchase is Script {
    function run() external {
        Deployments.Addresses memory a = Deployments.load();
        AgentWallet wallet = AgentWallet(payable(a.wallet));
        MockMerchant merchant = MockMerchant(a.merchant);
        IERC20 usdc = IERC20(a.usdc);

        uint256 credits = vm.envUint("APPROVE_CREDITS");
        uint256 maxPrice = vm.envUint("APPROVE_MAX_PRICE");
        uint256 price = merchant.quote(credits);
        uint256 standing = usdc.allowance(a.wallet, a.merchant);

        console2.log("== Purchase to approve ==");
        console2.log("wallet               ", a.wallet);
        console2.log("merchant             ", a.merchant);
        console2.log("credits              ", credits);
        console2.log("price (mUSDC base)   ", price);
        console2.log("owner's max price    ", maxPrice);
        console2.log("wallet mUSDC balance ", usdc.balanceOf(a.wallet));
        console2.log("standing allowance   ", standing, "(unchanged afterwards)");
        console2.log("signed by owner      ", msg.sender);

        require(msg.sender == wallet.owner(), "Sender is not the wallet owner");
        require(credits > 0, "APPROVE_CREDITS must be > 0");
        require(price <= maxPrice, "Quote is above APPROVE_MAX_PRICE: not approved");
        require(usdc.balanceOf(a.wallet) >= price, "Wallet balance too low");

        (address[] memory dest, uint256[] memory value, bytes[] memory func) =
            OwnerApproval.purchaseBatch(usdc, merchant, a.wallet, credits, price);
        uint256 creditsBefore = merchant.creditsOf(a.wallet);

        vm.broadcast();
        wallet.executeBatch(dest, value, func);

        require(merchant.creditsOf(a.wallet) == creditsBefore + credits, "Purchase not recorded");
        require(usdc.allowance(a.wallet, a.merchant) == standing, "Standing allowance changed");
        console2.log("purchase recorded, purchaseCount", merchant.purchaseCount());
    }
}
