// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {SimpleAccount} from "account-abstraction/samples/SimpleAccount.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";

/// @title AgentWallet
/// @notice Phase 1 placeholder. Extends eth-infinitism SimpleAccount (EntryPoint v0.7) unchanged.
/// @dev Policy logic (spend limits, merchant allowlist, agent session keys) is added in a later phase.
///      Signature validation, nonce handling and the ERC-4337 lifecycle stay in SimpleAccount (Rule 3).
contract AgentWallet is SimpleAccount {
    constructor(IEntryPoint anEntryPoint) SimpleAccount(anEntryPoint) {}
}
