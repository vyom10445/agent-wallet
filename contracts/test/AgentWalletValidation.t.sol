// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IStakeManager} from "account-abstraction/interfaces/IStakeManager.sol";
import {IAccountExecute} from "account-abstraction/interfaces/IAccountExecute.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {SimpleAccount} from "account-abstraction/samples/SimpleAccount.sol";
import {AgentWallet} from "../src/AgentWallet.sol";
import {IAgentWallet} from "../src/interfaces/IAgentWallet.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {MockMerchant} from "../src/MockMerchant.sol";

/// @dev Simple non-spending target for agent calls.
contract Target {
    uint256 public pings;
    address public lastCaller;

    function ping() external {
        pings++;
        lastCaller = msg.sender;
    }

    function other() external {}
}

/// @dev Allowed target that moves the wallet's tokens through a pre-existing allowance.
contract Puller {
    function pull(IERC20 token, address from, uint256 amount) external {
        require(token.transferFrom(from, address(this), amount));
    }
}

/// @notice Phase 6: ERC-4337 validation and agent authorization.
contract AgentWalletValidationTest is Test {
    uint256 constant ONE_USDC = 1_000_000;
    uint48 constant START = 1_700_000_000;
    string constant AA24 = "AA24 signature error";
    string constant AA22 = "AA22 expired or not due";

    EntryPoint entryPoint;
    AgentWallet wallet;
    MockUSDC usdc;
    MockMerchant merchant;
    Target target;

    address owner;
    uint256 ownerKey;
    address agent;
    uint256 agentKey;
    address agent2;
    uint256 agent2Key;
    address stranger;
    uint256 strangerKey;
    address bundler = makeAddr("bundler");

    event AgentExecuted(address indexed agent, address indexed target, bytes4 indexed selector, uint256 value);

    function setUp() public {
        vm.warp(START);
        (owner, ownerKey) = makeAddrAndKey("owner");
        (agent, agentKey) = makeAddrAndKey("agent");
        (agent2, agent2Key) = makeAddrAndKey("agent2");
        (stranger, strangerKey) = makeAddrAndKey("stranger");

        entryPoint = new EntryPoint();
        AgentWallet impl = new AgentWallet(entryPoint);
        wallet =
            AgentWallet(payable(new ERC1967Proxy(address(impl), abi.encodeCall(SimpleAccount.initialize, (owner)))));
        vm.deal(address(wallet), 10 ether);
        usdc = new MockUSDC();
        merchant = new MockMerchant(usdc, 10_000);
        target = new Target();
        usdc.mint(address(wallet), 100 * ONE_USDC);

        vm.startPrank(owner);
        wallet.addAgent(agent, START, START + 7 days);
        wallet.setPolicy(agent, address(usdc), 10 * ONE_USDC, 50 * ONE_USDC);
        wallet.allowCall(agent, address(target), Target.ping.selector, true);
        wallet.addAgent(agent2, START, START + 7 days);
        vm.stopPrank();
    }

    // ---------------- helpers ----------------

    function _agentNonce(address a) internal view returns (uint256) {
        return entryPoint.getNonce(address(wallet), uint192(uint160(a)));
    }

    function _op(bytes memory callData, uint256 nonce, uint256 key)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op = PackedUserOperation({
            sender: address(wallet),
            nonce: nonce,
            initCode: "",
            callData: callData,
            accountGasLimits: bytes32((uint256(300_000) << 128) | 300_000),
            preVerificationGas: 50_000,
            gasFees: bytes32((uint256(1 gwei) << 128) | 1 gwei),
            paymasterAndData: "",
            signature: ""
        });
        op.signature = _sign(op, key);
    }

    function _sign(PackedUserOperation memory op, uint256 key) internal view returns (bytes memory) {
        bytes32 hash = MessageHashUtils.toEthSignedMessageHash(entryPoint.getUserOpHash(op));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, hash);
        return abi.encodePacked(r, s, v);
    }

    function _agentCall(address a, address to, uint256 value, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodeCall(IAgentWallet.executeAsAgent, (a, to, value, data));
    }

    function _ping() internal pure returns (bytes memory) {
        return abi.encodeCall(Target.ping, ());
    }

    function _handle(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        entryPoint.handleOps(ops, payable(bundler));
    }

    function _expectFailedOp(PackedUserOperation memory op, string memory reason) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, reason));
        entryPoint.handleOps(ops, payable(bundler));
    }

    /// @dev Agent-signed UserOp that must be rejected during validation.
    function _expectAgentOpRejected(bytes memory callData) internal {
        _expectFailedOp(_op(callData, _agentNonce(agent), agentKey), AA24);
    }

    // ---------------- owner path preserved ----------------

    function test_validOwnerOperationAccepted() public {
        bytes memory callData = abi.encodeCall(
            SimpleAccount.execute, (address(usdc), 0, abi.encodeCall(IERC20.transfer, (owner, ONE_USDC)))
        );
        _handle(_op(callData, wallet.getNonce(), ownerKey));
        assertEq(usdc.balanceOf(owner), ONE_USDC);
        assertEq(wallet.getNonce(), 1);
    }

    function test_ownerOperationReturnsPlainSuccess() public {
        PackedUserOperation memory op = _op(abi.encodeCall(SimpleAccount.execute, (owner, 0, "")), 0, ownerKey);
        bytes32 hash = entryPoint.getUserOpHash(op);
        vm.prank(address(entryPoint));
        assertEq(wallet.validateUserOp(op, hash, 0), 0); // no time range, unchanged
    }

    function test_ownerCanStillUseExecuteBatch() public {
        address[] memory dest = new address[](2);
        bytes[] memory func = new bytes[](2);
        dest[0] = address(target);
        dest[1] = address(target);
        func[0] = _ping();
        func[1] = _ping();
        bytes memory callData = abi.encodeCall(SimpleAccount.executeBatch, (dest, new uint256[](0), func));
        _handle(_op(callData, wallet.getNonce(), ownerKey));
        assertEq(target.pings(), 2);
    }

    function test_ownerCanAdministerViaSelfCallUserOp() public {
        bytes memory callData = abi.encodeCall(
            SimpleAccount.execute, (address(wallet), 0, abi.encodeCall(IAgentWallet.revokeAgent, (agent)))
        );
        _handle(_op(callData, wallet.getNonce(), ownerKey));
        assertFalse(wallet.isAgentValid(agent));
    }

    // ---------------- valid agent operations ----------------

    function test_validAgentOperationAccepted() public {
        vm.expectEmit(true, true, true, true, address(wallet));
        emit AgentExecuted(agent, address(target), Target.ping.selector, 0);
        _handle(_op(_agentCall(agent, address(target), 0, _ping()), _agentNonce(agent), agentKey));

        assertEq(target.pings(), 1);
        assertEq(target.lastCaller(), address(wallet));
        assertEq(_agentNonce(agent), (uint256(uint160(agent)) << 64) | 1);
        assertEq(wallet.getNonce(), 0); // owner's key-0 nonce untouched
    }

    function test_agentValidationDataCarriesWindow() public {
        PackedUserOperation memory op =
            _op(_agentCall(agent, address(target), 0, _ping()), _agentNonce(agent), agentKey);
        bytes32 hash = entryPoint.getUserOpHash(op);
        vm.prank(address(entryPoint));
        uint256 vd = wallet.validateUserOp(op, hash, 0);
        assertEq(vd & type(uint160).max, 0); // signature ok, no aggregator
        assertEq(vd >> 160 & type(uint48).max, START + 7 days); // validUntil
        assertEq(vd >> 208, START); // validAfter
    }

    function test_agentCanCallDirectly() public {
        vm.prank(agent);
        wallet.executeAsAgent(agent, address(target), 0, _ping());
        assertEq(target.pings(), 1);
    }

    function test_agentOperationReplayRejected() public {
        PackedUserOperation memory op =
            _op(_agentCall(agent, address(target), 0, _ping()), _agentNonce(agent), agentKey);
        _handle(op);
        _expectFailedOp(op, "AA25 invalid account nonce");
    }

    // ---------------- invalid signatures ----------------

    function test_strangerSignatureRejected() public {
        _expectFailedOp(_op(_agentCall(agent, address(target), 0, _ping()), _agentNonce(agent), strangerKey), AA24);
    }

    function test_signatureOverDifferentOpRejected() public {
        PackedUserOperation memory op =
            _op(_agentCall(agent, address(target), 0, _ping()), _agentNonce(agent), agentKey);
        op.callData = _agentCall(agent, address(target), 0, abi.encodeCall(Target.other, ()));
        _expectFailedOp(op, AA24);
    }

    function test_malformedSignatureReverts() public {
        PackedUserOperation memory op =
            _op(_agentCall(agent, address(target), 0, _ping()), _agentNonce(agent), agentKey);
        op.signature = hex"1234";
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.expectPartialRevert(IEntryPoint.FailedOpWithRevert.selector); // AA23, same as SimpleAccount
        entryPoint.handleOps(ops, payable(bundler));
    }

    function test_agentCannotSignForAnotherAgent() public {
        // agent2 signs an op that claims to be `agent`
        _expectFailedOp(_op(_agentCall(agent, address(target), 0, _ping()), _agentNonce(agent2), agent2Key), AA24);
    }

    // ---------------- inactive, revoked, expired ----------------

    function test_revokedAgentRejected() public {
        vm.prank(owner);
        wallet.revokeAgent(agent);
        _expectAgentOpRejected(_agentCall(agent, address(target), 0, _ping()));

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.AgentNotValid.selector, agent));
        wallet.executeAsAgent(agent, address(target), 0, _ping());
    }

    function test_unregisteredSignerRejected() public {
        _expectFailedOp(
            _op(_agentCall(stranger, address(target), 0, _ping()), _agentNonce(stranger), strangerKey), AA24
        );
    }

    function test_expiredAgentRejectedByEntryPoint() public {
        PackedUserOperation memory op =
            _op(_agentCall(agent, address(target), 0, _ping()), _agentNonce(agent), agentKey);
        vm.warp(START + 7 days + 1);
        _expectFailedOp(op, AA22);
    }

    function test_notYetValidAgentRejectedByEntryPoint() public {
        vm.startPrank(owner);
        wallet.revokeAgent(agent);
        wallet.addAgent(agent, START + 1 days, START + 2 days);
        wallet.allowCall(agent, address(target), Target.ping.selector, true);
        vm.stopPrank();
        _expectFailedOp(_op(_agentCall(agent, address(target), 0, _ping()), _agentNonce(agent), agentKey), AA22);

        vm.warp(START + 1 days);
        _handle(_op(_agentCall(agent, address(target), 0, _ping()), _agentNonce(agent), agentKey));
        assertEq(target.pings(), 1);
    }

    function test_expiredAgentRejectedOnDirectCall() public {
        vm.warp(START + 7 days + 1);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.AgentNotValid.selector, agent));
        wallet.executeAsAgent(agent, address(target), 0, _ping());
    }

    // ---------------- targets and selectors ----------------

    function test_unauthorizedTargetRejected() public {
        Target otherTarget = new Target();
        _expectAgentOpRejected(_agentCall(agent, address(otherTarget), 0, _ping()));

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentWallet.CallNotAllowed.selector, agent, address(otherTarget), Target.ping.selector
            )
        );
        wallet.executeAsAgent(agent, address(otherTarget), 0, _ping());
    }

    function test_unauthorizedSelectorRejected() public {
        bytes memory data = abi.encodeCall(Target.other, ());
        _expectAgentOpRejected(_agentCall(agent, address(target), 0, data));

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentWallet.CallNotAllowed.selector, agent, address(target), Target.other.selector)
        );
        wallet.executeAsAgent(agent, address(target), 0, data);
    }

    function test_permissionsArePerAgent() public {
        // agent2 has no allowlist entries
        _expectFailedOp(_op(_agentCall(agent2, address(target), 0, _ping()), _agentNonce(agent2), agent2Key), AA24);
    }

    function test_emptyCalldataRejected() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.CallNotAllowed.selector, agent, address(target), bytes4(0)));
        wallet.executeAsAgent(agent, address(target), 0, "");
    }

    function test_nativeValueRejected() public {
        _expectAgentOpRejected(_agentCall(agent, address(target), 1, _ping()));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.NativeValueNotAllowed.selector, 1));
        wallet.executeAsAgent(agent, address(target), 1, _ping());
    }

    // ---------------- administrative and inherited functions (B1-B4, B10) ----------------

    function test_agentCannotSignExecute() public {
        _expectAgentOpRejected(abi.encodeCall(SimpleAccount.execute, (address(target), 0, _ping())));
    }

    function test_agentCannotSignExecuteBatch() public {
        address[] memory dest = new address[](1);
        bytes[] memory func = new bytes[](1);
        dest[0] = address(target);
        func[0] = _ping();
        _expectAgentOpRejected(abi.encodeCall(SimpleAccount.executeBatch, (dest, new uint256[](0), func)));
    }

    function test_agentCannotSignAdminFunctions() public {
        _expectAgentOpRejected(abi.encodeCall(IAgentWallet.setPolicy, (agent, address(usdc), 1e30, 1e30)));
        _expectAgentOpRejected(
            abi.encodeCall(IAgentWallet.allowCall, (agent, address(usdc), IERC20.approve.selector, true))
        );
        _expectAgentOpRejected(abi.encodeCall(IAgentWallet.addAgent, (stranger, START, START + 1)));
        _expectAgentOpRejected(abi.encodeCall(SimpleAccount.withdrawDepositTo, (payable(agent), 1)));
        _expectAgentOpRejected(abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (address(target), "")));
    }

    function test_agentCannotUseExecuteUserOpSelector() public {
        _expectAgentOpRejected(
            abi.encodePacked(IAccountExecute.executeUserOp.selector, _agentCall(agent, address(target), 0, _ping()))
        );
    }

    function test_agentCannotTargetWalletItself() public {
        bytes memory admin = abi.encodeCall(IAgentWallet.setPolicy, (agent, address(usdc), 1e30, 1e30));
        _expectAgentOpRejected(_agentCall(agent, address(wallet), 0, admin));

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.ForbiddenTarget.selector, address(wallet)));
        wallet.executeAsAgent(agent, address(wallet), 0, admin);

        bytes memory upgrade = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (address(target), ""));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.ForbiddenTarget.selector, address(wallet)));
        wallet.executeAsAgent(agent, address(wallet), 0, upgrade);
        assertEq(wallet.getAgent(agent).dailyLimit, 50 * ONE_USDC);
    }

    function test_agentCannotTargetEntryPoint() public {
        bytes memory withdraw = abi.encodeCall(IStakeManager.withdrawTo, (payable(agent), 1));
        _expectAgentOpRejected(_agentCall(agent, address(entryPoint), 0, withdraw));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.ForbiddenTarget.selector, address(entryPoint)));
        wallet.executeAsAgent(agent, address(entryPoint), 0, withdraw);
    }

    function test_agentCannotCallAdminDirectly() public {
        vm.startPrank(agent);
        vm.expectRevert("only owner");
        wallet.setPolicy(agent, address(usdc), 1e30, 1e30);
        vm.expectRevert("account: not Owner or EntryPoint");
        wallet.execute(address(target), 0, _ping());
        vm.expectRevert("only owner");
        wallet.withdrawDepositTo(payable(agent), 1);
        vm.stopPrank();
    }

    // ---------------- caller binding (B7) ----------------

    function test_directCallerMustBeTheAgent() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.UnauthorizedCaller.selector, stranger));
        wallet.executeAsAgent(agent, address(target), 0, _ping());

        vm.prank(agent2);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.UnauthorizedCaller.selector, agent2));
        wallet.executeAsAgent(agent, address(target), 0, _ping());
    }

    // ---------------- policy token stays locked until spend limits exist (B5) ----------------

    function test_agentCannotApproveOrPullPolicyToken() public {
        bytes memory approve = abi.encodeCall(IERC20.approve, (stranger, type(uint256).max));
        _expectAgentOpRejected(_agentCall(agent, address(usdc), 0, approve));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.InvalidTokenCall.selector, IERC20.approve.selector));
        wallet.executeAsAgent(agent, address(usdc), 0, approve);
        assertEq(usdc.allowance(address(wallet), stranger), 0);
    }

    function test_agentTransferOfPolicyTokenNotEnabledYet() public {
        bytes memory transfer = abi.encodeCall(IERC20.transfer, (stranger, ONE_USDC));
        _expectAgentOpRejected(_agentCall(agent, address(usdc), 0, transfer));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentWallet.SpendingNotEnabled.selector, agent, address(usdc)));
        wallet.executeAsAgent(agent, address(usdc), 0, transfer);
    }

    function test_allowedCallThatSpendsPolicyTokenReverts() public {
        // Owner approved a merchant-like contract and allowed the agent to call it. Until spend limits exist,
        // any decrease of the policy token balance during an agent call is rejected.
        Puller puller = new Puller();
        vm.startPrank(owner);
        wallet.execute(address(usdc), 0, abi.encodeCall(IERC20.approve, (address(puller), 5 * ONE_USDC)));
        wallet.allowCall(agent, address(puller), Puller.pull.selector, true);
        vm.stopPrank();

        bytes memory pull = abi.encodeCall(Puller.pull, (IERC20(address(usdc)), address(wallet), ONE_USDC));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentWallet.SpendingNotEnabled.selector, agent, address(usdc)));
        wallet.executeAsAgent(agent, address(puller), 0, pull);
        assertEq(usdc.balanceOf(address(wallet)), 100 * ONE_USDC);
    }

    function test_agentRevokedAfterSigningIsRejected() public {
        PackedUserOperation memory op =
            _op(_agentCall(agent, address(target), 0, _ping()), _agentNonce(agent), agentKey);
        vm.prank(owner);
        wallet.revokeAgent(agent);
        _expectFailedOp(op, AA24);
        assertEq(target.pings(), 0);
    }

    function test_executionRechecksPolicyAfterValidation() public {
        // Same bundle: the owner's op revokes the agent, the agent's op was already validated (validation of all
        // ops runs before execution). executeAsAgent re-checks and reverts, so the agent call has no effect.
        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _op(
            abi.encodeCall(
                SimpleAccount.execute, (address(wallet), 0, abi.encodeCall(IAgentWallet.revokeAgent, (agent)))
            ),
            wallet.getNonce(),
            ownerKey
        );
        ops[1] = _op(_agentCall(agent, address(target), 0, _ping()), _agentNonce(agent), agentKey);

        vm.expectEmit(false, true, false, true, address(entryPoint));
        emit IEntryPoint.UserOperationRevertReason(
            bytes32(0),
            address(wallet),
            ops[1].nonce,
            abi.encodeWithSelector(IAgentWallet.AgentNotValid.selector, agent)
        );
        entryPoint.handleOps(ops, payable(bundler));

        assertFalse(wallet.isAgentValid(agent));
        assertEq(target.pings(), 0);
    }
}
