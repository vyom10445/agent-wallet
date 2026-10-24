// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {SimpleAccount} from "account-abstraction/samples/SimpleAccount.sol";
import {AgentWallet} from "./AgentWallet.sol";

/// @title AgentWalletFactory
/// @notice Same pattern as account-abstraction v0.7.0 SimpleAccountFactory, with AgentWallet as the implementation
///         (SimpleAccountFactory hard-codes SimpleAccount). Usable as a UserOp initCode factory.
contract AgentWalletFactory {
    AgentWallet public immutable accountImplementation;

    constructor(IEntryPoint entryPoint) {
        accountImplementation = new AgentWallet(entryPoint);
    }

    /// @notice Deploys the wallet proxy for (owner, salt), or returns it if it already exists.
    function createAccount(address owner, uint256 salt) public returns (AgentWallet ret) {
        address addr = getAddress(owner, salt);
        if (addr.code.length > 0) return AgentWallet(payable(addr));
        ret = AgentWallet(
            payable(new ERC1967Proxy{salt: bytes32(salt)}(
                    address(accountImplementation), abi.encodeCall(SimpleAccount.initialize, (owner))
                ))
        );
    }

    /// @notice Counterfactual address of the wallet for (owner, salt).
    function getAddress(address owner, uint256 salt) public view returns (address) {
        return Create2.computeAddress(
            bytes32(salt),
            keccak256(
                abi.encodePacked(
                    type(ERC1967Proxy).creationCode,
                    abi.encode(address(accountImplementation), abi.encodeCall(SimpleAccount.initialize, (owner)))
                )
            )
        );
    }
}
