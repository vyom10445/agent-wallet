// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script, console2} from "forge-std/Script.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IStakeManager} from "account-abstraction/interfaces/IStakeManager.sol";
import {INonceManager} from "account-abstraction/interfaces/INonceManager.sol";
import {IAgentWallet} from "../src/interfaces/IAgentWallet.sol";
import {AgentWallet} from "../src/AgentWallet.sol";
import {AgentWalletFactory} from "../src/AgentWalletFactory.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {MockMerchant} from "../src/MockMerchant.sol";
import {Deployments} from "./utils/Deployments.sol";

/// @notice Read-only check of what is live on chain. Sends nothing and needs no key.
///   forge script script/Status.s.sol --rpc-url base_sepolia
/// Optional env: AGENT_ADDRESS to also print that agent's policy.
contract Status is Script {
    function run() external view {
        Deployments.Addresses memory a = Deployments.load();
        AgentWallet wallet = AgentWallet(payable(a.wallet));
        MockUSDC usdc = MockUSDC(a.usdc);
        bytes4 v07 = type(IEntryPoint).interfaceId ^ type(IStakeManager).interfaceId ^ type(INonceManager).interfaceId;

        console2.log("chain id               ", block.chainid);
        console2.log("EntryPoint             ", a.entryPoint);
        console2.log("EntryPoint is v0.7     ", EntryPoint(payable(a.entryPoint)).supportsInterface(v07));
        console2.log("wallet.entryPoint ok   ", address(wallet.entryPoint()) == a.entryPoint);
        console2.log("factory -> wallet ok   ", AgentWalletFactory(a.factory).getAddress(a.owner, 0) == a.wallet);
        console2.log("wallet owner ok        ", wallet.owner() == a.owner);
        console2.log("merchant token ok      ", address(MockMerchant(a.merchant).token()) == a.usdc);
        console2.log("wallet mUSDC           ", usdc.balanceOf(a.wallet));
        console2.log("merchant allowance     ", usdc.allowance(a.wallet, a.merchant));
        console2.log("EntryPoint deposit wei ", wallet.getDeposit());
        console2.log("credits purchased      ", MockMerchant(a.merchant).creditsOf(a.wallet));
        console2.log("merchant purchaseCount ", MockMerchant(a.merchant).purchaseCount());

        address agent = vm.envOr("AGENT_ADDRESS", address(0));
        if (agent == address(0)) return;
        IAgentWallet.AgentInfo memory info = wallet.getAgent(agent);
        console2.log("agent                  ", agent);
        console2.log("agent valid now        ", wallet.isAgentValid(agent));
        console2.log("maxPerTx               ", info.maxPerTx);
        console2.log("dailyLimit             ", info.dailyLimit);
        console2.log("spentToday             ", info.spentToday);
        console2.log("remaining today        ", wallet.remainingDailyAllowance(agent));
    }
}
