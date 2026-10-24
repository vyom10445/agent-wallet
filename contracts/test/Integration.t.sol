// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IStakeManager} from "account-abstraction/interfaces/IStakeManager.sol";
import {INonceManager} from "account-abstraction/interfaces/INonceManager.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {SimpleAccount} from "account-abstraction/samples/SimpleAccount.sol";
import {AgentWallet} from "../src/AgentWallet.sol";
import {AgentWalletFactory} from "../src/AgentWalletFactory.sol";
import {IAgentWallet} from "../src/interfaces/IAgentWallet.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {MockMerchant} from "../src/MockMerchant.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {UserOps} from "../script/utils/UserOps.sol";

/// @notice Phase 8 integration: the deployed stack, end to end through EntryPoint v0.7 handleOps.
/// Every agent purchase here is a signed UserOperation submitted by a separate funded "bundler" account; the merchant
/// is never called directly.
contract IntegrationTest is Test {
    uint256 constant ONE_USDC = 1_000_000;
    uint256 constant MAX_PER_TX = 10 * ONE_USDC;
    uint256 constant DAILY_LIMIT = 25 * ONE_USDC;
    bytes32 constant USER_OPERATION_EVENT =
        keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");

    Deploy deployer;
    Deploy.Deployment d;

    address owner;
    uint256 ownerKey;
    address agent;
    uint256 agentKey;
    address bundler;

    event CreditsPurchased(uint256 indexed purchaseId, address indexed buyer, uint256 credits, uint256 amountPaid);
    event AgentSpent(
        address indexed agent, address indexed token, address indexed recipient, uint256 amount, uint256 spentToday
    );

    function setUp() public {
        vm.warp(1_700_006_400); // 00:00 UTC
        (owner, ownerKey) = makeAddrAndKey("owner");
        (agent, agentKey) = makeAddrAndKey("agent");
        bundler = makeAddr("bundler");
        vm.deal(owner, 10 ether);
        vm.deal(bundler, 10 ether);

        deployer = new Deploy();
        d = deployer.deploy(owner);
    }

    // ---------------- helpers ----------------

    /// @dev Stage 3 + 4 setup: owner configures the agent through an owner-signed UserOp, then funds the wallet.
    function _registerAgentAndFund() internal {
        address[] memory dest = new address[](5);
        bytes[] memory func = new bytes[](5);
        (dest[0], func[0]) =
        (
            address(d.wallet),
            abi.encodeCall(IAgentWallet.addAgent, (agent, uint48(block.timestamp), uint48(block.timestamp + 30 days)))
        );
        (dest[1], func[1]) =
        (address(d.wallet), abi.encodeCall(IAgentWallet.setPolicy, (agent, address(d.usdc), MAX_PER_TX, DAILY_LIMIT)));
        (dest[2], func[2]) =
        (
            address(d.wallet),
            abi.encodeCall(IAgentWallet.allowCall, (agent, address(d.merchant), MockMerchant.purchase.selector, true))
        );
        (dest[3], func[3]) =
        (address(d.wallet), abi.encodeCall(IAgentWallet.allowRecipient, (agent, address(d.merchant), true)));
        (dest[4], func[4]) = (address(d.usdc), abi.encodeCall(IERC20.approve, (address(d.merchant), 100 * ONE_USDC)));

        vm.prank(owner);
        d.wallet.addDeposit{value: 1 ether}(); // gas for UserOps
        _ownerOp(abi.encodeCall(SimpleAccount.executeBatch, (dest, new uint256[](0), func)));

        d.usdc.mint(address(d.wallet), 100 * ONE_USDC);
    }

    function _ownerOp(bytes memory callData) internal returns (bool success) {
        PackedUserOperation memory op = UserOps.build(address(d.wallet), d.wallet.getNonce(), callData);
        op.signature = UserOps.sign(d.entryPoint, op, ownerKey);
        return _submit(op);
    }

    function _agentPurchase(uint256 credits) internal returns (bool success) {
        bytes memory data = abi.encodeCall(MockMerchant.purchase, (credits, d.merchant.quote(credits)));
        return
            _submit(
                UserOps.agentPurchaseOp(d.entryPoint, address(d.wallet), agent, agentKey, address(d.merchant), data)
            );
    }

    /// @dev Bundler fallback: a funded EOA calls EntryPoint.handleOps directly. Returns UserOperationEvent.success.
    function _submit(PackedUserOperation memory op) internal returns (bool success) {
        vm.recordLogs();
        vm.prank(bundler, bundler);
        // same transaction gas limit the live demo uses, so an AA95 out-of-gas bundle would fail here too
        d.entryPoint.handleOps{gas: UserOps.bundleGasLimit()}(UserOps.single(op), payable(bundler));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(d.entryPoint) && logs[i].topics[0] == USER_OPERATION_EVENT) {
                (, success,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
                return success;
            }
        }
        revert("no UserOperationEvent");
    }

    // ---------------- environment ----------------

    function test_env_entryPointIsV07() public view {
        bytes4 v07Id = type(IEntryPoint).interfaceId ^ type(IStakeManager).interfaceId ^ type(INonceManager).interfaceId;
        assertTrue(EntryPoint(payable(address(d.entryPoint))).supportsInterface(v07Id));
        assertEq(address(d.wallet.entryPoint()), address(d.entryPoint));
        assertEq(address(d.factory.accountImplementation().entryPoint()), address(d.entryPoint));
    }

    function test_env_signatureFormat() public {
        _registerAgentAndFund();
        bytes memory data = abi.encodeCall(MockMerchant.purchase, (100, d.merchant.quote(100)));
        PackedUserOperation memory op =
            UserOps.agentPurchaseOp(d.entryPoint, address(d.wallet), agent, agentKey, address(d.merchant), data);

        // userOpHash binds this EntryPoint and chain
        bytes32 hash = d.entryPoint.getUserOpHash(op);
        op.sender = address(1);
        assertTrue(d.entryPoint.getUserOpHash(op) != hash);
        op.sender = address(d.wallet);

        // raw signature over the hash without the EIP-191 prefix is rejected
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentKey, hash);
        op.signature = abi.encodePacked(r, s, v);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA24 signature error"));
        d.entryPoint.handleOps(UserOps.single(op), payable(bundler));

        // 65-byte r||s||v over the EIP-191 digest is accepted
        op.signature = UserOps.sign(d.entryPoint, op, agentKey);
        assertEq(op.signature.length, 65);
        assertTrue(_submit(op));
    }

    // ---------------- stages ----------------

    function test_stage1_deploysToExpectedAddresses() public view {
        assertEq(address(d.entryPoint), deployer.expectedAddress(type(EntryPoint).creationCode));
        assertEq(
            address(d.factory),
            deployer.expectedAddress(abi.encodePacked(type(AgentWalletFactory).creationCode, abi.encode(d.entryPoint)))
        );
        assertEq(address(d.usdc), deployer.expectedAddress(type(MockUSDC).creationCode));
        assertEq(
            address(d.merchant),
            deployer.expectedAddress(
                abi.encodePacked(type(MockMerchant).creationCode, abi.encode(d.usdc, uint256(10_000)))
            )
        );
        assertEq(address(d.wallet), d.factory.getAddress(owner, 0));
        assertGt(address(d.wallet).code.length, 0);
    }

    function test_stage1_deployIsIdempotent() public {
        Deploy.Deployment memory again = deployer.deploy(owner);
        assertEq(address(again.entryPoint), address(d.entryPoint));
        assertEq(address(again.wallet), address(d.wallet));
    }

    function test_stage2_walletInitializedWithOwner() public {
        assertEq(d.wallet.owner(), owner);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        d.wallet.initialize(makeAddr("attacker"));
        AgentWallet impl = d.factory.accountImplementation();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(makeAddr("attacker"));
    }

    function test_stage3_agentRegisteredWithPolicy() public {
        _registerAgentAndFund();
        IAgentWallet.AgentInfo memory info = d.wallet.getAgent(agent);
        assertTrue(info.active);
        assertTrue(d.wallet.isAgentValid(agent));
        assertEq(info.token, address(d.usdc));
        assertEq(info.maxPerTx, MAX_PER_TX);
        assertEq(info.dailyLimit, DAILY_LIMIT);
        assertTrue(d.wallet.isCallAllowed(agent, address(d.merchant), MockMerchant.purchase.selector));
        assertTrue(d.wallet.isRecipientAllowed(agent, address(d.merchant)));
    }

    function test_stage4_walletFundedWithMockUSDC() public {
        _registerAgentAndFund();
        assertEq(d.usdc.balanceOf(address(d.wallet)), 100 * ONE_USDC);
        assertEq(d.usdc.allowance(address(d.wallet), address(d.merchant)), 100 * ONE_USDC);
        assertGt(d.wallet.getDeposit(), 0); // EntryPoint deposit pays for UserOps
    }

    function test_stage5to7_agentPurchaseThroughEntryPoint() public {
        _registerAgentAndFund();

        vm.expectEmit(true, true, false, true, address(d.merchant));
        emit CreditsPurchased(1, address(d.wallet), 500, 5 * ONE_USDC);
        vm.expectEmit(true, true, true, true, address(d.wallet));
        emit AgentSpent(agent, address(d.usdc), address(d.merchant), 5 * ONE_USDC, 5 * ONE_USDC);
        assertTrue(_agentPurchase(500)); // stage 5

        assertEq(d.merchant.creditsOf(address(d.wallet)), 500); // stage 6
        assertEq(d.merchant.purchaseCount(), 1);
        assertEq(d.usdc.balanceOf(address(d.wallet)), 95 * ONE_USDC); // stage 7
        assertEq(d.usdc.balanceOf(address(d.merchant)), 5 * ONE_USDC);
        assertEq(d.wallet.getAgent(agent).spentToday, 5 * ONE_USDC);
        assertEq(d.wallet.remainingDailyAllowance(agent), 20 * ONE_USDC);
    }

    function test_stage8_overLimitPaymentDoesNotComplete() public {
        _registerAgentAndFund();
        assertTrue(_agentPurchase(500)); // 5 USDC, spent 5

        // above maxPerTx (11 > 10): the EntryPoint includes the op but the payment reverts
        assertFalse(_agentPurchase(1100));
        assertEq(d.merchant.creditsOf(address(d.wallet)), 500);
        assertEq(d.usdc.balanceOf(address(d.wallet)), 95 * ONE_USDC);

        assertTrue(_agentPurchase(1000)); // spent 15
        assertTrue(_agentPurchase(1000)); // spent 25 = daily limit

        // crosses the daily limit: even 1 credit (0.01 USDC) is refused
        assertFalse(_agentPurchase(1));
        assertEq(d.merchant.creditsOf(address(d.wallet)), 2500);
        assertEq(d.merchant.purchaseCount(), 3);
        assertEq(d.usdc.balanceOf(address(d.wallet)), 75 * ONE_USDC);
        assertEq(d.wallet.getAgent(agent).spentToday, DAILY_LIMIT);
    }

    function test_stage9_revokedAgentCannotPurchase() public {
        _registerAgentAndFund();
        assertTrue(_agentPurchase(500));

        assertTrue(
            _ownerOp(
                abi.encodeCall(
                    SimpleAccount.execute, (address(d.wallet), 0, abi.encodeCall(IAgentWallet.revokeAgent, (agent)))
                )
            )
        );

        bytes memory data = abi.encodeCall(MockMerchant.purchase, (500, d.merchant.quote(500)));
        PackedUserOperation memory op =
            UserOps.agentPurchaseOp(d.entryPoint, address(d.wallet), agent, agentKey, address(d.merchant), data);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA24 signature error"));
        d.entryPoint.handleOps(UserOps.single(op), payable(bundler));

        assertEq(d.merchant.creditsOf(address(d.wallet)), 500);
        assertEq(d.usdc.balanceOf(address(d.wallet)), 95 * ONE_USDC);
    }

    function test_stage10_ownerExecutionPathStillWorks() public {
        _registerAgentAndFund();
        address treasury = makeAddr("treasury");
        // through the EntryPoint
        assertTrue(
            _ownerOp(
                abi.encodeCall(
                    SimpleAccount.execute,
                    (address(d.usdc), 0, abi.encodeCall(IERC20.transfer, (treasury, 30 * ONE_USDC)))
                )
            )
        );
        // directly from the owner EOA
        vm.prank(owner);
        d.wallet.execute(address(d.usdc), 0, abi.encodeCall(IERC20.transfer, (treasury, 20 * ONE_USDC)));
        assertEq(d.usdc.balanceOf(treasury), 50 * ONE_USDC);
        assertEq(d.wallet.getAgent(agent).spentToday, 0); // owner spending is not agent spending
    }
}
