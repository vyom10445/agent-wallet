// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {AgentWallet} from "../../src/AgentWallet.sol";
import {IAgentWallet} from "../../src/interfaces/IAgentWallet.sol";
import {MockUSDC} from "../../src/MockUSDC.sol";
import {MockMerchant} from "../../src/MockMerchant.sol";
import {UserOps} from "../../script/utils/UserOps.sol";
import {AgentWalletTestBase} from "../utils/AgentWalletTestBase.sol";

/// @dev Random sequences of agent actions through handleOps. Tracks what actually left the wallet per UTC day.
contract SpendingHandler is Test {
    AgentWallet wallet;
    IEntryPoint ep;
    MockUSDC usdc;
    MockMerchant merchant;
    address agent;
    uint256 agentKey;
    address recipient;
    address stranger;
    address bundler;

    mapping(uint256 day => uint256 outflow) public outflowOnDay;
    uint256[] public daysSeen;
    uint256 public maxSingleOutflow;
    uint256 public calls;

    constructor(
        AgentWallet wallet_,
        IEntryPoint ep_,
        MockUSDC usdc_,
        MockMerchant merchant_,
        address agent_,
        uint256 agentKey_,
        address recipient_,
        address stranger_,
        address bundler_
    ) {
        (wallet, ep, usdc, merchant) = (wallet_, ep_, usdc_, merchant_);
        (agent, agentKey, recipient, stranger, bundler) = (agent_, agentKey_, recipient_, stranger_, bundler_);
    }

    function transfer(uint256 amount, bool toStranger) external {
        amount = bound(amount, 1, 40e6);
        _run(address(usdc), abi.encodeCall(IERC20.transfer, (toStranger ? stranger : recipient, amount)));
    }

    function purchase(uint256 credits, bool wrongPayment) external {
        credits = bound(credits, 1, 4000);
        uint256 payment = merchant.quote(credits) + (wrongPayment ? 1 : 0);
        _run(address(merchant), abi.encodeCall(MockMerchant.purchase, (credits, payment)));
    }

    function approveAttempt(uint256 amount) external {
        _run(address(usdc), abi.encodeCall(IERC20.approve, (stranger, amount)));
    }

    function passTime(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 2 days));
    }

    function _run(address target, bytes memory data) internal {
        calls++;
        PackedUserOperation memory op = UserOps.build(
            address(wallet),
            UserOps.agentNonce(ep, address(wallet), agent),
            abi.encodeCall(IAgentWallet.executeAsAgent, (agent, target, 0, data))
        );
        op.signature = UserOps.sign(ep, op, agentKey);
        uint256 before = usdc.balanceOf(address(wallet));
        vm.prank(bundler, bundler);
        try ep.handleOps{gas: UserOps.bundleGasLimit()}(UserOps.single(op), payable(bundler)) {} catch {}
        uint256 out = before - usdc.balanceOf(address(wallet));
        uint256 day = block.timestamp / 1 days;
        if (outflowOnDay[day] == 0 && out > 0) daysSeen.push(day);
        outflowOnDay[day] += out;
        if (out > maxSingleOutflow) maxSingleOutflow = out;
    }

    function daysSeenCount() external view returns (uint256) {
        return daysSeen.length;
    }
}

/// forge-config: default.invariant.runs = 48
/// forge-config: default.invariant.depth = 25
/// forge-config: default.invariant.fail-on-revert = true
contract SpendingInvariantTest is AgentWalletTestBase {
    SpendingHandler handler;
    uint256 initialSupply;

    function setUp() public override {
        super.setUp();
        handler = new SpendingHandler(wallet, ep, usdc, merchant, agent, agentKey, recipient, stranger, bundler);
        initialSupply = usdc.totalSupply();
        targetContract(address(handler));
    }

    function invariant_dailyOutflowNeverAboveLimit() public view {
        for (uint256 i; i < handler.daysSeenCount(); i++) {
            assertLe(handler.outflowOnDay(handler.daysSeen(i)), DAILY_LIMIT);
        }
    }

    function invariant_singleOutflowNeverAboveMaxPerTx() public view {
        assertLe(handler.maxSingleOutflow(), MAX_PER_TX);
    }

    function invariant_counterEqualsActualOutflowToday() public view {
        assertEq(wallet.getAgent(agent).spentToday, handler.outflowOnDay(block.timestamp / 1 days));
    }

    function invariant_nothingReachesUnapprovedAddresses() public view {
        assertEq(usdc.balanceOf(stranger), 0);
        assertEq(usdc.allowance(address(wallet), stranger), 0);
    }

    function invariant_tokensConserved() public view {
        assertEq(
            usdc.balanceOf(address(wallet)) + usdc.balanceOf(recipient) + usdc.balanceOf(address(merchant)),
            initialSupply
        );
    }
}
