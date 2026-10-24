// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDC
/// @notice Test-only USDC stand-in (6 decimals) for Anvil and Base Sepolia. NOT for production.
/// @dev Minting is open to anyone so agents, frontend and tests can fund themselves like a faucet.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @param amount In base units (1 mUSDC = 1_000_000).
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
