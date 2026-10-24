// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IAccountExecute} from "account-abstraction/interfaces/IAccountExecute.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {SimpleAccount} from "account-abstraction/samples/SimpleAccount.sol";
import {AgentWallet} from "../src/AgentWallet.sol";
import {IAgentWallet} from "../src/interfaces/IAgentWallet.sol";
import {MockMerchant} from "../src/MockMerchant.sol";
import {UserOps} from "../script/utils/UserOps.sol";
import {AgentWalletTestBase} from "./utils/AgentWalletTestBase.sol";

/// @notice Phase 9: gaps found when mapping the existing suite against the security requirements.
/// Every agent action goes through EntryPoint.handleOps unless a test is about a direct call.
contract SecuritySuiteTest is AgentWalletTestBase {
    uint256 constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    // =====================================================================
    // Agent authorization / nonce and replay
    // =====================================================================

    /// Issue found in Phase 9 (fixed): an agent could sign with nonce key 0 and burn the owner's nonce sequence.
    function test_agentCannotUseOwnerNonceKey() public {
        PackedUserOperation memory ownerOp =
            _signed(abi.encodeCall(SimpleAccount.execute, (owner, 0, "")), wallet.getNonce(), ownerKey);
        bytes memory call = abi.encodeCall(
            IAgentWallet.executeAsAgent, (agent, address(usdc), 0, abi.encodeCall(IERC20.transfer, (recipient, 1)))
        );
        _expectFailedOp(_signed(call, wallet.getNonce(), agentKey), AA24);
        assertTrue(_submit(ownerOp)); // owner's sequence untouched
    }

    function test_agentCannotUseAnotherAgentsNonceKey() public {
        (address agent2,) = makeAddrAndKey("agent2");
        bytes memory call = abi.encodeCall(
            IAgentWallet.executeAsAgent, (agent, address(usdc), 0, abi.encodeCall(IERC20.transfer, (recipient, 1)))
        );
        _expectFailedOp(_signed(call, UserOps.agentNonce(ep, address(wallet), agent2), agentKey), AA24);
    }

    function test_replayedAgentOpRejected() public {
        PackedUserOperation memory op = _transferOp(recipient, ONE_USDC);
        assertTrue(_submit(op));
        _expectFailedOp(op, AA25);
        assertEq(usdc.balanceOf(recipient), ONE_USDC);
    }

    function test_futureNonceRejected() public {
        bytes memory call = abi.encodeCall(
            IAgentWallet.executeAsAgent, (agent, address(usdc), 0, abi.encodeCall(IERC20.transfer, (recipient, 1)))
        );
        _expectFailedOp(_signed(call, _agentNonce() + 1, agentKey), AA25);
    }

    // =====================================================================
    // Cross-chain, cross-EntryPoint and cross-wallet replay
    // =====================================================================

    function test_signatureFromOtherChainRejected() public {
        PackedUserOperation memory op = _transferOp(recipient, ONE_USDC); // signed for chain 31337
        vm.chainId(84532); // same op submitted on Base Sepolia's chain id
        _expectFailedOp(op, AA24);
    }

    function test_opForOtherEntryPointRejected() public {
        EntryPoint otherEp = new EntryPoint();
        PackedUserOperation memory op = UserOps.build(
            address(wallet),
            otherEp.getNonce(address(wallet), uint192(uint160(agent))),
            abi.encodeCall(
                IAgentWallet.executeAsAgent, (agent, address(usdc), 0, abi.encodeCall(IERC20.transfer, (recipient, 1)))
            )
        );
        op.signature = UserOps.sign(IEntryPoint(address(otherEp)), op, agentKey);
        vm.expectPartialRevert(IEntryPoint.FailedOpWithRevert.selector); // AA23: "account: not from EntryPoint"
        otherEp.handleOps(UserOps.single(op), payable(bundler));
    }

    function test_opForOneWalletCannotRunOnAnother() public {
        AgentWallet walletB = d.factory.createAccount(owner, 1);
        vm.startPrank(owner);
        walletB.addDeposit{value: 1 ether}();
        walletB.addAgent(agent, DAY0, DAY0 + 30 days);
        walletB.setPolicy(agent, address(usdc), MAX_PER_TX, DAILY_LIMIT);
        walletB.allowRecipient(agent, recipient, true);
        vm.stopPrank();
        usdc.mint(address(walletB), 100 * ONE_USDC);

        PackedUserOperation memory op = _transferOp(recipient, ONE_USDC); // signed for wallet A
        op.sender = address(walletB);
        _expectFailedOp(op, AA24);
        assertEq(usdc.balanceOf(address(walletB)), 100 * ONE_USDC);
    }

    // =====================================================================
    // Invalid signatures
    // =====================================================================

    function test_malleableHighSSignatureRejected() public {
        PackedUserOperation memory op = _transferOp(recipient, ONE_USDC);
        (bytes32 r, bytes32 s, uint8 v) = _split(op.signature);
        op.signature = abi.encodePacked(r, bytes32(SECP256K1_N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectPartialRevert(IEntryPoint.FailedOpWithRevert.selector); // AA23, OZ ECDSAInvalidSignatureS
        ep.handleOps(UserOps.single(op), payable(bundler));
        assertEq(usdc.balanceOf(recipient), 0);
    }

    function test_wrongLengthAndEmptySignaturesRejected() public {
        PackedUserOperation memory op = _transferOp(recipient, ONE_USDC);
        (bytes32 r, bytes32 s,) = _split(op.signature);
        bytes[3] memory bad = [abi.encodePacked(r, s), bytes(""), abi.encodePacked(op.signature, uint8(0))];
        for (uint256 i; i < bad.length; i++) {
            op.signature = bad[i];
            vm.expectPartialRevert(IEntryPoint.FailedOpWithRevert.selector); // AA23
            ep.handleOps(UserOps.single(op), payable(bundler));
        }
    }

    function testFuzz_randomSignerRejected(uint256 key) public {
        key = bound(key, 1, SECP256K1_N - 1);
        vm.assume(key != agentKey && key != ownerKey);
        PackedUserOperation memory op = _transferOp(recipient, ONE_USDC);
        op.signature = UserOps.sign(ep, op, key);
        _expectFailedOp(op, AA24);
    }

    // =====================================================================
    // Owner authorization
    // =====================================================================

    function testFuzz_nonOwnerCannotAdminister(address caller) public {
        vm.assume(caller != owner && caller != address(wallet));
        vm.startPrank(caller);
        vm.expectRevert("only owner");
        wallet.addAgent(stranger, DAY0, DAY0 + 1);
        vm.expectRevert("only owner");
        wallet.setPolicy(agent, address(usdc), type(uint256).max, type(uint256).max);
        vm.expectRevert("only owner");
        wallet.allowCall(agent, stranger, bytes4(0x12345678), true);
        vm.expectRevert("only owner");
        wallet.allowRecipient(agent, stranger, true);
        vm.expectRevert("only owner");
        wallet.revokeAgent(agent);
        vm.expectRevert("only owner");
        wallet.upgradeToAndCall(address(0xdead), "");
        vm.expectRevert("only owner");
        wallet.withdrawDepositTo(payable(caller), 1);
        vm.stopPrank();
    }

    function test_ownerCannotRouteIntoExecuteAsAgentViaExecute() public {
        bytes memory inner = abi.encodeCall(
            IAgentWallet.executeAsAgent, (agent, address(usdc), 0, abi.encodeCall(IERC20.transfer, (recipient, 1)))
        );
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.UnauthorizedCaller.selector, address(wallet)));
        wallet.execute(address(wallet), 0, inner);
    }

    // =====================================================================
    // Inherited execution functions and administrative self-calls
    // =====================================================================

    function testFuzz_agentSignedNonAgentCallDataRejected(bytes4 selector, bytes memory args) public {
        vm.assume(selector != IAgentWallet.executeAsAgent.selector);
        _expectFailedOp(_signed(abi.encodePacked(selector, args), _agentNonce(), agentKey), AA24);
    }

    function test_agentCannotSignAnyInheritedEntry() public {
        address[] memory dest = new address[](1);
        bytes[] memory func = new bytes[](1);
        dest[0] = address(usdc);
        func[0] = abi.encodeCall(IERC20.transfer, (stranger, 1));
        bytes[9] memory calls = [
            abi.encodeCall(SimpleAccount.execute, (address(usdc), 0, func[0])),
            abi.encodeCall(SimpleAccount.executeBatch, (dest, new uint256[](0), func)),
            abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (address(0xdead), "")),
            abi.encodeCall(SimpleAccount.withdrawDepositTo, (payable(stranger), 1)),
            abi.encodeCall(SimpleAccount.initialize, (stranger)),
            abi.encodeCall(SimpleAccount.addDeposit, ()),
            abi.encodeCall(IAgentWallet.setPolicy, (agent, address(usdc), type(uint256).max, type(uint256).max)),
            abi.encodeCall(IAgentWallet.revokeAgent, (agent)),
            abi.encodePacked(IAccountExecute.executeUserOp.selector, func[0])
        ];
        for (uint256 i; i < calls.length; i++) {
            _expectFailedOp(_signed(calls[i], _agentNonce(), agentKey), AA24);
        }
    }

    function testFuzz_agentCannotTargetWalletOrEntryPoint(bytes4 selector, bool entryPoint) public {
        address target = entryPoint ? address(ep) : address(wallet);
        _expectFailedOp(_agentOp(target, abi.encodePacked(selector, uint256(0))), AA24);
    }

    function test_ownerCannotAllowlistWalletOrEntryPoint() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.ForbiddenTarget.selector, address(wallet)));
        wallet.allowCall(agent, address(wallet), IAgentWallet.setPolicy.selector, true);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.ForbiddenTarget.selector, address(ep)));
        wallet.allowCall(agent, address(ep), bytes4(keccak256("withdrawTo(address,uint256)")), true);
        vm.stopPrank();
    }

    // =====================================================================
    // Target, selector and recipient allowlists
    // =====================================================================

    function test_sameSelectorOnOtherContractRejected() public {
        MockMerchant other = new MockMerchant(usdc, 10_000);
        _expectFailedOp(_agentOp(address(other), abi.encodeCall(MockMerchant.purchase, (100, ONE_USDC))), AA24);
    }

    function test_removedCallPermissionTakesEffect() public {
        assertTrue(_submit(_purchaseOp(100)));
        vm.prank(owner);
        wallet.allowCall(agent, address(merchant), MockMerchant.purchase.selector, false);
        _expectFailedOp(_purchaseOp(100), AA24);
    }

    function testFuzz_onlyAllowlistedSelectorOnMerchant(bytes4 selector) public {
        vm.assume(selector != MockMerchant.purchase.selector);
        _expectFailedOp(_agentOp(address(merchant), abi.encodePacked(selector, uint256(1), uint256(1))), AA24);
    }

    function testFuzz_transferOnlyToAllowedRecipients(address to, uint256 amount) public {
        amount = bound(amount, 1, MAX_PER_TX);
        uint256 before = usdc.balanceOf(to);
        if (to == recipient || to == address(merchant)) {
            assertTrue(_submit(_transferOp(to, amount)));
            assertEq(usdc.balanceOf(to), before + amount);
        } else {
            _expectFailedOp(_transferOp(to, amount), AA24);
            assertEq(usdc.balanceOf(to), before);
        }
    }

    function test_removedRecipientTakesEffect() public {
        assertTrue(_submit(_transferOp(recipient, ONE_USDC)));
        vm.prank(owner);
        wallet.allowRecipient(agent, recipient, false);
        _expectFailedOp(_transferOp(recipient, ONE_USDC), AA24);
    }

    function test_merchantMustAlsoBeAllowedRecipient() public {
        vm.prank(owner);
        wallet.allowRecipient(agent, address(merchant), false);
        PackedUserOperation memory op = _purchaseOp(100);
        assertFalse(_submit(op)); // passes validation (pull amount unknown), payment reverts in execution
        assertEq(merchant.creditsOf(address(wallet)), 0);
        assertEq(_spent(), 0);
    }

    // =====================================================================
    // Token approval restrictions
    // =====================================================================

    function test_agentCannotApproveEvenIfOwnerAllowlistsApprove() public {
        vm.prank(owner);
        wallet.allowCall(agent, address(usdc), IERC20.approve.selector, true); // ignored for the policy token
        _expectFailedOp(_agentOp(address(usdc), abi.encodeCall(IERC20.approve, (stranger, type(uint256).max))), AA24);
        assertEq(usdc.allowance(address(wallet), stranger), 0);
    }

    function test_agentCannotTransferFromOrApproveAnySpender() public {
        _expectFailedOp(
            _agentOp(address(usdc), abi.encodeCall(IERC20.transferFrom, (address(wallet), stranger, 1))), AA24
        );
        _expectFailedOp(_agentOp(address(usdc), abi.encodeCall(IERC20.approve, (address(merchant), 0))), AA24);
    }

    // =====================================================================
    // Revocation and expiry
    // =====================================================================

    function test_opSignedBeforeRevocationRejected() public {
        PackedUserOperation memory op = _transferOp(recipient, ONE_USDC);
        vm.prank(owner);
        wallet.revokeAgent(agent);
        _expectFailedOp(op, AA24);
    }

    function test_reAddedAgentGetsFreshPermissionsAndCounter() public {
        assertTrue(_submit(_transferOp(recipient, 10 * ONE_USDC)));
        vm.startPrank(owner);
        wallet.revokeAgent(agent);
        wallet.addAgent(agent, DAY0, DAY0 + 30 days);
        vm.stopPrank();
        _expectFailedOp(_transferOp(recipient, ONE_USDC), AA24); // no recipients, no policy yet
        assertEq(_spent(), 0); // documented: re-adding starts a new daily budget (owner decision)
    }

    function test_validUntilIsInclusiveAtEntryPoint() public {
        vm.warp(DAY0 + 30 days);
        assertTrue(_submit(_transferOp(recipient, ONE_USDC)));
        vm.warp(DAY0 + 30 days + 1);
        _expectFailedOp(_transferOp(recipient, ONE_USDC), AA22);
    }

    function test_opSignedWhileValidRejectedAfterExpiry() public {
        PackedUserOperation memory op = _transferOp(recipient, ONE_USDC);
        vm.warp(DAY0 + 31 days);
        _expectFailedOp(op, AA22);
    }

    function test_notYetValidAgentRejected() public {
        (address late, uint256 lateKey) = makeAddrAndKey("late");
        vm.startPrank(owner);
        wallet.addAgent(late, DAY0 + 1 days, DAY0 + 2 days);
        wallet.setPolicy(late, address(usdc), MAX_PER_TX, DAILY_LIMIT);
        wallet.allowRecipient(late, recipient, true);
        vm.stopPrank();
        bytes memory call = abi.encodeCall(
            IAgentWallet.executeAsAgent, (late, address(usdc), 0, abi.encodeCall(IERC20.transfer, (recipient, 1)))
        );
        _expectFailedOp(_signed(call, UserOps.agentNonce(ep, address(wallet), late), lateKey), AA22);
    }

    // =====================================================================
    // maxPerTx, daily limit and day boundaries
    // =====================================================================

    function testFuzz_maxPerTxBoundary(uint256 amount, bool viaMerchant) public {
        amount = bound(amount, 1, 3 * MAX_PER_TX);
        uint256 before = _walletBalance();
        bool ok;
        if (viaMerchant) {
            uint256 credits = amount / 10_000 + 1;
            amount = credits * 10_000;
            ok = _submit(_purchaseOp(credits));
        } else if (amount > MAX_PER_TX) {
            _expectFailedOp(_transferOp(recipient, amount), AA24); // checked in validation for transfers
        } else {
            ok = _submit(_transferOp(recipient, amount));
        }
        assertEq(ok, amount <= MAX_PER_TX);
        assertEq(before - _walletBalance(), ok ? amount : 0);
    }

    function test_burstAcrossMidnightIsTwoBudgets() public {
        // Documented property of UTC-day accounting: up to 2x dailyLimit can move within seconds around midnight.
        vm.warp(DAY0 + 1 days - 1); // 23:59:59
        for (uint256 i; i < 2; i++) {
            assertTrue(_submit(_transferOp(recipient, 10 * ONE_USDC)));
        }
        assertTrue(_submit(_transferOp(recipient, 5 * ONE_USDC)));
        assertFalse(_submit(_transferOp(recipient, 1)));
        vm.warp(DAY0 + 1 days); // 00:00:00
        assertTrue(_submit(_transferOp(recipient, 10 * ONE_USDC)));
        assertEq(_spent(), 10 * ONE_USDC);
        assertEq(usdc.balanceOf(recipient), 35 * ONE_USDC);
    }

    function test_lastSecondOfDayStillCountsToThatDay() public {
        assertTrue(_submit(_transferOp(recipient, 10 * ONE_USDC)));
        vm.warp(DAY0 + 1 days - 1);
        assertEq(_spent(), 10 * ONE_USDC);
        assertEq(wallet.remainingDailyAllowance(agent), 15 * ONE_USDC);
    }

    function test_policyChangeMidDayKeepsCounter() public {
        assertTrue(_submit(_transferOp(recipient, 10 * ONE_USDC)));
        assertTrue(_submit(_transferOp(recipient, 5 * ONE_USDC)));
        vm.prank(owner);
        wallet.setPolicy(agent, address(usdc), MAX_PER_TX, 10 * ONE_USDC); // below spent
        assertFalse(_submit(_transferOp(recipient, 1)));
        vm.prank(owner);
        wallet.setPolicy(agent, address(usdc), MAX_PER_TX, 20 * ONE_USDC);
        assertEq(wallet.remainingDailyAllowance(agent), 5 * ONE_USDC);
        assertFalse(_submit(_transferOp(recipient, 6 * ONE_USDC)));
        assertTrue(_submit(_transferOp(recipient, 5 * ONE_USDC)));
    }

    // =====================================================================
    // Failed execution keeps the counter consistent
    // =====================================================================

    function testFuzz_failedPurchaseNeverCounted(uint256 credits, uint256 payment) public {
        credits = bound(credits, 1, 1000);
        payment = bound(payment, 0, 20 * ONE_USDC);
        vm.assume(payment != merchant.quote(credits));
        assertTrue(_submit(_transferOp(recipient, 3 * ONE_USDC))); // existing spending
        uint256 before = _walletBalance();
        PackedUserOperation memory op =
            _agentOp(address(merchant), abi.encodeCall(MockMerchant.purchase, (credits, payment)));
        assertFalse(_submit(op));
        assertEq(_walletBalance(), before);
        assertEq(_spent(), 3 * ONE_USDC);
        assertEq(merchant.creditsOf(address(wallet)), 0);
        assertEq(_agentNonce(), op.nonce + 1); // nonce consumed, no state change
    }

    // ---------------- helpers ----------------

    function _split(bytes memory sig) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
    }
}
