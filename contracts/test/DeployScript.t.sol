// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {Deploy} from "../script/Deploy.s.sol";

/// @notice Phase 10: the deployment path that Base Sepolia takes (canonical EntryPoint, chain guard).
contract DeployScriptTest is Test {
    address internal constant CANONICAL_ENTRY_POINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address internal owner = makeAddr("owner");

    function test_refusesUnsupportedChains() public {
        Deploy script = new Deploy();
        uint256[3] memory chains = [uint256(1), 8453, 11155111]; // Ethereum, Base mainnet, Sepolia
        for (uint256 i; i < chains.length; i++) {
            vm.chainId(chains[i]);
            vm.expectRevert("Unsupported chain: only Anvil (31337) and Base Sepolia (84532)");
            script.deploy(owner);
        }
    }

    function test_baseSepolia_requiresCanonicalEntryPoint() public {
        Deploy script = new Deploy();
        vm.chainId(84532);
        vm.expectRevert("EntryPoint v0.7 missing on this chain");
        script.deploy(owner);
    }

    function test_baseSepolia_usesCanonicalEntryPointAndOwner() public {
        // Place EntryPoint v0.7 runtime code at the canonical address, as it exists on Base Sepolia.
        vm.etch(CANONICAL_ENTRY_POINT_V07, address(new EntryPoint()).code);
        vm.chainId(84532);
        Deploy.Deployment memory d = new Deploy().deploy(owner);

        assertEq(address(d.entryPoint), CANONICAL_ENTRY_POINT_V07);
        assertEq(address(d.factory.accountImplementation().entryPoint()), CANONICAL_ENTRY_POINT_V07);
        assertEq(address(d.wallet.entryPoint()), CANONICAL_ENTRY_POINT_V07);
        assertEq(d.wallet.owner(), owner);
        assertEq(address(d.merchant.token()), address(d.usdc));
        assertEq(d.merchant.pricePerCredit(), 10_000);
        assertEq(d.factory.getAddress(owner, 0), address(d.wallet));
    }

    function test_rejectsZeroOwner() public {
        Deploy script = new Deploy();
        vm.expectRevert("Wallet owner is zero");
        script.deploy(address(0));
    }

    function test_factory_createAccountTwiceReturnsSameWalletAndKeepsOwner() public {
        Deploy.Deployment memory d = new Deploy().deploy(owner);
        address attacker = makeAddr("attacker");
        vm.prank(attacker); // anyone may call the factory, but it can only return the existing wallet
        address again = address(d.factory.createAccount(owner, 0));
        assertEq(again, address(d.wallet));
        assertEq(d.wallet.owner(), owner);
        assertTrue(address(d.factory.createAccount(attacker, 0)) != address(d.wallet), "other owner, other wallet");
    }
}
