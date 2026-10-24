// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script, console2} from "forge-std/Script.sol";

/// @notice Phase 1 placeholder. Deployment of AgentWallet, MockUSDC and MockMerchant is added in a later phase.
/// @dev On Base Sepolia use the canonical EntryPoint v0.7; do not deploy a new one.
contract Deploy is Script {
    address constant ENTRY_POINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;

    function run() external view {
        console2.log("chain id:", block.chainid);
        console2.log("EntryPoint v0.7:", ENTRY_POINT_V07);
        console2.log("EntryPoint has code:", ENTRY_POINT_V07.code.length > 0);
    }
}
