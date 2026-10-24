// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Vm} from "forge-std/Vm.sol";

/// @notice Supported chains and the deployments/<chainId>.json address book written by Deploy.s.sol.
library Deployments {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant ANVIL = 31337;
    uint256 internal constant BASE_SEPOLIA = 84532;

    struct Addresses {
        address entryPoint;
        address factory;
        address implementation;
        address usdc;
        address merchant;
        address wallet;
        address owner;
    }

    /// @dev Every deployment script refuses to touch any chain except local Anvil and Base Sepolia (never mainnet).
    function requireSupportedChain() internal view {
        require(
            block.chainid == ANVIL || block.chainid == BASE_SEPOLIA,
            "Unsupported chain: only Anvil (31337) and Base Sepolia (84532)"
        );
    }

    function path() internal view returns (string memory) {
        return string.concat("deployments/", vm.toString(block.chainid), ".json");
    }

    function save(Addresses memory a) internal {
        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "entryPoint", a.entryPoint);
        vm.serializeAddress(k, "factory", a.factory);
        vm.serializeAddress(k, "implementation", a.implementation);
        vm.serializeAddress(k, "usdc", a.usdc);
        vm.serializeAddress(k, "merchant", a.merchant);
        vm.serializeAddress(k, "wallet", a.wallet);
        string memory json = vm.serializeAddress(k, "owner", a.owner);
        vm.createDir("deployments", true);
        vm.writeJson(json, path());
    }

    /// @dev Reads the address book for the current chain and checks every contract has code there.
    function load() internal view returns (Addresses memory a) {
        requireSupportedChain();
        string memory json = vm.readFile(path());
        require(vm.parseJsonUint(json, ".chainId") == block.chainid, "Address book is for another chain");
        a.entryPoint = vm.parseJsonAddress(json, ".entryPoint");
        a.factory = vm.parseJsonAddress(json, ".factory");
        a.implementation = vm.parseJsonAddress(json, ".implementation");
        a.usdc = vm.parseJsonAddress(json, ".usdc");
        a.merchant = vm.parseJsonAddress(json, ".merchant");
        a.wallet = vm.parseJsonAddress(json, ".wallet");
        a.owner = vm.parseJsonAddress(json, ".owner");
        require(
            a.entryPoint.code.length > 0 && a.factory.code.length > 0 && a.usdc.code.length > 0
                && a.merchant.code.length > 0 && a.wallet.code.length > 0,
            "Address book points at missing contracts: run Deploy.s.sol first"
        );
    }
}
