// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

contract MockUSDCTest is Test {
    MockUSDC usdc;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant ONE_USDC = 1_000_000;

    function setUp() public {
        usdc = new MockUSDC();
    }

    function test_metadata() public view {
        assertEq(usdc.name(), "Mock USDC");
        assertEq(usdc.symbol(), "mUSDC");
        assertEq(usdc.decimals(), 6);
        assertEq(usdc.totalSupply(), 0);
    }

    function test_baseUnits() public view {
        assertEq(10 ** usdc.decimals(), ONE_USDC);
        assertEq(1 * ONE_USDC, 1_000_000); // 1 USDC
        assertEq(10 * ONE_USDC, 10_000_000); // 10 USDC
        assertEq(50 * ONE_USDC, 50_000_000); // 50 USDC
    }

    function test_mintUpdatesBalanceAndSupply() public {
        usdc.mint(alice, 50 * ONE_USDC);

        assertEq(usdc.balanceOf(alice), 50_000_000);
        assertEq(usdc.totalSupply(), 50_000_000);
    }

    function test_mintEmitsTransferFromZero() public {
        vm.expectEmit(true, true, false, true, address(usdc));
        emit Transfer(address(0), alice, ONE_USDC);
        usdc.mint(alice, ONE_USDC);
    }

    function test_anyoneCanMint() public {
        vm.prank(bob);
        usdc.mint(bob, 10 * ONE_USDC);
        assertEq(usdc.balanceOf(bob), 10_000_000);
    }

    function test_transferUpdatesBothBalances() public {
        usdc.mint(alice, 50 * ONE_USDC);

        vm.prank(alice);
        assertTrue(usdc.transfer(bob, 10 * ONE_USDC));

        assertEq(usdc.balanceOf(alice), 40_000_000);
        assertEq(usdc.balanceOf(bob), 10_000_000);
        assertEq(usdc.totalSupply(), 50_000_000);
    }

    function test_transferOfOneUsdc() public {
        usdc.mint(alice, ONE_USDC);

        vm.prank(alice);
        assertTrue(usdc.transfer(bob, ONE_USDC));

        assertEq(usdc.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(bob), 1_000_000);
    }

    function test_transferMoreThanBalanceReverts() public {
        usdc.mint(alice, 10 * ONE_USDC);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, alice, 10 * ONE_USDC, 10 * ONE_USDC + 1
            )
        );
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        usdc.transfer(bob, 10 * ONE_USDC + 1);
    }

    function testFuzz_transferConservesSupply(uint256 minted, uint256 sent) public {
        minted = bound(minted, 0, 1e12 * ONE_USDC);
        sent = bound(sent, 0, minted);
        usdc.mint(alice, minted);

        vm.prank(alice);
        assertTrue(usdc.transfer(bob, sent));

        assertEq(usdc.balanceOf(alice), minted - sent);
        assertEq(usdc.balanceOf(bob), sent);
        assertEq(usdc.balanceOf(alice) + usdc.balanceOf(bob), usdc.totalSupply());
    }

    event Transfer(address indexed from, address indexed to, uint256 value);
}
