// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {AgentWalletTestBase} from "./utils/AgentWalletTestBase.sol";

/// @notice Phase 11.2: pins down the failure modes the agent backend and the frontend will hit, so the debugging guide
///         (docs/PHASE11_DEBUGGING.md) states facts, not guesses.
contract IntegrationSupportTest is AgentWalletTestBase {
    /// @dev Well-formed placeholder for gas estimation: r = secp256k1 G.x (always recoverable), s = 1, v = 27.
    bytes internal constant DUMMY_SIGNATURE = hex"79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
        hex"0000000000000000000000000000000000000000000000000000000000000001" hex"1b";

    function _validate(PackedUserOperation memory op) internal returns (uint256) {
        bytes32 hash = ep.getUserOpHash(op);
        vm.prank(address(ep));
        return wallet.validateUserOp(op, hash, 0);
    }

    function test_dummySignature_failsSoftly_forGasEstimation() public {
        PackedUserOperation memory op = _purchaseOp(100);
        op.signature = DUMMY_SIGNATURE;
        assertEq(_validate(op), 1, "SIG_VALIDATION_FAILED, not a revert");
    }

    function test_malformedSignature_reverts_AA23() public {
        PackedUserOperation memory op = _purchaseOp(100);
        op.signature = new bytes(64);
        _expectFailedOpWithRevert(
            op, "AA23 reverted", abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, uint256(64))
        );
    }

    function test_signingWithoutEip191Prefix_isRejected() public {
        PackedUserOperation memory op = _purchaseOp(100);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentKey, ep.getUserOpHash(op)); // raw hash, no prefix
        op.signature = abi.encodePacked(r, s, v);
        _expectFailedOp(op, AA24);
    }

    function test_agentOnOwnerNonceKey_isRejected() public {
        PackedUserOperation memory op = _signed(_purchaseOp(100).callData, wallet.getNonce(), agentKey);
        _expectFailedOp(op, AA24);
    }

    function test_staleNonce_AA25() public {
        PackedUserOperation memory op = _purchaseOp(100);
        assertTrue(_submit(op));
        _expectFailedOp(op, AA25); // same op replayed
    }

    function test_expiredAgent_AA22() public {
        PackedUserOperation memory op = _purchaseOp(100);
        vm.warp(DAY0 + 31 days);
        _expectFailedOp(op, AA22);
    }

    function test_handleOpsWithTooLittleGas_AA95() public {
        PackedUserOperation memory op = _purchaseOp(100);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA95 out of gas"));
        vm.prank(bundler, bundler);
        ep.handleOps{gas: 400_000}(_single(op), payable(bundler));
    }

    function test_noGasDeposit_AA21() public {
        uint256 deposit = wallet.getDeposit();
        vm.prank(owner);
        wallet.withdrawDepositTo(payable(owner), deposit);
        _expectFailedOp(_purchaseOp(100), "AA21 didn't pay prefund");
    }

    function test_spentToday_readsZeroAfterUtcMidnight() public {
        assertTrue(_submit(_purchaseOp(500)));
        assertEq(wallet.getAgent(agent).spentToday, 5 * ONE_USDC);
        assertEq(wallet.remainingDailyAllowance(agent), DAILY_LIMIT - 5 * ONE_USDC);
        vm.warp(DAY0 + 1 days); // no transaction needed: views roll over on their own
        assertEq(wallet.getAgent(agent).spentToday, 0);
        assertEq(wallet.remainingDailyAllowance(agent), DAILY_LIMIT);
    }

    function _single(PackedUserOperation memory op) internal pure returns (PackedUserOperation[] memory ops) {
        ops = new PackedUserOperation[](1);
        ops[0] = op;
    }
}
