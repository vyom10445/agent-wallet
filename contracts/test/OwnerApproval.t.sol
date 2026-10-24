// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IAgentWallet} from "../src/interfaces/IAgentWallet.sol";
import {OwnerApproval} from "../script/utils/OwnerApproval.sol";
import {UserOps} from "../script/utils/UserOps.sol";
import {AgentWalletTestBase} from "./utils/AgentWalletTestBase.sol";

/// @notice Phase 11.3: an out-of-policy purchase only happens through the owner's own authority.
contract OwnerApprovalTest is AgentWalletTestBase {
    uint256 internal constant STANDING_ALLOWANCE = 50 * ONE_USDC;
    uint256 internal constant BIG_CREDITS = 1_500; // 15 mUSDC > MAX_PER_TX (10)

    bytes32 internal constant CREDITS_PURCHASED = keccak256("CreditsPurchased(uint256,address,uint256,uint256)");
    bytes32 internal constant AGENT_SPENT = keccak256("AgentSpent(address,address,address,uint256,uint256)");

    function setUp() public override {
        super.setUp();
        vm.prank(owner);
        wallet.execute(address(usdc), 0, abi.encodeCall(IERC20.approve, (address(merchant), STANDING_ALLOWANCE)));
    }

    function _approvalCallData(uint256 credits) internal view returns (bytes memory) {
        return OwnerApproval.purchaseCallData(usdc, merchant, address(wallet), credits, merchant.quote(credits));
    }

    function _ownerOp(bytes memory callData) internal view returns (PackedUserOperation memory) {
        return _signed(callData, wallet.getNonce(), ownerKey);
    }

    function _assertRecorded(uint256 creditsBefore, uint256 balanceBefore, uint256 spentBefore) internal view {
        uint256 price = merchant.quote(BIG_CREDITS);
        assertEq(merchant.creditsOf(address(wallet)), creditsBefore + BIG_CREDITS, "credits recorded");
        assertEq(_walletBalance(), balanceBefore - price, "paid exactly the quote");
        assertEq(usdc.allowance(address(wallet), address(merchant)), STANDING_ALLOWANCE, "standing allowance kept");
        assertEq(_spent(), spentBefore, "agent counter untouched");
        assertEq(wallet.getAgent(agent).maxPerTx, MAX_PER_TX, "agent policy untouched");
    }

    function test_outOfPolicyPurchase_byAgent_isBlocked() public {
        uint256 balance = _walletBalance();
        assertFalse(_submit(_purchaseOp(BIG_CREDITS)), "agent op must fail");
        assertEq(_walletBalance(), balance);
        assertEq(merchant.creditsOf(address(wallet)), 0);
    }

    function test_ownerApproval_viaOwnerSignedUserOp() public {
        (uint256 c, uint256 b, uint256 s) = (merchant.creditsOf(address(wallet)), _walletBalance(), _spent());
        vm.recordLogs();
        vm.prank(bundler, bundler);
        ep.handleOps{gas: UserOps.bundleGasLimit()}(
            UserOps.single(_ownerOp(_approvalCallData(BIG_CREDITS))), payable(bundler)
        );
        _assertRecorded(c, b, s);

        bool purchased;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(ep) && logs[i].topics[0] == USER_OPERATION_EVENT) {
                (, bool success,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
                assertTrue(success, "owner op must succeed");
            }
            assertTrue(logs[i].topics[0] != AGENT_SPENT, "owner purchase is not an agent spend");
            if (logs[i].emitter == address(merchant) && logs[i].topics[0] == CREDITS_PURCHASED) {
                assertEq(logs[i].topics[2], bytes32(uint256(uint160(address(wallet)))), "buyer is the wallet");
                (uint256 credits, uint256 paid) = abi.decode(logs[i].data, (uint256, uint256));
                assertEq(credits, BIG_CREDITS);
                assertEq(paid, merchant.quote(BIG_CREDITS));
                purchased = true;
            }
        }
        assertTrue(purchased, "CreditsPurchased emitted");
    }

    function test_ownerApproval_viaDirectOwnerTransaction() public {
        (uint256 c, uint256 b, uint256 s) = (merchant.creditsOf(address(wallet)), _walletBalance(), _spent());
        (address[] memory dest, uint256[] memory value, bytes[] memory func) =
            OwnerApproval.purchaseBatch(usdc, merchant, address(wallet), BIG_CREDITS, merchant.quote(BIG_CREDITS));
        vm.prank(owner);
        wallet.executeBatch(dest, value, func);
        _assertRecorded(c, b, s);
    }

    function test_ownerSignature_bindsExactPurchaseDetails() public {
        PackedUserOperation memory op = _ownerOp(_approvalCallData(BIG_CREDITS));
        op.callData = _approvalCallData(BIG_CREDITS * 2); // tampered after the owner signed
        _expectFailedOp(op, AA24);
    }

    function test_agent_cannotUseOwnerPath() public {
        bytes memory callData = _approvalCallData(BIG_CREDITS);
        // agent signs the owner batch: rejected at validation
        _expectFailedOp(_signed(callData, wallet.getNonce(), agentKey), AA24);
        _expectFailedOp(_signed(callData, _agentNonce(), agentKey), AA24);
        // agent calls the wallet directly: rejected by SimpleAccount
        vm.prank(agent);
        (bool ok,) = address(wallet).call(callData);
        assertFalse(ok);
    }

    function test_agent_cannotExpandOwnPermissions() public {
        bytes[3] memory attempts = [
            abi.encodeCall(IAgentWallet.setPolicy, (agent, address(usdc), type(uint256).max, type(uint256).max)),
            abi.encodeCall(IAgentWallet.allowCall, (agent, address(usdc), IERC20.approve.selector, true)),
            abi.encodeCall(IAgentWallet.addAgent, (stranger, DAY0, DAY0 + 1 days))
        ];
        for (uint256 i; i < attempts.length; i++) {
            _expectFailedOp(_agentOp(address(wallet), attempts[i]), AA24);
        }
        // raising its own allowance through the token is also refused
        _expectFailedOp(
            _agentOp(address(usdc), abi.encodeCall(IERC20.approve, (address(merchant), type(uint256).max))), AA24
        );
        assertEq(wallet.getAgent(agent).maxPerTx, MAX_PER_TX);
        assertFalse(wallet.isCallAllowed(agent, address(usdc), IERC20.approve.selector));
        assertFalse(wallet.isAgentValid(stranger));
    }

    function test_ownerApproval_wrongPrice_rollsBackEverything() public {
        uint256 price = merchant.quote(BIG_CREDITS);
        bytes memory callData = OwnerApproval.purchaseCallData(usdc, merchant, address(wallet), BIG_CREDITS, price - 1);
        uint256 balance = _walletBalance();
        assertFalse(_submit(_ownerOp(callData)), "batch must fail");
        assertEq(_walletBalance(), balance);
        assertEq(usdc.allowance(address(wallet), address(merchant)), STANDING_ALLOWANCE, "approve rolled back");
        assertEq(merchant.creditsOf(address(wallet)), 0);
    }

    function test_agentPolicy_stillEnforcedAfterOwnerApproval() public {
        assertTrue(_submit(_ownerOp(_approvalCallData(BIG_CREDITS))));
        assertFalse(_submit(_purchaseOp(BIG_CREDITS)), "approval is one-off, not a policy change");
        assertTrue(_submit(_purchaseOp(500)), "in-policy purchases still work");
        assertEq(_spent(), merchant.quote(500));
    }
}
