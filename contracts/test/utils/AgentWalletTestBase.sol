// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {SimpleAccount} from "account-abstraction/samples/SimpleAccount.sol";
import {AgentWallet} from "../../src/AgentWallet.sol";
import {IAgentWallet} from "../../src/interfaces/IAgentWallet.sol";
import {MockUSDC} from "../../src/MockUSDC.sol";
import {MockMerchant} from "../../src/MockMerchant.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {UserOps} from "../../script/utils/UserOps.sol";

/// @notice Shared fixture: the deployed stack (Deploy.deploy) with one configured agent, driven through handleOps.
abstract contract AgentWalletTestBase is Test {
    uint256 internal constant ONE_USDC = 1_000_000;
    uint256 internal constant MAX_PER_TX = 10 * ONE_USDC;
    uint256 internal constant DAILY_LIMIT = 25 * ONE_USDC;
    uint48 internal constant DAY0 = 1_700_006_400; // 2023-11-15 00:00:00 UTC
    bytes32 internal constant USER_OPERATION_EVENT =
        keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");
    string internal constant AA24 = "AA24 signature error";
    string internal constant AA22 = "AA22 expired or not due";
    string internal constant AA25 = "AA25 invalid account nonce";

    Deploy.Deployment internal d;
    AgentWallet internal wallet;
    IEntryPoint internal ep;
    MockUSDC internal usdc;
    MockMerchant internal merchant;

    address internal owner;
    uint256 internal ownerKey;
    address internal agent;
    uint256 internal agentKey;
    address internal recipient = makeAddr("recipient");
    address internal stranger = makeAddr("stranger");
    address internal bundler = makeAddr("bundler");

    function setUp() public virtual {
        vm.warp(DAY0);
        (owner, ownerKey) = makeAddrAndKey("owner");
        (agent, agentKey) = makeAddrAndKey("agent");
        vm.deal(owner, 100 ether);
        vm.deal(bundler, 100 ether);

        d = new Deploy().deploy(owner);
        (wallet, ep, usdc, merchant) = (d.wallet, d.entryPoint, d.usdc, d.merchant);

        vm.startPrank(owner);
        wallet.addDeposit{value: 10 ether}();
        wallet.addAgent(agent, DAY0, DAY0 + 30 days);
        wallet.setPolicy(agent, address(usdc), MAX_PER_TX, DAILY_LIMIT);
        wallet.allowCall(agent, address(merchant), MockMerchant.purchase.selector, true);
        wallet.allowRecipient(agent, address(merchant), true);
        wallet.allowRecipient(agent, recipient, true);
        wallet.execute(address(usdc), 0, abi.encodeCall(IERC20.approve, (address(merchant), type(uint256).max)));
        vm.stopPrank();
        usdc.mint(address(wallet), 1_000_000 * ONE_USDC);
    }

    // ---------------- UserOp helpers ----------------

    function _agentNonce() internal view returns (uint256) {
        return UserOps.agentNonce(ep, address(wallet), agent);
    }

    function _signed(bytes memory callData, uint256 nonce, uint256 key)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op = UserOps.build(address(wallet), nonce, callData);
        op.signature = UserOps.sign(ep, op, key);
    }

    function _agentOp(address target, bytes memory data) internal view returns (PackedUserOperation memory) {
        return _signed(abi.encodeCall(IAgentWallet.executeAsAgent, (agent, target, 0, data)), _agentNonce(), agentKey);
    }

    function _transferOp(address to, uint256 amount) internal view returns (PackedUserOperation memory) {
        return _agentOp(address(usdc), abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    function _purchaseOp(uint256 credits) internal view returns (PackedUserOperation memory) {
        return _agentOp(address(merchant), abi.encodeCall(MockMerchant.purchase, (credits, merchant.quote(credits))));
    }

    /// @dev Submits through handleOps like a bundler and returns UserOperationEvent.success.
    function _submit(PackedUserOperation memory op) internal returns (bool success) {
        vm.recordLogs();
        vm.prank(bundler, bundler);
        ep.handleOps{gas: UserOps.bundleGasLimit()}(UserOps.single(op), payable(bundler));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(ep) && logs[i].topics[0] == USER_OPERATION_EVENT) {
                (, success,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
                return success;
            }
        }
        revert("no UserOperationEvent");
    }

    function _expectFailedOp(PackedUserOperation memory op, string memory reason) internal {
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, reason));
        vm.prank(bundler, bundler);
        ep.handleOps(UserOps.single(op), payable(bundler));
    }

    function _expectFailedOpWithRevert(PackedUserOperation memory op, string memory reason, bytes memory inner)
        internal
    {
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOpWithRevert.selector, 0, reason, inner));
        vm.prank(bundler, bundler);
        ep.handleOps(UserOps.single(op), payable(bundler));
    }

    function _spent() internal view returns (uint256) {
        return wallet.getAgent(agent).spentToday;
    }

    function _walletBalance() internal view returns (uint256) {
        return usdc.balanceOf(address(wallet));
    }
}
