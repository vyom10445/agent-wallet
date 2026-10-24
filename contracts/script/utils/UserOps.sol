// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Vm} from "forge-std/Vm.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IAgentWallet} from "../../src/interfaces/IAgentWallet.sol";

/// @notice Builds and signs EntryPoint v0.7 PackedUserOperations the way an agent backend would.
library UserOps {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint128 internal constant VERIFICATION_GAS = 500_000;
    uint128 internal constant CALL_GAS = 500_000;
    uint256 internal constant PRE_VERIFICATION_GAS = 60_000;
    uint128 internal constant GAS_PRICE = 1 gwei;

    /// @dev Transaction gas limit a submitter must give handleOps for one op. The EntryPoint reverts the whole bundle
    ///      with "AA95 out of gas" if the transaction carries less gas than the op's declared limits need, so a plain
    ///      eth_estimateGas (which only covers gas actually used) is not enough.
    function bundleGasLimit() internal pure returns (uint256) {
        return uint256(VERIFICATION_GAS) + CALL_GAS + PRE_VERIFICATION_GAS + 200_000;
    }

    /// @dev Agents use nonce key = their address so they never block the owner's key-0 sequence.
    function agentNonce(IEntryPoint ep, address wallet, address agent) internal view returns (uint256) {
        return ep.getNonce(wallet, uint192(uint160(agent)));
    }

    /// @dev Agent request -> UserOperation: executeAsAgent(agent, target, 0, data), signed by the agent key.
    function agentPurchaseOp(
        IEntryPoint ep,
        address wallet,
        address agent,
        uint256 agentKey,
        address target,
        bytes memory data
    ) internal view returns (PackedUserOperation memory op) {
        op = build(
            wallet, agentNonce(ep, wallet, agent), abi.encodeCall(IAgentWallet.executeAsAgent, (agent, target, 0, data))
        );
        op.signature = sign(ep, op, agentKey);
    }

    function build(address wallet, uint256 nonce, bytes memory callData)
        internal
        pure
        returns (PackedUserOperation memory)
    {
        return PackedUserOperation({
            sender: wallet,
            nonce: nonce,
            initCode: "",
            callData: callData,
            accountGasLimits: bytes32((uint256(VERIFICATION_GAS) << 128) | CALL_GAS),
            preVerificationGas: PRE_VERIFICATION_GAS,
            gasFees: bytes32((uint256(GAS_PRICE) << 128) | GAS_PRICE),
            paymasterAndData: "",
            signature: ""
        });
    }

    /// @dev Signature format expected by SimpleAccount v0.7.0 and AgentWallet:
    ///      65-byte r||s||v ECDSA over EIP-191 personal_sign of entryPoint.getUserOpHash(op).
    function sign(IEntryPoint ep, PackedUserOperation memory op, uint256 key) internal view returns (bytes memory) {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(ep.getUserOpHash(op));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function single(PackedUserOperation memory op) internal pure returns (PackedUserOperation[] memory ops) {
        ops = new PackedUserOperation[](1);
        ops[0] = op;
    }
}
