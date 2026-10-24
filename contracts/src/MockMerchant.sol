// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MockMerchant
/// @notice Test-only API-credit store. Buyers pay in MockUSDC (6 decimals) at a fixed price per credit.
/// @dev Pull payment: the buyer first approves this contract, then calls purchase(). Tokens are only
///      ever pulled from msg.sender, and only the exact quoted amount.
contract MockMerchant {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    /// @notice Price of one credit in token base units (e.g. 10_000 = 0.01 USDC).
    uint256 public immutable pricePerCredit;

    mapping(address buyer => uint256) public creditsOf;
    uint256 public purchaseCount;

    event CreditsPurchased(uint256 indexed purchaseId, address indexed buyer, uint256 credits, uint256 amountPaid);

    error ZeroCredits();
    error IncorrectPayment(uint256 expected, uint256 provided);

    constructor(IERC20 token_, uint256 pricePerCredit_) {
        token = token_;
        pricePerCredit = pricePerCredit_;
    }

    /// @notice Price in token base units for `credits` credits.
    function quote(uint256 credits) public view returns (uint256) {
        return credits * pricePerCredit;
    }

    /// @notice Buy `credits` API credits, paying exactly `payment` base units pulled from msg.sender.
    /// @param payment Must equal quote(credits); guards the buyer against paying a different amount than intended.
    /// @return purchaseId Sequential id of this purchase, starting at 1.
    function purchase(uint256 credits, uint256 payment) external returns (uint256 purchaseId) {
        if (credits == 0) revert ZeroCredits();
        uint256 expected = quote(credits);
        if (payment != expected) revert IncorrectPayment(expected, payment);

        purchaseId = ++purchaseCount;
        creditsOf[msg.sender] += credits;

        token.safeTransferFrom(msg.sender, address(this), payment);

        emit CreditsPurchased(purchaseId, msg.sender, credits, payment);
    }
}
