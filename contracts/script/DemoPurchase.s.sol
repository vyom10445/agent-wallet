// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {MockMerchant} from "../src/MockMerchant.sol";

/// @notice Local demo of a real token-backed purchase. Anvil only.
/// Run (with `anvil` running in another terminal, using Anvil's built-in unlocked account 0):
///   forge script script/DemoPurchase.s.sol --rpc-url anvil --broadcast --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
contract DemoPurchase is Script {
    uint256 constant ONE_USDC = 1_000_000;
    uint256 constant PRICE_PER_CREDIT = 10_000; // 0.01 USDC

    function run() external {
        require(block.chainid == 31337, "Anvil only");
        address buyer = msg.sender;

        vm.startBroadcast();
        MockUSDC usdc = new MockUSDC();
        MockMerchant merchant = new MockMerchant(IERC20(address(usdc)), PRICE_PER_CREDIT);
        usdc.mint(buyer, 50 * ONE_USDC);
        uint256 cost = merchant.quote(500);
        usdc.approve(address(merchant), cost);
        uint256 purchaseId = merchant.purchase(500, cost);
        vm.stopBroadcast();

        console2.log("MockUSDC:", address(usdc));
        console2.log("MockMerchant:", address(merchant));
        console2.log("purchaseId:", purchaseId);
        console2.log("buyer credits:", merchant.creditsOf(buyer));
        console2.log("buyer mUSDC (base units):", usdc.balanceOf(buyer));
        console2.log("merchant mUSDC (base units):", usdc.balanceOf(address(merchant)));
    }
}
