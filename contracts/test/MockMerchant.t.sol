// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {MockMerchant} from "../src/MockMerchant.sol";

/// @dev Token whose transferFrom returns false instead of reverting, to test SafeERC20 handling.
contract FalseReturningToken is ERC20 {
    constructor() ERC20("False", "FALSE") {}

    function transferFrom(address, address, uint256) public pure override returns (bool) {
        return false;
    }
}

contract MockMerchantTest is Test {
    MockUSDC usdc;
    MockMerchant merchant;
    address buyer = makeAddr("buyer");

    uint256 constant ONE_USDC = 1_000_000;
    uint256 constant PRICE = 10_000; // 0.01 USDC per credit

    event CreditsPurchased(uint256 indexed purchaseId, address indexed buyer, uint256 credits, uint256 amountPaid);

    function setUp() public {
        usdc = new MockUSDC();
        merchant = new MockMerchant(IERC20(address(usdc)), PRICE);
        usdc.mint(buyer, 50 * ONE_USDC);
    }

    function _approve(uint256 amount) internal {
        vm.prank(buyer);
        usdc.approve(address(merchant), amount);
    }

    function test_setup() public view {
        assertEq(address(merchant.token()), address(usdc));
        assertEq(merchant.pricePerCredit(), PRICE);
        assertEq(merchant.quote(100), ONE_USDC); // 100 credits = 1 USDC
        assertEq(merchant.quote(500), 5 * ONE_USDC);
    }

    function test_validPurchaseMovesTokensAndRecordsCredits() public {
        _approve(5 * ONE_USDC);

        vm.prank(buyer);
        uint256 id = merchant.purchase(500, 5 * ONE_USDC);

        assertEq(id, 1);
        assertEq(usdc.balanceOf(buyer), 45 * ONE_USDC);
        assertEq(usdc.balanceOf(address(merchant)), 5 * ONE_USDC);
        assertEq(merchant.creditsOf(buyer), 500);
        assertEq(merchant.purchaseCount(), 1);
        assertEq(usdc.allowance(buyer, address(merchant)), 0); // exact approval fully used
    }

    function test_purchaseEmitsEvent() public {
        _approve(ONE_USDC);

        vm.expectEmit(true, true, false, true, address(merchant));
        emit CreditsPurchased(1, buyer, 100, ONE_USDC);
        vm.prank(buyer);
        merchant.purchase(100, ONE_USDC);
    }

    function test_creditsAccumulateAcrossPurchases() public {
        _approve(3 * ONE_USDC);

        vm.startPrank(buyer);
        assertEq(merchant.purchase(100, ONE_USDC), 1);
        assertEq(merchant.purchase(200, 2 * ONE_USDC), 2);
        vm.stopPrank();

        assertEq(merchant.creditsOf(buyer), 300);
        assertEq(usdc.balanceOf(address(merchant)), 3 * ONE_USDC);
    }

    function test_underpaymentReverts() public {
        _approve(10 * ONE_USDC);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(MockMerchant.IncorrectPayment.selector, 5 * ONE_USDC, 5 * ONE_USDC - 1));
        merchant.purchase(500, 5 * ONE_USDC - 1);
        _assertNothingRecorded();
    }

    function test_overpaymentReverts() public {
        _approve(10 * ONE_USDC);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(MockMerchant.IncorrectPayment.selector, 5 * ONE_USDC, 6 * ONE_USDC));
        merchant.purchase(500, 6 * ONE_USDC);
        _assertNothingRecorded();
    }

    function test_zeroCreditsReverts() public {
        vm.prank(buyer);
        vm.expectRevert(MockMerchant.ZeroCredits.selector);
        merchant.purchase(0, 0);
        _assertNothingRecorded();
    }

    function test_noAllowanceRevertsAndRecordsNothing() public {
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(merchant), 0, ONE_USDC)
        );
        merchant.purchase(100, ONE_USDC);
        _assertNothingRecorded();
    }

    function test_insufficientBalanceRevertsAndRecordsNothing() public {
        _approve(100 * ONE_USDC);

        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, buyer, 50 * ONE_USDC, 60 * ONE_USDC)
        );
        merchant.purchase(6000, 60 * ONE_USDC);
        _assertNothingRecorded();
    }

    function test_tokenReturningFalseRevertsAndRecordsNothing() public {
        FalseReturningToken bad = new FalseReturningToken();
        MockMerchant badMerchant = new MockMerchant(IERC20(address(bad)), PRICE);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(bad)));
        badMerchant.purchase(100, ONE_USDC);

        assertEq(badMerchant.creditsOf(buyer), 0);
        assertEq(badMerchant.purchaseCount(), 0);
    }

    function test_cannotPullFromSomeoneElse() public {
        // buyer approved the merchant, but a stranger cannot spend buyer's allowance: tokens only come from msg.sender
        _approve(10 * ONE_USDC);
        address stranger = makeAddr("stranger");

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(merchant), 0, ONE_USDC)
        );
        merchant.purchase(100, ONE_USDC);

        assertEq(usdc.balanceOf(buyer), 50 * ONE_USDC);
        assertEq(merchant.creditsOf(stranger), 0);
    }

    function testFuzz_purchaseConservesTokens(uint256 credits) public {
        credits = bound(credits, 1, 5000); // up to 50 USDC
        uint256 cost = credits * PRICE;
        _approve(cost);

        vm.prank(buyer);
        merchant.purchase(credits, cost);

        assertEq(usdc.balanceOf(buyer) + usdc.balanceOf(address(merchant)), 50 * ONE_USDC);
        assertEq(usdc.balanceOf(address(merchant)), cost);
        assertEq(merchant.creditsOf(buyer), credits);
    }

    function _assertNothingRecorded() internal view {
        assertEq(merchant.creditsOf(buyer), 0);
        assertEq(merchant.purchaseCount(), 0);
        assertEq(usdc.balanceOf(buyer), 50 * ONE_USDC);
        assertEq(usdc.balanceOf(address(merchant)), 0);
    }
}
