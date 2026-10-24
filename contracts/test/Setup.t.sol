// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {SimpleAccount} from "account-abstraction/samples/SimpleAccount.sol";
import {SimpleAccountFactory} from "account-abstraction/samples/SimpleAccountFactory.sol";
import {AgentWallet} from "../src/AgentWallet.sol";

/// @notice Phase 1 acceptance test: the pinned EntryPoint v0.7 and SimpleAccount deploy and wire up correctly.
contract SetupTest is Test {
    EntryPoint entryPoint;
    SimpleAccountFactory factory;
    address owner = makeAddr("owner");

    function setUp() public {
        entryPoint = new EntryPoint();
        factory = new SimpleAccountFactory(entryPoint);
    }

    function test_factoryCreatesAccountAtPredictedAddress() public {
        address predicted = factory.getAddress(owner, 0);
        SimpleAccount account = factory.createAccount(owner, 0);

        assertEq(address(account), predicted);
        assertEq(account.owner(), owner);
        assertEq(address(account.entryPoint()), address(entryPoint));
    }

    function test_accountNonceStartsAtZero() public {
        SimpleAccount account = factory.createAccount(owner, 0);
        assertEq(account.getNonce(), 0);
    }

    function test_agentWalletPlaceholderCompilesAgainstEntryPoint() public {
        AgentWallet wallet = new AgentWallet(entryPoint);
        assertEq(address(wallet.entryPoint()), address(entryPoint));
    }
}
