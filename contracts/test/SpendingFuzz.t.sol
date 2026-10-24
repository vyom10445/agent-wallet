// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {UserOps} from "../script/utils/UserOps.sol";
import {AgentWalletTestBase} from "./utils/AgentWalletTestBase.sol";

/// @notice Step 9.2: random policies, existing spending, amounts and day changes. Every check uses the tokens that
/// actually left the wallet through real EntryPoint.handleOps calls, not a helper that predicts the outcome.
contract SpendingFuzzTest is AgentWalletTestBase {
    uint256 constant PRICE = 10_000; // MockMerchant: 0.01 USDC per credit
    uint256 constant STEPS = 6;

    /// @dev External so a validation-stage rejection (FailedOp revert) can be caught with try/catch.
    function submitExternal(PackedUserOperation memory op) external returns (bool) {
        return _submit(op);
    }

    function _execute(uint256 amount, bool viaMerchant) internal returns (uint256 executed) {
        PackedUserOperation memory op = viaMerchant ? _purchaseOp(amount / PRICE) : _transferOp(recipient, amount);
        uint256 before = _walletBalance();
        try this.submitExternal(op) {} catch {} // rejected in validation = nothing executed
        executed = before - _walletBalance();
    }

    /// forge-config: default.fuzz.runs = 512
    function testFuzz_executedSpendingNeverExceedsPolicy(
        uint256 maxPerTx,
        uint256 dailyLimit,
        uint256[STEPS] memory amountSeeds,
        bool[STEPS] memory viaMerchant,
        uint256[STEPS] memory warpSeeds
    ) public {
        maxPerTx = bound(maxPerTx, 0, 200 * ONE_USDC);
        dailyLimit = bound(dailyLimit, 0, 500 * ONE_USDC);
        vm.prank(owner);
        wallet.setPolicy(agent, address(usdc), maxPerTx, dailyLimit);

        uint256 day = block.timestamp / 1 days;
        uint256 spentThisDay; // actual executed spending on `day`
        for (uint256 i; i < STEPS; i++) {
            // sometimes move time forward, sometimes across midnight
            vm.warp(block.timestamp + bound(warpSeeds[i], 0, 1 days));
            if (block.timestamp / 1 days != day) {
                day = block.timestamp / 1 days;
                spentThisDay = 0;
            }

            uint256 amount = bound(amountSeeds[i], PRICE, 250 * ONE_USDC);
            if (viaMerchant[i]) amount -= amount % PRICE; // merchant charges whole credits

            uint256 executed = _execute(amount, viaMerchant[i]);
            bool withinPolicy = amount <= maxPerTx && spentThisDay + amount <= dailyLimit;

            assertEq(executed, withinPolicy ? amount : 0, "executed spending differs from policy");
            assertLe(executed, maxPerTx, "single execution above maxPerTx");
            spentThisDay += executed;
            assertLe(spentThisDay, dailyLimit, "daily executed spending above dailyLimit");
            assertEq(_spent(), spentThisDay, "on-chain counter differs from executed spending");
        }
    }

    /// Existing spending is created by real prior executions, then one more attempt is made.
    /// forge-config: default.fuzz.runs = 512
    function testFuzz_existingSpendingPlusNewAmount(uint256 existing, uint256 amount, bool viaMerchant) public {
        existing = bound(existing, 0, DAILY_LIMIT);
        amount = bound(amount, PRICE, 2 * MAX_PER_TX);
        if (viaMerchant) amount -= amount % PRICE;

        // build `existing` from real transfers of at most maxPerTx each
        uint256 built;
        while (built < existing) {
            uint256 chunk = existing - built > MAX_PER_TX ? MAX_PER_TX : existing - built;
            assertEq(_execute(chunk, false), chunk);
            built += chunk;
        }
        assertEq(_spent(), existing);

        uint256 executed = _execute(amount, viaMerchant);
        bool withinPolicy = amount <= MAX_PER_TX && existing + amount <= DAILY_LIMIT;
        assertEq(executed, withinPolicy ? amount : 0);
        assertEq(_spent(), existing + executed);
        assertLe(_spent(), DAILY_LIMIT);
    }
}
