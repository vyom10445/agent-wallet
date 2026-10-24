// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {AgentWallet} from "../src/AgentWallet.sol";
import {AgentWalletFactory} from "../src/AgentWalletFactory.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {MockMerchant} from "../src/MockMerchant.sol";
import {Deployments} from "./utils/Deployments.sol";

/// @notice Deterministic deployment of the whole stack through the standard CREATE2 deployer.
/// - Anvil (31337): deploys EntryPoint v0.7 from lib/account-abstraction v0.7.0 source.
/// - Base Sepolia (84532): uses the canonical EntryPoint v0.7 and refuses to deploy a new one.
/// - Any other chain: refuses to run.
/// run() also writes the addresses to deployments/<chainId>.json for ConfigureAgent, SmokeTest and Status.
/// Anvil:  forge script script/Deploy.s.sol --rpc-url anvil --broadcast --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
/// Base Sepolia: see docs/PHASE10_DEPLOYMENT.md (keystore account, never a raw key on the command line).
contract Deploy is Script {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address internal constant CANONICAL_ENTRY_POINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    bytes32 internal constant SALT = keccak256("imperials.agent-wallet.v1");
    uint256 internal constant PRICE_PER_CREDIT = 10_000; // 0.01 USDC

    struct Deployment {
        IEntryPoint entryPoint;
        AgentWalletFactory factory;
        MockUSDC usdc;
        MockMerchant merchant;
        AgentWallet wallet;
    }

    function run() external virtual returns (Deployment memory d) {
        address owner = vm.envOr("WALLET_OWNER", msg.sender);
        vm.startBroadcast();
        d = deploy(owner);
        vm.stopBroadcast();

        console2.log("chain id          ", block.chainid);
        console2.log("EntryPoint v0.7   ", address(d.entryPoint));
        console2.log("AgentWalletFactory", address(d.factory));
        console2.log("AgentWallet impl  ", address(d.factory.accountImplementation()));
        console2.log("MockUSDC          ", address(d.usdc));
        console2.log("MockMerchant      ", address(d.merchant));
        console2.log("AgentWallet       ", address(d.wallet));
        console2.log("wallet owner      ", d.wallet.owner());

        Deployments.save(
            Deployments.Addresses({
                entryPoint: address(d.entryPoint),
                factory: address(d.factory),
                implementation: address(d.factory.accountImplementation()),
                usdc: address(d.usdc),
                merchant: address(d.merchant),
                wallet: address(d.wallet),
                owner: owner
            })
        );
        console2.log("addresses written to", Deployments.path());
    }

    /// @dev Idempotent: contracts that already exist at their CREATE2 address are reused.
    function deploy(address owner) public returns (Deployment memory d) {
        Deployments.requireSupportedChain();
        require(owner != address(0), "Wallet owner is zero");
        require(CREATE2_DEPLOYER.code.length > 0, "CREATE2 deployer missing on this chain");
        if (block.chainid == Deployments.ANVIL) {
            d.entryPoint = IEntryPoint(_create2(type(EntryPoint).creationCode));
        } else {
            require(CANONICAL_ENTRY_POINT_V07.code.length > 0, "EntryPoint v0.7 missing on this chain");
            d.entryPoint = IEntryPoint(CANONICAL_ENTRY_POINT_V07);
        }
        d.factory = AgentWalletFactory(
            _create2(abi.encodePacked(type(AgentWalletFactory).creationCode, abi.encode(d.entryPoint)))
        );
        d.usdc = MockUSDC(_create2(type(MockUSDC).creationCode));
        d.merchant = MockMerchant(
            _create2(abi.encodePacked(type(MockMerchant).creationCode, abi.encode(d.usdc, PRICE_PER_CREDIT)))
        );
        address wallet = d.factory.getAddress(owner, 0);
        d.wallet = wallet.code.length > 0 ? AgentWallet(payable(wallet)) : d.factory.createAccount(owner, 0);
    }

    /// @notice Address a contract gets from deploy(), for checking expected addresses.
    function expectedAddress(bytes memory initCode) public pure returns (address) {
        return vm.computeCreate2Address(SALT, keccak256(initCode), CREATE2_DEPLOYER);
    }

    function _create2(bytes memory initCode) internal returns (address addr) {
        addr = expectedAddress(initCode);
        if (addr.code.length > 0) return addr;
        (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(SALT, initCode));
        require(ok && addr.code.length > 0, "CREATE2 deployment failed");
    }
}
