// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script, console2} from "forge-std/Script.sol";
import {Vm} from "forge-std/Vm.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {AgentWallet} from "../src/AgentWallet.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {MockMerchant} from "../src/MockMerchant.sol";
import {Deployments} from "./utils/Deployments.sol";
import {UserOps} from "./utils/UserOps.sol";

/// @notice End-to-end agent purchase on a deployed, configured stack:
///   agent-signed UserOperation -> EntryPoint.handleOps -> AgentWallet validation -> restricted execution
///   -> merchant pulls mUSDC -> purchase recorded.
/// Broadcasts ONE transaction: handleOps, sent by --sender (the owner/deployer acts as the bundler and is refunded
/// from the wallet's EntryPoint deposit). The two negative checks after it are local simulations and are never sent.
/// If any check fails in simulation, forge aborts before broadcasting anything.
///
/// Env (contracts/.env):
///   AGENT_PRIVATE_KEY  required. Throwaway testnet key created with `cast wallet new`. It never needs ETH.
///   SMOKE_CREDITS      default 10 (10 credits = 0.1 mUSDC)
contract SmokeTest is Script {
    bytes32 internal constant USER_OPERATION_EVENT =
        keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");

    Deployments.Addresses internal a;
    IEntryPoint internal ep;
    AgentWallet internal wallet;
    MockMerchant internal merchant;
    uint256 internal agentKey;
    address internal agent;
    bool internal failed;

    function run() external {
        a = Deployments.load();
        ep = IEntryPoint(a.entryPoint);
        wallet = AgentWallet(payable(a.wallet));
        merchant = MockMerchant(a.merchant);
        agentKey = vm.envUint("AGENT_PRIVATE_KEY");
        agent = vm.addr(agentKey);
        uint256 credits = vm.envOr("SMOKE_CREDITS", uint256(10));
        uint256 price = merchant.quote(credits);

        require(wallet.isAgentValid(agent), "Agent not active or outside its validity window: run ConfigureAgent");
        require(price <= wallet.getAgent(agent).maxPerTx, "SMOKE_CREDITS costs more than maxPerTx");
        require(price <= wallet.remainingDailyAllowance(agent), "Not enough daily allowance left today (UTC)");
        require(wallet.getDeposit() >= UserOps.bundleGasLimit() * UserOps.GAS_PRICE, "Wallet gas deposit too low");

        uint256 creditsBefore = merchant.creditsOf(a.wallet);
        uint256 balanceBefore = MockUSDC(a.usdc).balanceOf(a.wallet);
        uint256 spentBefore = wallet.getAgent(agent).spentToday;

        // 1. the real purchase (broadcast)
        PackedUserOperation memory op = _purchaseOp(credits, agentKey);
        console2.log("userOpHash");
        console2.logBytes32(ep.getUserOpHash(op));
        vm.recordLogs();
        vm.startBroadcast();
        ep.handleOps{gas: UserOps.bundleGasLimit()}(UserOps.single(op), payable(msg.sender));
        vm.stopBroadcast();
        _check("agent UserOp executed via EntryPoint", _opSucceeded());
        _check("merchant recorded the credits", merchant.creditsOf(a.wallet) == creditsBefore + credits);
        _check("wallet paid exactly the quote", MockUSDC(a.usdc).balanceOf(a.wallet) == balanceBefore - price);
        _check("agent spend counter updated", wallet.getAgent(agent).spentToday == spentBefore + price);

        // 2. a key that is not the agent is rejected at validation (simulated, not sent)
        bool rejected;
        try ep.handleOps(
            UserOps.single(_purchaseOp(credits, uint256(keccak256("not the agent")))), payable(msg.sender)
        ) {}
        catch (bytes memory err) {
            rejected = keccak256(err)
                == keccak256(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA24 signature error"));
        }
        _check("wrong signer rejected (AA24)        [simulated]", rejected);

        // 3. a purchase above maxPerTx moves no funds (simulated, not sent)
        uint256 overCredits = wallet.getAgent(agent).maxPerTx / merchant.quote(1) + 1;
        uint256 balance = MockUSDC(a.usdc).balanceOf(a.wallet);
        vm.recordLogs();
        ep.handleOps{gas: UserOps.bundleGasLimit()}(
            UserOps.single(_purchaseOp(overCredits, agentKey)), payable(msg.sender)
        );
        _check(
            "over-limit purchase blocked          [simulated]",
            !_opSucceeded() && MockUSDC(a.usdc).balanceOf(a.wallet) == balance
        );

        console2.log("wallet  ", a.wallet);
        console2.log("agent   ", agent);
        console2.log("credits ", merchant.creditsOf(a.wallet));
        require(!failed, "SMOKE TEST FAILED: nothing was broadcast");
        console2.log("SMOKE TEST: PASS");
    }

    function _purchaseOp(uint256 credits, uint256 key) internal view returns (PackedUserOperation memory) {
        bytes memory data = abi.encodeCall(MockMerchant.purchase, (credits, merchant.quote(credits)));
        return UserOps.agentPurchaseOp(ep, a.wallet, agent, key, a.merchant, data);
    }

    function _opSucceeded() internal returns (bool success) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(ep) && logs[i].topics[0] == USER_OPERATION_EVENT) {
                (, success,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
            }
        }
    }

    function _check(string memory name, bool ok) internal {
        console2.log(ok ? "PASS" : "FAIL", name);
        if (!ok) failed = true;
    }
}
