// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SimpleAccount} from "account-abstraction/samples/SimpleAccount.sol";
import {MockMerchant} from "../../src/MockMerchant.sol";

/// @notice Owner-authorized purchase that is outside the agent's policy (e.g. above maxPerTx).
/// The owner signs SimpleAccount.executeBatch (owner authority; never executeAsAgent), so the agent's policy, limits
/// and spend counter are untouched:
///   1. token.approve(merchant, standingAllowance + price)   lets the merchant pull this one payment
///   2. merchant.purchase(credits, price)                    pulls exactly `price`, allowance is back to standing
/// The batch is atomic: if the purchase reverts, the approval is rolled back too.
library OwnerApproval {
    function purchaseBatch(IERC20 token, MockMerchant merchant, address wallet, uint256 credits, uint256 price)
        internal
        view
        returns (address[] memory dest, uint256[] memory value, bytes[] memory func)
    {
        uint256 standing = token.allowance(wallet, address(merchant));
        dest = new address[](2);
        func = new bytes[](2);
        (dest[0], func[0]) = (address(token), abi.encodeCall(IERC20.approve, (address(merchant), standing + price)));
        (dest[1], func[1]) = (address(merchant), abi.encodeCall(MockMerchant.purchase, (credits, price)));
        value = new uint256[](0);
    }

    /// @dev callData for an owner-signed UserOperation (or the data of a direct owner transaction to the wallet).
    function purchaseCallData(IERC20 token, MockMerchant merchant, address wallet, uint256 credits, uint256 price)
        internal
        view
        returns (bytes memory)
    {
        (address[] memory dest, uint256[] memory value, bytes[] memory func) =
            purchaseBatch(token, merchant, wallet, credits, price);
        return abi.encodeCall(SimpleAccount.executeBatch, (dest, value, func));
    }
}
