// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {IAgentWallet} from "../src/interfaces/IAgentWallet.sol";

/// @notice Fails if a frozen IAgentWallet signature or event changes. Update only with P-2/P-3 sign-off.
contract InterfaceFreezeTest is Test {
    function test_functionSelectorsAreFrozen() public pure {
        assertEq(IAgentWallet.addAgent.selector, bytes4(keccak256("addAgent(address,uint48,uint48)")));
        assertEq(IAgentWallet.setPolicy.selector, bytes4(keccak256("setPolicy(address,address,uint256,uint256)")));
        assertEq(IAgentWallet.allowCall.selector, bytes4(keccak256("allowCall(address,address,bytes4,bool)")));
        assertEq(IAgentWallet.allowRecipient.selector, bytes4(keccak256("allowRecipient(address,address,bool)")));
        assertEq(IAgentWallet.revokeAgent.selector, bytes4(keccak256("revokeAgent(address)")));
        assertEq(
            IAgentWallet.executeAsAgent.selector, bytes4(keccak256("executeAsAgent(address,address,uint256,bytes)"))
        );
        assertEq(IAgentWallet.getAgent.selector, bytes4(keccak256("getAgent(address)")));
        assertEq(IAgentWallet.isAgentValid.selector, bytes4(keccak256("isAgentValid(address)")));
        assertEq(IAgentWallet.isCallAllowed.selector, bytes4(keccak256("isCallAllowed(address,address,bytes4)")));
        assertEq(IAgentWallet.isRecipientAllowed.selector, bytes4(keccak256("isRecipientAllowed(address,address)")));
        assertEq(IAgentWallet.remainingDailyAllowance.selector, bytes4(keccak256("remainingDailyAllowance(address)")));
    }

    function test_eventSignaturesAreFrozen() public pure {
        assertEq(IAgentWallet.AgentAdded.selector, keccak256("AgentAdded(address,uint48,uint48)"));
        assertEq(IAgentWallet.AgentRevoked.selector, keccak256("AgentRevoked(address)"));
        assertEq(IAgentWallet.PolicySet.selector, keccak256("PolicySet(address,address,uint256,uint256)"));
        assertEq(IAgentWallet.CallPermissionSet.selector, keccak256("CallPermissionSet(address,address,bytes4,bool)"));
        assertEq(IAgentWallet.RecipientPermissionSet.selector, keccak256("RecipientPermissionSet(address,address,bool)"));
        assertEq(IAgentWallet.AgentSpent.selector, keccak256("AgentSpent(address,address,address,uint256,uint256)"));
        assertEq(IAgentWallet.AgentExecuted.selector, keccak256("AgentExecuted(address,address,bytes4,uint256)"));
    }

    function test_executeSelectorMatchesSimpleAccount() public pure {
        // execute is inherited from SimpleAccount v0.7.0 and must keep this selector (0xb61d27f6).
        assertEq(bytes4(keccak256("execute(address,uint256,bytes)")), bytes4(0xb61d27f6));
    }
}
