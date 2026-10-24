// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IStakeManager} from "account-abstraction/interfaces/IStakeManager.sol";
import {INonceManager} from "account-abstraction/interfaces/INonceManager.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {SimpleAccount} from "account-abstraction/samples/SimpleAccount.sol";
import {IAgentWallet} from "../src/interfaces/IAgentWallet.sol";
import {MockMerchant} from "../src/MockMerchant.sol";
import {Deploy} from "./Deploy.s.sol";
import {UserOps} from "./utils/UserOps.sol";

/// @notice H12 go/no-go demo on a live Anvil node:
///   agent request -> UserOperation -> EntryPoint.handleOps -> AgentWallet validation -> restricted execution
///   -> merchant payment -> purchase recorded.
/// No bundler: a funded "submitter" account calls EntryPoint.handleOps directly (planned fallback). The EntryPoint is
/// never bypassed. Uses only Anvil's public dev accounts (mnemonic "test ... junk"); refuses to run on any other chain.
///
/// Run (with `anvil` running in another terminal):
///   forge script script/H12Demo.s.sol --rpc-url anvil --broadcast
contract H12Demo is Deploy {
    string internal constant ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
    bytes32 internal constant USER_OPERATION_EVENT =
        keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");
    uint256 internal constant ONE_USDC = 1_000_000;

    uint256 internal ownerKey;
    uint256 internal agentKey;
    uint256 internal submitterKey;
    address internal owner;
    address internal agent;
    address internal submitter;
    Deployment internal d;
    string internal firstFailure;

    function run() external override returns (Deployment memory) {
        require(block.chainid == 31337, "H12Demo: Anvil only");
        ownerKey = vm.deriveKey(ANVIL_MNEMONIC, 0);
        agentKey = vm.deriveKey(ANVIL_MNEMONIC, 1);
        submitterKey = vm.deriveKey(ANVIL_MNEMONIC, 2);
        owner = vm.addr(ownerKey);
        agent = vm.addr(agentKey);
        submitter = vm.addr(submitterKey);

        // 1. deploy
        vm.startBroadcast(ownerKey);
        d = deploy(owner);
        vm.stopBroadcast();
        _stage(
            "1 contracts at expected addresses",
            address(d.entryPoint) == expectedAddress(type(EntryPoint).creationCode)
                && address(d.wallet) == d.factory.getAddress(owner, 0) && address(d.wallet).code.length > 0
        );
        bytes4 v07 = type(IEntryPoint).interfaceId ^ type(IStakeManager).interfaceId ^ type(INonceManager).interfaceId;
        _stage("  EntryPoint is v0.7", EntryPoint(payable(address(d.entryPoint))).supportsInterface(v07));

        // 2. owner
        _stage("2 wallet owner is account 0", d.wallet.owner() == owner);

        // 3 + 4. owner configures the agent (owner-signed UserOp) and funds the wallet
        vm.startBroadcast(ownerKey);
        d.wallet.addDeposit{value: 1 ether}();
        d.usdc.mint(address(d.wallet), 100 * ONE_USDC);
        vm.stopBroadcast();
        (address[] memory dest, uint256[] memory values, bytes[] memory func) = _configureAgentBatch();
        bool configured = _submit(_ownerOp(abi.encodeCall(SimpleAccount.executeBatch, (dest, values, func))));
        _stage("3 agent registered with policy", configured && d.wallet.isAgentValid(agent));
        _stage("4 wallet funded with 100 mUSDC", d.usdc.balanceOf(address(d.wallet)) == 100 * ONE_USDC);

        // 5-7. the H12 flow
        console2.log("Agent request: buy 500 API credits for 5 mUSDC");
        uint256 creditsBefore = d.merchant.creditsOf(address(d.wallet));
        uint256 walletBefore = d.usdc.balanceOf(address(d.wallet));
        uint256 spentBefore = d.wallet.getAgent(agent).spentToday;
        bool bought = _submit(_agentPurchaseOp(500));
        _stage("5 agent UserOp purchase via EntryPoint", bought);
        _stage("6 merchant recorded purchase", d.merchant.creditsOf(address(d.wallet)) == creditsBefore + 500);
        _stage(
            "7 balances and spend counter",
            d.usdc.balanceOf(address(d.wallet)) == walletBefore - 5 * ONE_USDC
                && d.wallet.getAgent(agent).spentToday == spentBefore + 5 * ONE_USDC
        );

        // 8. over maxPerTx: included by the EntryPoint, payment reverts
        walletBefore = d.usdc.balanceOf(address(d.wallet));
        bool overLimit = _submit(_agentPurchaseOp(1100));
        _stage("8 over-limit payment blocked", !overLimit && d.usdc.balanceOf(address(d.wallet)) == walletBefore);

        // 9. revoke, then the agent's next op fails validation (simulated only: a bundler would drop it)
        vm.broadcast(ownerKey);
        d.wallet.revokeAgent(agent);
        PackedUserOperation memory revokedOp = _agentPurchaseOp(500);
        bool rejected;
        try d.entryPoint.handleOps(UserOps.single(revokedOp), payable(submitter)) {}
        catch (bytes memory err) {
            rejected = keccak256(err)
                == keccak256(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA24 signature error"));
        }
        _stage("9 revoked agent rejected (AA24)", rejected);

        // 10. owner path
        address treasury = vm.addr(vm.deriveKey(ANVIL_MNEMONIC, 3));
        uint256 treasuryBefore = d.usdc.balanceOf(treasury);
        vm.broadcast(ownerKey);
        d.wallet.execute(address(d.usdc), 0, abi.encodeCall(IERC20.transfer, (treasury, ONE_USDC)));
        _stage("10 owner execute still works", d.usdc.balanceOf(treasury) == treasuryBefore + ONE_USDC);

        console2.log("");
        console2.log("EntryPoint  ", address(d.entryPoint));
        console2.log("AgentWallet ", address(d.wallet));
        console2.log("MockUSDC    ", address(d.usdc));
        console2.log("MockMerchant", address(d.merchant));
        console2.log("agent       ", agent);
        console2.log("submitter   ", submitter);
        if (bytes(firstFailure).length == 0) {
            console2.log("H12: GO");
        } else {
            console2.log("H12: NO-GO, first failing stage:", firstFailure);
            revert(string.concat("H12 NO-GO at stage ", firstFailure));
        }
        return d;
    }

    function _configureAgentBatch() internal view returns (address[] memory, uint256[] memory, bytes[] memory) {
        address[] memory dest = new address[](5);
        bytes[] memory func = new bytes[](5);
        address w = address(d.wallet);
        uint48 nowTs = uint48(block.timestamp);
        (dest[0], func[0]) = (w, abi.encodeCall(IAgentWallet.addAgent, (agent, nowTs, nowTs + 30 days)));
        (dest[1], func[1]) =
        (w, abi.encodeCall(IAgentWallet.setPolicy, (agent, address(d.usdc), 10 * ONE_USDC, 25 * ONE_USDC)));
        (dest[2], func[2]) =
        (w, abi.encodeCall(IAgentWallet.allowCall, (agent, address(d.merchant), MockMerchant.purchase.selector, true)));
        (dest[3], func[3]) = (w, abi.encodeCall(IAgentWallet.allowRecipient, (agent, address(d.merchant), true)));
        (dest[4], func[4]) = (address(d.usdc), abi.encodeCall(IERC20.approve, (address(d.merchant), 50 * ONE_USDC)));
        return (dest, new uint256[](0), func);
    }

    function _ownerOp(bytes memory callData) internal view returns (PackedUserOperation memory op) {
        op = UserOps.build(address(d.wallet), d.wallet.getNonce(), callData);
        op.signature = UserOps.sign(d.entryPoint, op, ownerKey);
    }

    function _agentPurchaseOp(uint256 credits) internal view returns (PackedUserOperation memory) {
        bytes memory data = abi.encodeCall(MockMerchant.purchase, (credits, d.merchant.quote(credits)));
        return UserOps.agentPurchaseOp(d.entryPoint, address(d.wallet), agent, agentKey, address(d.merchant), data);
    }

    /// @dev Direct handleOps fallback from the funded submitter. Returns UserOperationEvent.success.
    function _submit(PackedUserOperation memory op) internal returns (bool success) {
        vm.recordLogs();
        vm.broadcast(submitterKey);
        d.entryPoint.handleOps{gas: UserOps.bundleGasLimit()}(UserOps.single(op), payable(submitter));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(d.entryPoint) && logs[i].topics[0] == USER_OPERATION_EVENT) {
                (, success,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
            }
        }
    }

    function _stage(string memory name, bool ok) internal {
        console2.log(ok ? "PASS" : "FAIL", name);
        if (!ok && bytes(firstFailure).length == 0) firstFailure = name;
    }
}
