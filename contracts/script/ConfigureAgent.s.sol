// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAgentWallet} from "../src/interfaces/IAgentWallet.sol";
import {AgentWallet} from "../src/AgentWallet.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {MockMerchant} from "../src/MockMerchant.sol";
import {Deployments} from "./utils/Deployments.sol";

/// @notice Owner configures one agent after deployment: register, policy, merchant allowlist, merchant allowance,
///         test funds and EntryPoint gas deposit. Every call is a plain owner transaction (onlyOwner), so the wallet's
///         security logic is used exactly as deployed. Safe to re-run: finished steps are skipped,
///         and the allowance, mUSDC balance and gas deposit are topped back up to the targets below.
///
/// Env (contracts/.env):
///   AGENT_ADDRESS        required. The agent's public address (its key never needs ETH).
///   AGENT_MAX_PER_TX     default 1_000_000   (1 mUSDC, 6 decimals)
///   AGENT_DAILY_LIMIT    default 5_000_000   (5 mUSDC)
///   AGENT_VALID_DAYS     default 7
///   MERCHANT_ALLOWANCE   default 10_000_000  (10 mUSDC the merchant may pull, total)
///   MINT_AMOUNT          default 100_000_000 (100 mUSDC test tokens for the wallet)
///   GAS_DEPOSIT_WEI      default 0.005 ether (wallet's EntryPoint deposit that pays for agent UserOps)
contract ConfigureAgent is Script {
    struct Params {
        address agent;
        uint256 maxPerTx;
        uint256 dailyLimit;
        uint256 validDays;
        uint256 allowance;
        uint256 mintAmount;
        uint256 deposit;
    }

    function run() external {
        Deployments.Addresses memory a = Deployments.load();
        Params memory p = Params({
            agent: vm.envAddress("AGENT_ADDRESS"),
            maxPerTx: vm.envOr("AGENT_MAX_PER_TX", uint256(1_000_000)),
            dailyLimit: vm.envOr("AGENT_DAILY_LIMIT", uint256(5_000_000)),
            validDays: vm.envOr("AGENT_VALID_DAYS", uint256(7)),
            allowance: vm.envOr("MERCHANT_ALLOWANCE", uint256(10_000_000)),
            mintAmount: vm.envOr("MINT_AMOUNT", uint256(100_000_000)),
            deposit: vm.envOr("GAS_DEPOSIT_WEI", uint256(0.005 ether))
        });
        AgentWallet wallet = AgentWallet(payable(a.wallet));
        require(msg.sender == wallet.owner(), "Sender is not the wallet owner: pass --account/--sender of the owner");
        require(p.agent != wallet.owner(), "Use a separate agent key, not the owner");

        vm.startBroadcast();
        _configure(a, p);
        vm.stopBroadcast();
        _report(a, p.agent);
    }

    function _configure(Deployments.Addresses memory a, Params memory p) internal {
        AgentWallet wallet = AgentWallet(payable(a.wallet));
        MockUSDC usdc = MockUSDC(a.usdc);
        bytes4 purchase = MockMerchant.purchase.selector;

        if (!wallet.getAgent(p.agent).active) {
            wallet.addAgent(p.agent, uint48(block.timestamp), uint48(block.timestamp + p.validDays * 1 days));
        }
        IAgentWallet.AgentInfo memory info = wallet.getAgent(p.agent);
        if (info.token != a.usdc || info.maxPerTx != p.maxPerTx || info.dailyLimit != p.dailyLimit) {
            wallet.setPolicy(p.agent, a.usdc, p.maxPerTx, p.dailyLimit);
        }
        if (!wallet.isCallAllowed(p.agent, a.merchant, purchase)) {
            wallet.allowCall(p.agent, a.merchant, purchase, true);
        }
        if (!wallet.isRecipientAllowed(p.agent, a.merchant)) wallet.allowRecipient(p.agent, a.merchant, true);
        if (usdc.allowance(a.wallet, a.merchant) != p.allowance) {
            wallet.execute(a.usdc, 0, abi.encodeCall(IERC20.approve, (a.merchant, p.allowance)));
        }
        uint256 balance = usdc.balanceOf(a.wallet);
        if (balance < p.mintAmount) usdc.mint(a.wallet, p.mintAmount - balance);
        uint256 current = wallet.getDeposit();
        if (current < p.deposit) wallet.addDeposit{value: p.deposit - current}();
    }

    function _report(Deployments.Addresses memory a, address agent) internal view {
        AgentWallet wallet = AgentWallet(payable(a.wallet));
        MockUSDC usdc = MockUSDC(a.usdc);
        IAgentWallet.AgentInfo memory info = wallet.getAgent(agent);
        console2.log("wallet            ", a.wallet);
        console2.log("agent             ", agent);
        console2.log("agent valid now   ", wallet.isAgentValid(agent));
        console2.log("valid until (unix)", uint256(info.validUntil));
        console2.log("policy token      ", info.token);
        console2.log("maxPerTx          ", info.maxPerTx);
        console2.log("dailyLimit        ", info.dailyLimit);
        console2.log("merchant purchase ", wallet.isCallAllowed(agent, a.merchant, MockMerchant.purchase.selector));
        console2.log("merchant recipient", wallet.isRecipientAllowed(agent, a.merchant));
        console2.log("merchant allowance", usdc.allowance(a.wallet, a.merchant));
        console2.log("wallet mUSDC      ", usdc.balanceOf(a.wallet));
        console2.log("EntryPoint deposit", wallet.getDeposit());
    }
}
