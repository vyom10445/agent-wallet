// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {SimpleAccount} from "account-abstraction/samples/SimpleAccount.sol";
import {AgentWallet} from "../src/AgentWallet.sol";
import {IAgentWallet} from "../src/interfaces/IAgentWallet.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {MockMerchant} from "../src/MockMerchant.sol";

/// @dev Allowlisted contract that pulls the wallet's tokens to an arbitrary address through an allowance.
contract Drainer {
    function drain(IERC20 token, address from, address to, uint256 amount) external {
        require(token.transferFrom(from, to, amount));
    }
}

/// @notice Phase 7: restricted execution path, spend limits and daily accounting, end to end through the EntryPoint.
contract AgentWalletSpendingTest is Test {
    uint256 constant ONE_USDC = 1_000_000;
    uint256 constant MAX_PER_TX = 10 * ONE_USDC;
    uint256 constant DAILY_LIMIT = 25 * ONE_USDC;
    uint48 constant START = 1_700_006_400; // 2023-11-15 00:00:00 UTC, start of a day
    string constant AA24 = "AA24 signature error";

    EntryPoint entryPoint;
    AgentWallet wallet;
    MockUSDC usdc;
    MockMerchant merchant;

    address owner;
    uint256 ownerKey;
    address agent;
    uint256 agentKey;
    address agent2;
    uint256 agent2Key;
    address recipient = makeAddr("recipient");
    address stranger = makeAddr("stranger");
    address bundler = makeAddr("bundler");

    event AgentSpent(
        address indexed agent, address indexed token, address indexed recipient, uint256 amount, uint256 spentToday
    );

    function setUp() public {
        vm.warp(START);
        (owner, ownerKey) = makeAddrAndKey("owner");
        (agent, agentKey) = makeAddrAndKey("agent");
        (agent2, agent2Key) = makeAddrAndKey("agent2");

        entryPoint = new EntryPoint();
        AgentWallet impl = new AgentWallet(entryPoint);
        wallet =
            AgentWallet(payable(new ERC1967Proxy(address(impl), abi.encodeCall(SimpleAccount.initialize, (owner)))));
        vm.deal(address(wallet), 10 ether);
        usdc = new MockUSDC();
        merchant = new MockMerchant(usdc, 10_000); // 0.01 USDC per credit
        usdc.mint(address(wallet), 100 * ONE_USDC);

        vm.startPrank(owner);
        wallet.addAgent(agent, START, START + 30 days);
        wallet.setPolicy(agent, address(usdc), MAX_PER_TX, DAILY_LIMIT);
        wallet.allowRecipient(agent, recipient, true);
        wallet.allowCall(agent, address(merchant), MockMerchant.purchase.selector, true);
        wallet.allowRecipient(agent, address(merchant), true);
        // owner-only: cap what the merchant may pull
        wallet.execute(address(usdc), 0, abi.encodeCall(IERC20.approve, (address(merchant), 100 * ONE_USDC)));
        vm.stopPrank();
    }

    // ---------------- helpers ----------------

    function _op(bytes memory callData, uint256 key, address nonceKey)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op = PackedUserOperation({
            sender: address(wallet),
            nonce: entryPoint.getNonce(address(wallet), uint192(uint160(nonceKey))),
            initCode: "",
            callData: callData,
            accountGasLimits: bytes32((uint256(400_000) << 128) | 400_000),
            preVerificationGas: 50_000,
            gasFees: bytes32((uint256(1 gwei) << 128) | 1 gwei),
            paymasterAndData: "",
            signature: ""
        });
        bytes32 hash = MessageHashUtils.toEthSignedMessageHash(entryPoint.getUserOpHash(op));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, hash);
        op.signature = abi.encodePacked(r, s, v);
    }

    function _agentOp(address to, bytes memory data) internal view returns (PackedUserOperation memory) {
        return _op(abi.encodeCall(IAgentWallet.executeAsAgent, (agent, to, 0, data)), agentKey, agent);
    }

    function _transfer(address to, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeCall(IERC20.transfer, (to, amount));
    }

    function _purchase(uint256 credits) internal view returns (bytes memory) {
        return abi.encodeCall(MockMerchant.purchase, (credits, merchant.quote(credits)));
    }

    function _handle(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        entryPoint.handleOps(ops, payable(bundler));
    }

    /// @dev Op passes validation but its execution reverts with `reason`; the EntryPoint records it and moves on.
    function _handleExpectingExecutionRevert(PackedUserOperation memory op, bytes memory reason) internal {
        vm.expectEmit(true, true, false, true, address(entryPoint));
        emit IEntryPoint.UserOperationRevertReason(entryPoint.getUserOpHash(op), address(wallet), op.nonce, reason);
        _handle(op);
    }

    function _expectRejectedInValidation(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, AA24));
        entryPoint.handleOps(ops, payable(bundler));
    }

    function _spent() internal view returns (uint256) {
        return wallet.getAgent(agent).spentToday;
    }

    // ---------------- successful spending ----------------

    function test_transferWithinLimits() public {
        vm.expectEmit(true, true, true, true, address(wallet));
        emit AgentSpent(agent, address(usdc), recipient, 5 * ONE_USDC, 5 * ONE_USDC);
        _handle(_agentOp(address(usdc), _transfer(recipient, 5 * ONE_USDC)));

        assertEq(usdc.balanceOf(recipient), 5 * ONE_USDC);
        assertEq(usdc.balanceOf(address(wallet)), 95 * ONE_USDC);
        assertEq(_spent(), 5 * ONE_USDC);
        assertEq(wallet.remainingDailyAllowance(agent), 20 * ONE_USDC);
    }

    function test_purchaseWithinLimits() public {
        vm.expectEmit(true, true, true, true, address(wallet));
        emit AgentSpent(agent, address(usdc), address(merchant), 5 * ONE_USDC, 5 * ONE_USDC);
        _handle(_agentOp(address(merchant), _purchase(500)));

        assertEq(merchant.creditsOf(address(wallet)), 500);
        assertEq(usdc.balanceOf(address(merchant)), 5 * ONE_USDC);
        assertEq(usdc.balanceOf(address(wallet)), 95 * ONE_USDC);
        assertEq(_spent(), 5 * ONE_USDC);
    }

    function test_exactlyMaxPerTxAndExactlyDailyLimitAllowed() public {
        _handle(_agentOp(address(merchant), _purchase(1000))); // 10 USDC = maxPerTx
        _handle(_agentOp(address(merchant), _purchase(1000))); // 20
        _handle(_agentOp(address(usdc), _transfer(recipient, 5 * ONE_USDC))); // 25 = dailyLimit
        assertEq(_spent(), DAILY_LIMIT);
        assertEq(wallet.remainingDailyAllowance(agent), 0);
    }

    /// @notice Acceptance: a permitted purchase succeeds and an otherwise identical purchase that breaks the policy fails.
    function test_identicalPurchaseAcceptedThenRejectedByDailyLimit() public {
        _handle(_agentOp(address(merchant), _purchase(1000))); // 10
        _handle(_agentOp(address(merchant), _purchase(1000))); // 20

        PackedUserOperation memory third = _agentOp(address(merchant), _purchase(1000)); // would be 30 > 25
        _handleExpectingExecutionRevert(
            third, abi.encodeWithSelector(IAgentWallet.ExceedsDailyLimit.selector, 10 * ONE_USDC, 5 * ONE_USDC)
        );
        assertEq(merchant.creditsOf(address(wallet)), 2000);
        assertEq(usdc.balanceOf(address(wallet)), 80 * ONE_USDC);
        assertEq(_spent(), 20 * ONE_USDC);
    }

    // ---------------- maxPerTx ----------------

    function test_transferAboveMaxPerTxRejectedInValidation() public {
        _expectRejectedInValidation(_agentOp(address(usdc), _transfer(recipient, MAX_PER_TX + 1)));

        vm.prank(address(entryPoint));
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.ExceedsPerTxLimit.selector, MAX_PER_TX + 1, MAX_PER_TX));
        wallet.executeAsAgent(agent, address(usdc), 0, _transfer(recipient, MAX_PER_TX + 1));
        assertEq(usdc.balanceOf(recipient), 0);
    }

    function test_purchaseAboveMaxPerTxRejected() public {
        // 1100 credits = 11 USDC: the amount is only known from the actual token movement, so this fails in execution
        _handleExpectingExecutionRevert(
            _agentOp(address(merchant), _purchase(1100)),
            abi.encodeWithSelector(IAgentWallet.ExceedsPerTxLimit.selector, 11 * ONE_USDC, MAX_PER_TX)
        );
        assertEq(merchant.creditsOf(address(wallet)), 0);
        assertEq(usdc.balanceOf(address(wallet)), 100 * ONE_USDC);
        assertEq(_spent(), 0);
    }

    // ---------------- daily limit ----------------

    function test_transferCrossingDailyLimitRejected() public {
        _handle(_agentOp(address(usdc), _transfer(recipient, 10 * ONE_USDC)));
        _handle(_agentOp(address(usdc), _transfer(recipient, 10 * ONE_USDC)));
        _handleExpectingExecutionRevert(
            _agentOp(address(usdc), _transfer(recipient, 6 * ONE_USDC)),
            abi.encodeWithSelector(IAgentWallet.ExceedsDailyLimit.selector, 6 * ONE_USDC, 5 * ONE_USDC)
        );
        assertEq(usdc.balanceOf(recipient), 20 * ONE_USDC);
        assertEq(_spent(), 20 * ONE_USDC);
    }

    function test_dailyCounterResetsOnNewDay() public {
        _handle(_agentOp(address(merchant), _purchase(1000)));
        _handle(_agentOp(address(merchant), _purchase(1000)));
        _handle(_agentOp(address(usdc), _transfer(recipient, 5 * ONE_USDC)));
        assertEq(_spent(), DAILY_LIMIT);

        // last second of the same UTC day: still blocked
        vm.warp(START + 1 days - 1);
        _handleExpectingExecutionRevert(
            _agentOp(address(usdc), _transfer(recipient, 1)),
            abi.encodeWithSelector(IAgentWallet.ExceedsDailyLimit.selector, 1, 0)
        );

        // 00:00 UTC next day: counter starts again from zero
        vm.warp(START + 1 days);
        assertEq(_spent(), 0);
        assertEq(wallet.remainingDailyAllowance(agent), DAILY_LIMIT);
        _handle(_agentOp(address(merchant), _purchase(1000)));
        assertEq(_spent(), 10 * ONE_USDC);
        assertEq(merchant.creditsOf(address(wallet)), 3000);
    }

    function testFuzz_dailyLimitNeverExceeded(uint256 a, uint256 b, uint256 c) public {
        uint256[3] memory amounts = [bound(a, 1, MAX_PER_TX), bound(b, 1, MAX_PER_TX), bound(c, 1, MAX_PER_TX)];
        uint256 total;
        for (uint256 i; i < 3; i++) {
            uint256 before = usdc.balanceOf(recipient);
            _handle(_agentOp(address(usdc), _transfer(recipient, amounts[i])));
            if (total + amounts[i] <= DAILY_LIMIT) {
                total += amounts[i];
                assertEq(usdc.balanceOf(recipient), before + amounts[i]);
            } else {
                assertEq(usdc.balanceOf(recipient), before); // rejected, nothing moved
            }
            assertEq(_spent(), total);
            assertLe(_spent(), DAILY_LIMIT);
        }
    }

    // ---------------- recipients and selectors ----------------

    function test_unauthorizedRecipientRejected() public {
        _expectRejectedInValidation(_agentOp(address(usdc), _transfer(stranger, ONE_USDC)));

        vm.prank(address(entryPoint));
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.RecipientNotAllowed.selector, agent, stranger));
        wallet.executeAsAgent(agent, address(usdc), 0, _transfer(stranger, ONE_USDC));
    }

    function test_allowlistedContractPullingToElsewhereIsChecked() public {
        // The outer target is allowlisted, but it is not an allowed payee: pulling tokens through it is rejected.
        Drainer drainer = new Drainer();
        vm.startPrank(owner);
        wallet.allowCall(agent, address(drainer), Drainer.drain.selector, true);
        wallet.execute(address(usdc), 0, abi.encodeCall(IERC20.approve, (address(drainer), 50 * ONE_USDC)));
        vm.stopPrank();

        bytes memory drain = abi.encodeCall(Drainer.drain, (usdc, address(wallet), stranger, ONE_USDC));
        _handleExpectingExecutionRevert(
            _agentOp(address(drainer), drain),
            abi.encodeWithSelector(IAgentWallet.RecipientNotAllowed.selector, agent, address(drainer))
        );
        assertEq(usdc.balanceOf(stranger), 0);
    }

    function test_allowlistedPayeeStillBoundByLimits() public {
        // Even an allowed payee pulling through an allowance is capped by maxPerTx.
        Drainer drainer = new Drainer();
        vm.startPrank(owner);
        wallet.allowCall(agent, address(drainer), Drainer.drain.selector, true);
        wallet.allowRecipient(agent, address(drainer), true);
        wallet.execute(address(usdc), 0, abi.encodeCall(IERC20.approve, (address(drainer), 50 * ONE_USDC)));
        vm.stopPrank();

        bytes memory drain = abi.encodeCall(Drainer.drain, (usdc, address(wallet), stranger, 50 * ONE_USDC));
        _handleExpectingExecutionRevert(
            _agentOp(address(drainer), drain),
            abi.encodeWithSelector(IAgentWallet.ExceedsPerTxLimit.selector, 50 * ONE_USDC, MAX_PER_TX)
        );
        assertEq(usdc.balanceOf(address(wallet)), 100 * ONE_USDC);
    }

    function test_unauthorizedSelectorRejected() public {
        // merchant is allowlisted only for purchase()
        _expectRejectedInValidation(_agentOp(address(merchant), abi.encodeCall(MockMerchant.quote, (1))));
        // policy token: only transfer()
        bytes memory approve = abi.encodeCall(IERC20.approve, (stranger, type(uint256).max));
        bytes memory pull = abi.encodeCall(IERC20.transferFrom, (address(wallet), stranger, ONE_USDC));
        _expectRejectedInValidation(_agentOp(address(usdc), approve));
        _expectRejectedInValidation(_agentOp(address(usdc), pull));

        vm.startPrank(address(entryPoint));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentWallet.CallNotAllowed.selector, agent, address(merchant), MockMerchant.quote.selector
            )
        );
        wallet.executeAsAgent(agent, address(merchant), 0, abi.encodeCall(MockMerchant.quote, (1)));
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.InvalidTokenCall.selector, IERC20.approve.selector));
        wallet.executeAsAgent(agent, address(usdc), 0, approve);
        vm.stopPrank();
    }

    function test_malformedTransferCalldataRejected() public {
        bytes memory extra = abi.encodePacked(_transfer(recipient, ONE_USDC), uint256(1)); // trailing bytes
        bytes memory dirty = abi.encodePacked(
            IERC20.transfer.selector, bytes32(uint256(uint160(recipient)) | (uint256(1) << 200)), uint256(ONE_USDC)
        ); // recipient word with dirty high bits
        vm.startPrank(address(entryPoint));
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.InvalidTokenCall.selector, IERC20.transfer.selector));
        wallet.executeAsAgent(agent, address(usdc), 0, extra);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.InvalidTokenCall.selector, IERC20.transfer.selector));
        wallet.executeAsAgent(agent, address(usdc), 0, dirty);
        vm.stopPrank();
    }

    // ---------------- failed merchant calls ----------------

    function test_failedMerchantCallLeavesCounterUnchanged() public {
        // wrong payment amount: merchant reverts, wallet call reverts, nothing is counted
        bytes memory badPurchase = abi.encodeCall(MockMerchant.purchase, (500, 4 * ONE_USDC));
        PackedUserOperation memory op = _agentOp(address(merchant), badPurchase);
        _handleExpectingExecutionRevert(
            op, abi.encodeWithSelector(MockMerchant.IncorrectPayment.selector, 5 * ONE_USDC, 4 * ONE_USDC)
        );
        assertEq(_spent(), 0);
        assertEq(merchant.creditsOf(address(wallet)), 0);
        assertEq(usdc.balanceOf(address(wallet)), 100 * ONE_USDC);
        assertEq(entryPoint.getNonce(address(wallet), uint192(uint160(agent))), op.nonce + 1); // nonce still used
    }

    function test_merchantCallFailingOnAllowanceLeavesCounterUnchanged() public {
        vm.prank(owner);
        wallet.execute(address(usdc), 0, abi.encodeCall(IERC20.approve, (address(merchant), ONE_USDC)));
        _handleExpectingExecutionRevert(
            _agentOp(address(merchant), _purchase(500)),
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(merchant), ONE_USDC, 5 * ONE_USDC
            )
        );
        assertEq(_spent(), 0);
        assertEq(merchant.creditsOf(address(wallet)), 0);
    }

    // ---------------- administration and bypass attempts ----------------

    function test_agentCannotRaiseItsOwnLimits() public {
        bytes memory raise = abi.encodeCall(IAgentWallet.setPolicy, (agent, address(usdc), 1e30, 1e30));
        // as a direct UserOp
        _expectRejectedInValidation(_op(raise, agentKey, agent));
        // through executeAsAgent targeting the wallet
        _expectRejectedInValidation(_agentOp(address(wallet), raise));
        // through execute(wallet, ...)
        _expectRejectedInValidation(
            _op(abi.encodeCall(SimpleAccount.execute, (address(wallet), 0, raise)), agentKey, agent)
        );
        assertEq(wallet.getAgent(agent).maxPerTx, MAX_PER_TX);
    }

    function test_agentCannotBypassViaInheritedExecute() public {
        bytes memory steal = _transfer(stranger, 50 * ONE_USDC);
        _expectRejectedInValidation(
            _op(abi.encodeCall(SimpleAccount.execute, (address(usdc), 0, steal)), agentKey, agent)
        );

        address[] memory dest = new address[](1);
        bytes[] memory func = new bytes[](1);
        dest[0] = address(usdc);
        func[0] = steal;
        _expectRejectedInValidation(
            _op(abi.encodeCall(SimpleAccount.executeBatch, (dest, new uint256[](0), func)), agentKey, agent)
        );

        vm.startPrank(agent);
        vm.expectRevert("account: not Owner or EntryPoint");
        wallet.execute(address(usdc), 0, steal);
        vm.expectRevert(abi.encodeWithSelector(IAgentWallet.UnauthorizedCaller.selector, agent));
        wallet.executeAsAgent(agent, address(usdc), 0, _transfer(recipient, ONE_USDC));
        vm.stopPrank();
        assertEq(usdc.balanceOf(stranger), 0);
    }

    function test_agentCannotSpendUnderAnotherAgentsIdentity() public {
        // agent2 has no recipients but signs an op naming `agent` (who does)
        vm.prank(owner);
        wallet.addAgent(agent2, START, START + 30 days);
        PackedUserOperation memory op = _op(
            abi.encodeCall(IAgentWallet.executeAsAgent, (agent, address(usdc), 0, _transfer(recipient, ONE_USDC))),
            agent2Key,
            agent2
        );
        _expectRejectedInValidation(op);
        assertEq(usdc.balanceOf(recipient), 0);
    }

    function test_limitsArePerAgent() public {
        vm.startPrank(owner);
        wallet.addAgent(agent2, START, START + 30 days);
        wallet.setPolicy(agent2, address(usdc), MAX_PER_TX, DAILY_LIMIT);
        wallet.allowRecipient(agent2, recipient, true);
        vm.stopPrank();

        _handle(_agentOp(address(usdc), _transfer(recipient, 10 * ONE_USDC)));
        _handle(
            _op(
                abi.encodeCall(IAgentWallet.executeAsAgent, (agent2, address(usdc), 0, _transfer(recipient, ONE_USDC))),
                agent2Key,
                agent2
            )
        );
        assertEq(_spent(), 10 * ONE_USDC);
        assertEq(wallet.getAgent(agent2).spentToday, ONE_USDC);
    }

    function test_ownerPathUnaffectedByAgentLimits() public {
        vm.prank(owner);
        wallet.execute(address(usdc), 0, _transfer(stranger, 60 * ONE_USDC));
        assertEq(usdc.balanceOf(stranger), 60 * ONE_USDC);
        assertEq(_spent(), 0);
    }
}
