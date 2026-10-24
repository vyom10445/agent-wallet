// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {SimpleAccount} from "account-abstraction/samples/SimpleAccount.sol";
import {AgentWallet} from "../src/AgentWallet.sol";
import {IAgentWallet} from "../src/interfaces/IAgentWallet.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {MockMerchant} from "../src/MockMerchant.sol";

/// @notice Phase 5: storage, administration and read functions.
contract AgentWalletTest is Test {
    uint256 constant ONE_USDC = 1_000_000;
    uint256 constant START = 1_700_000_000; // fixed timestamp for readable windows

    EntryPoint entryPoint;
    AgentWallet wallet;
    MockUSDC usdc;
    MockMerchant merchant;

    address owner;
    uint256 ownerKey;
    address agent;
    uint256 agentKey;
    address stranger = makeAddr("stranger");
    address recipient = makeAddr("recipient");

    uint48 validAfter;
    uint48 validUntil;

    event AgentAdded(address indexed agent, uint48 validAfter, uint48 validUntil);
    event AgentRevoked(address indexed agent);
    event PolicySet(address indexed agent, address indexed token, uint256 maxPerTx, uint256 dailyLimit);
    event CallPermissionSet(address indexed agent, address indexed target, bytes4 indexed selector, bool allowed);
    event RecipientPermissionSet(address indexed agent, address indexed recipient, bool allowed);

    function setUp() public {
        vm.warp(START);
        (owner, ownerKey) = makeAddrAndKey("owner");
        (agent, agentKey) = makeAddrAndKey("agent");

        entryPoint = new EntryPoint();
        AgentWallet impl = new AgentWallet(entryPoint);
        wallet =
            AgentWallet(payable(new ERC1967Proxy(address(impl), abi.encodeCall(SimpleAccount.initialize, (owner)))));
        usdc = new MockUSDC();
        merchant = new MockMerchant(usdc, 10_000);

        // forge-lint: disable-next-line(unsafe-typecast)
        validAfter = uint48(START);
        // forge-lint: disable-next-line(unsafe-typecast)
        validUntil = uint48(START + 7 days);
    }

    // ---------------- helpers ----------------

    function _addAgent() internal {
        vm.prank(owner);
        wallet.addAgent(agent, validAfter, validUntil);
    }

    function _addAgentWithPolicy() internal {
        _addAgent();
        vm.prank(owner);
        wallet.setPolicy(agent, address(usdc), 10 * ONE_USDC, 50 * ONE_USDC);
    }

    function _setSpent(uint256 amount, uint64 day) internal {
        // AgentPolicy slot layout: slot0 = active|validAfter|validUntil|currentDay, slot1 = token, slot2 = maxPerTx,
        // slot3 = dailyLimit, slot4 = spentToday. _policies is the first AgentWallet storage slot (after `owner`).
        bytes32 base = keccak256(abi.encode(agent, uint256(1)));
        bytes32 slot0 = vm.load(address(wallet), base);
        uint256 cleared = uint256(slot0) & ~(uint256(type(uint64).max) << 104);
        vm.store(address(wallet), base, bytes32(cleared | (uint256(day) << 104)));
        vm.store(address(wallet), bytes32(uint256(base) + 4), bytes32(amount));
    }

    function _today() internal view returns (uint64) {
        return uint64(block.timestamp / 1 days);
    }

    // ---------------- base account preserved ----------------

    function test_baseAccountUnchanged() public view {
        assertEq(wallet.owner(), owner);
        assertEq(address(wallet.entryPoint()), address(entryPoint));
        assertEq(wallet.getNonce(), 0);
    }

    function test_ownerCanStillExecute() public {
        usdc.mint(address(wallet), 5 * ONE_USDC);
        vm.prank(owner);
        wallet.execute(address(usdc), 0, abi.encodeCall(usdc.transfer, (recipient, ONE_USDC)));
        assertEq(usdc.balanceOf(recipient), ONE_USDC);
    }

    // ---------------- registration ----------------

    function test_ownerCanAddAgent() public {
        vm.expectEmit(true, false, false, true, address(wallet));
        emit AgentAdded(agent, validAfter, validUntil);
        _addAgent();

        IAgentWallet.AgentInfo memory info = wallet.getAgent(agent);
        assertTrue(info.active);
        assertEq(info.validAfter, validAfter);
        assertEq(info.validUntil, validUntil);
        assertEq(info.token, address(0));
        assertEq(info.maxPerTx, 0);
        assertEq(info.dailyLimit, 0);
        assertEq(info.spentToday, 0);
        assertTrue(wallet.isAgentValid(agent));
    }

    function test_strangerCannotAddAgent() public {
        vm.prank(stranger);
        vm.expectRevert("only owner");
        wallet.addAgent(agent, validAfter, validUntil);
    }

    function test_agentCannotAddItselfOrOthers() public {
        _addAgent();
        vm.prank(agent);
        vm.expectRevert("only owner");
        wallet.addAgent(stranger, validAfter, validUntil);
    }

    function test_entryPointCannotCallAdminDirectly() public {
        vm.prank(address(entryPoint));
        vm.expectRevert("only owner");
        wallet.addAgent(agent, validAfter, validUntil);
    }

    function test_addAgentRejectsInvalidAddresses() public {
        address[4] memory bad = [address(0), owner, address(wallet), address(entryPoint)];
        for (uint256 i; i < bad.length; i++) {
            vm.prank(owner);
            vm.expectRevert(abi.encodeWithSelector(IAgentWallet.InvalidAgent.selector, bad[i]));
            wallet.addAgent(bad[i], validAfter, validUntil);
        }
    }

    function test_addAgentRejectsBadWindow() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.InvalidValidityWindow.selector, validAfter, 0));
        wallet.addAgent(agent, validAfter, 0);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.InvalidValidityWindow.selector, validUntil, validAfter));
        wallet.addAgent(agent, validUntil, validAfter);
        vm.stopPrank();
    }

    function test_addAgentTwiceReverts() public {
        _addAgent();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.AgentAlreadyActive.selector, agent));
        wallet.addAgent(agent, validAfter, validUntil);
    }

    function test_validityWindowIsInclusive() public {
        vm.prank(owner);
        // forge-lint: disable-next-line(unsafe-typecast)
        wallet.addAgent(agent, uint48(START + 1 days), uint48(START + 2 days));

        assertFalse(wallet.isAgentValid(agent)); // not yet
        vm.warp(START + 1 days);
        assertTrue(wallet.isAgentValid(agent)); // first second
        vm.warp(START + 2 days);
        assertTrue(wallet.isAgentValid(agent)); // last second
        vm.warp(START + 2 days + 1);
        assertFalse(wallet.isAgentValid(agent)); // expired
        assertTrue(wallet.getAgent(agent).active); // still registered, just outside its window
    }

    // ---------------- policy ----------------

    function test_ownerCanSetPolicy() public {
        _addAgent();
        vm.expectEmit(true, true, false, true, address(wallet));
        emit PolicySet(agent, address(usdc), 10 * ONE_USDC, 50 * ONE_USDC);
        vm.prank(owner);
        wallet.setPolicy(agent, address(usdc), 10 * ONE_USDC, 50 * ONE_USDC);

        IAgentWallet.AgentInfo memory info = wallet.getAgent(agent);
        assertEq(info.token, address(usdc));
        assertEq(info.maxPerTx, 10_000_000); // 10 USDC in base units
        assertEq(info.dailyLimit, 50_000_000); // 50 USDC in base units
        assertEq(wallet.remainingDailyAllowance(agent), 50_000_000);
    }

    function test_ownerCanUpdatePolicy() public {
        _addAgentWithPolicy();
        vm.prank(owner);
        wallet.setPolicy(agent, address(usdc), ONE_USDC, 5 * ONE_USDC);

        IAgentWallet.AgentInfo memory info = wallet.getAgent(agent);
        assertEq(info.maxPerTx, ONE_USDC);
        assertEq(info.dailyLimit, 5 * ONE_USDC);
    }

    function test_strangerCannotChangeLimits() public {
        _addAgentWithPolicy();
        vm.prank(stranger);
        vm.expectRevert("only owner");
        wallet.setPolicy(agent, address(usdc), type(uint256).max, type(uint256).max);
    }

    function test_agentCannotRaiseOwnLimits() public {
        _addAgentWithPolicy();
        vm.prank(agent);
        vm.expectRevert("only owner");
        wallet.setPolicy(agent, address(usdc), type(uint256).max, type(uint256).max);
        assertEq(wallet.getAgent(agent).dailyLimit, 50 * ONE_USDC);
    }

    function test_setPolicyRequiresActiveAgent() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.AgentNotValid.selector, agent));
        wallet.setPolicy(agent, address(usdc), ONE_USDC, ONE_USDC);
    }

    function test_spendingCounterResetsOnNewDay() public {
        _addAgentWithPolicy();
        _setSpent(20 * ONE_USDC, _today());
        assertEq(wallet.getAgent(agent).spentToday, 20 * ONE_USDC);
        assertEq(wallet.remainingDailyAllowance(agent), 30 * ONE_USDC);

        vm.warp(block.timestamp + 1 days);
        assertEq(wallet.getAgent(agent).spentToday, 0);
        assertEq(wallet.remainingDailyAllowance(agent), 50 * ONE_USDC);
    }

    function test_loweringLimitBelowSpentGivesZeroRemaining() public {
        _addAgentWithPolicy();
        _setSpent(20 * ONE_USDC, _today());
        vm.prank(owner);
        wallet.setPolicy(agent, address(usdc), ONE_USDC, 10 * ONE_USDC);
        assertEq(wallet.getAgent(agent).spentToday, 20 * ONE_USDC); // same token keeps the counter
        assertEq(wallet.remainingDailyAllowance(agent), 0);
    }

    function test_changingTokenResetsCounter() public {
        _addAgentWithPolicy();
        _setSpent(20 * ONE_USDC, _today());
        MockUSDC other = new MockUSDC();
        vm.prank(owner);
        wallet.setPolicy(agent, address(other), 10 * ONE_USDC, 50 * ONE_USDC);
        assertEq(wallet.getAgent(agent).spentToday, 0);
    }

    function test_remainingAllowanceZeroWhenNotValid() public {
        _addAgentWithPolicy();
        vm.warp(validUntil + 1);
        assertEq(wallet.remainingDailyAllowance(agent), 0);
    }

    // ---------------- allowlists ----------------

    function test_ownerCanAllowAndDisallowCall() public {
        _addAgent();
        bytes4 sel = MockMerchant.purchase.selector;

        vm.expectEmit(true, true, true, true, address(wallet));
        emit CallPermissionSet(agent, address(merchant), sel, true);
        vm.prank(owner);
        wallet.allowCall(agent, address(merchant), sel, true);
        assertTrue(wallet.isCallAllowed(agent, address(merchant), sel));
        assertFalse(wallet.isCallAllowed(agent, address(merchant), MockMerchant.quote.selector)); // per selector
        assertFalse(wallet.isCallAllowed(stranger, address(merchant), sel)); // per agent

        vm.prank(owner);
        wallet.allowCall(agent, address(merchant), sel, false);
        assertFalse(wallet.isCallAllowed(agent, address(merchant), sel));
    }

    function test_ownerCanAllowAndDisallowRecipient() public {
        _addAgent();
        vm.expectEmit(true, true, false, true, address(wallet));
        emit RecipientPermissionSet(agent, recipient, true);
        vm.prank(owner);
        wallet.allowRecipient(agent, recipient, true);
        assertTrue(wallet.isRecipientAllowed(agent, recipient));

        vm.prank(owner);
        wallet.allowRecipient(agent, recipient, false);
        assertFalse(wallet.isRecipientAllowed(agent, recipient));
    }

    function test_strangerAndAgentCannotChangeAllowlists() public {
        _addAgent();
        address[2] memory callers = [stranger, agent];
        for (uint256 i; i < callers.length; i++) {
            vm.startPrank(callers[i]);
            vm.expectRevert("only owner");
            wallet.allowCall(agent, address(merchant), MockMerchant.purchase.selector, true);
            vm.expectRevert("only owner");
            wallet.allowRecipient(agent, recipient, true);
            vm.stopPrank();
        }
    }

    function test_allowlistsRejectForbiddenTargets() public {
        _addAgent();
        address[3] memory bad = [address(0), address(wallet), address(entryPoint)];
        vm.startPrank(owner);
        for (uint256 i; i < bad.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(IAgentWallet.ForbiddenTarget.selector, bad[i]));
            wallet.allowCall(agent, bad[i], bytes4(0x12345678), true);
            vm.expectRevert(abi.encodeWithSelector(IAgentWallet.ForbiddenTarget.selector, bad[i]));
            wallet.allowRecipient(agent, bad[i], true);
        }
        vm.stopPrank();
    }

    function test_allowlistsRequireActiveAgent() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.AgentNotValid.selector, agent));
        wallet.allowCall(agent, address(merchant), MockMerchant.purchase.selector, true);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.AgentNotValid.selector, agent));
        wallet.allowRecipient(agent, recipient, true);
        vm.stopPrank();
    }

    // ---------------- revocation ----------------

    function test_ownerCanRevokeAgent() public {
        _addAgentWithPolicy();
        vm.startPrank(owner);
        wallet.allowCall(agent, address(merchant), MockMerchant.purchase.selector, true);
        wallet.allowRecipient(agent, recipient, true);

        vm.expectEmit(true, false, false, true, address(wallet));
        emit AgentRevoked(agent);
        wallet.revokeAgent(agent);
        vm.stopPrank();

        IAgentWallet.AgentInfo memory info = wallet.getAgent(agent);
        assertFalse(info.active);
        assertEq(info.token, address(0));
        assertEq(info.dailyLimit, 0);
        assertFalse(wallet.isAgentValid(agent));
        assertFalse(wallet.isCallAllowed(agent, address(merchant), MockMerchant.purchase.selector));
        assertFalse(wallet.isRecipientAllowed(agent, recipient));
        assertEq(wallet.remainingDailyAllowance(agent), 0);
    }

    function test_revokeIsImmediate() public {
        _addAgentWithPolicy();
        assertTrue(wallet.isAgentValid(agent));
        vm.prank(owner);
        wallet.revokeAgent(agent);
        assertFalse(wallet.isAgentValid(agent)); // same block, no delay
    }

    function test_strangerAndAgentCannotRevoke() public {
        _addAgent();
        address[2] memory callers = [stranger, agent];
        for (uint256 i; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert("only owner");
            wallet.revokeAgent(agent);
        }
        assertTrue(wallet.isAgentValid(agent));
    }

    function test_revokeUnknownAgentReverts() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.AgentNotValid.selector, agent));
        wallet.revokeAgent(agent);
    }

    function test_reAddedAgentStartsClean() public {
        _addAgentWithPolicy();
        vm.startPrank(owner);
        wallet.allowCall(agent, address(merchant), MockMerchant.purchase.selector, true);
        wallet.allowRecipient(agent, recipient, true);
        wallet.revokeAgent(agent);
        wallet.addAgent(agent, validAfter, validUntil);
        vm.stopPrank();

        IAgentWallet.AgentInfo memory info = wallet.getAgent(agent);
        assertTrue(info.active);
        assertEq(info.token, address(0));
        assertEq(info.dailyLimit, 0);
        assertFalse(wallet.isCallAllowed(agent, address(merchant), MockMerchant.purchase.selector));
        assertFalse(wallet.isRecipientAllowed(agent, recipient));
    }

    // ---------------- owner auth through the wallet itself and ERC-4337 ----------------

    function test_ownerCanAdministerViaExecuteSelfCall() public {
        vm.prank(owner);
        wallet.execute(address(wallet), 0, abi.encodeCall(IAgentWallet.addAgent, (agent, validAfter, validUntil)));
        assertTrue(wallet.isAgentValid(agent));
    }

    function test_ownerCanAdministerViaUserOperation() public {
        bytes memory callData = abi.encodeCall(
            SimpleAccount.execute,
            (address(wallet), 0, abi.encodeCall(IAgentWallet.addAgent, (agent, validAfter, validUntil)))
        );
        _handleOp(callData, ownerKey);
        assertTrue(wallet.isAgentValid(agent));
        assertEq(wallet.getNonce(), 1);
    }

    function test_agentSignedUserOperationIsRejected() public {
        _addAgentWithPolicy();
        bytes memory callData = abi.encodeCall(
            SimpleAccount.execute,
            (
                address(wallet),
                0,
                abi.encodeCall(IAgentWallet.setPolicy, (agent, address(usdc), type(uint256).max, type(uint256).max))
            )
        );
        PackedUserOperation[] memory ops = _signedOps(callData, agentKey);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA24 signature error"));
        entryPoint.handleOps(ops, payable(makeAddr("bundler")));
        assertEq(wallet.getAgent(agent).dailyLimit, 50 * ONE_USDC);
    }

    function test_executeAsAgentNotYetAvailable() public {
        _addAgentWithPolicy();
        vm.prank(agent);
        vm.expectRevert(AgentWallet.ExecutionNotImplemented.selector);
        wallet.executeAsAgent(agent, address(usdc), 0, "");
    }

    function _handleOp(bytes memory callData, uint256 signerKey) internal {
        entryPoint.handleOps(_signedOps(callData, signerKey), payable(makeAddr("bundler")));
    }

    function _signedOps(bytes memory callData, uint256 signerKey) internal returns (PackedUserOperation[] memory ops) {
        vm.deal(address(wallet), 1 ether);
        PackedUserOperation memory op = PackedUserOperation({
            sender: address(wallet),
            nonce: wallet.getNonce(),
            initCode: "",
            callData: callData,
            accountGasLimits: bytes32((uint256(200_000) << 128) | 200_000),
            preVerificationGas: 50_000,
            gasFees: bytes32((uint256(1 gwei) << 128) | 1 gwei),
            paymasterAndData: "",
            signature: ""
        });
        bytes32 hash = MessageHashUtils.toEthSignedMessageHash(entryPoint.getUserOpHash(op));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, hash);
        op.signature = abi.encodePacked(r, s, v);

        ops = new PackedUserOperation[](1);
        ops[0] = op;
    }
}
