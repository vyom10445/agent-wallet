// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {SimpleAccount} from "account-abstraction/samples/SimpleAccount.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IAgentWallet} from "./interfaces/IAgentWallet.sol";

/// @title AgentWallet
/// @notice SimpleAccount (EntryPoint v0.7) plus per-agent spending policies managed by the owner.
/// @dev Phase 5: storage, admin and read functions only. Signature validation, nonces and execute/executeBatch are
///      inherited unchanged; agents cannot act yet (executeAsAgent reverts, agent signatures are not accepted).
///      All token amounts are in the policy token's base units (MockUSDC: 1 USDC = 1_000_000).
contract AgentWallet is SimpleAccount, IAgentWallet {
    /// @dev Packed: active, validAfter, validUntil, currentDay share one slot.
    struct AgentPolicy {
        bool active;
        uint48 validAfter; // inclusive
        uint48 validUntil; // inclusive, never 0 (0 means "no expiry" to the EntryPoint)
        uint64 currentDay; // block.timestamp / 1 days of the last spend
        address token; // policy token; address(0) = no spending
        uint256 maxPerTx; // base units
        uint256 dailyLimit; // base units
        uint256 spentToday; // base units spent on currentDay
    }

    mapping(address agent => AgentPolicy) internal _policies;

    /// @dev Bumped on revoke so stale allowlist entries can never come back when an agent is re-added.
    mapping(address agent => uint256) internal _epochs;

    mapping(address agent => mapping(uint256 epoch => mapping(address target => mapping(bytes4 selector => bool))))
        internal _allowedCalls;

    mapping(address agent => mapping(uint256 epoch => mapping(address recipient => bool))) internal _allowedRecipients;

    /// @dev Temporary until the restricted execution path is implemented.
    error ExecutionNotImplemented();

    constructor(IEntryPoint anEntryPoint) SimpleAccount(anEntryPoint) {}

    // ------------------------------------------------------------------
    // Administration (owner EOA, or the wallet itself via an owner-signed UserOp)
    // ------------------------------------------------------------------

    /// @inheritdoc IAgentWallet
    function addAgent(address agent, uint48 validAfter, uint48 validUntil) external onlyOwner {
        if (agent == address(0) || agent == owner || agent == address(this) || agent == address(entryPoint())) {
            revert InvalidAgent(agent);
        }
        if (_policies[agent].active) revert AgentAlreadyActive(agent);
        if (validUntil == 0 || validAfter > validUntil) revert InvalidValidityWindow(validAfter, validUntil);

        _policies[agent] = AgentPolicy({
            active: true,
            validAfter: validAfter,
            validUntil: validUntil,
            currentDay: 0,
            token: address(0),
            maxPerTx: 0,
            dailyLimit: 0,
            spentToday: 0
        });
        emit AgentAdded(agent, validAfter, validUntil);
    }

    /// @inheritdoc IAgentWallet
    function setPolicy(address agent, address token, uint256 maxPerTx, uint256 dailyLimit) external onlyOwner {
        AgentPolicy storage p = _activePolicy(agent);
        if (p.token != token) {
            // the counter is denominated in the old token
            p.spentToday = 0;
            p.currentDay = 0;
        }
        p.token = token;
        p.maxPerTx = maxPerTx;
        p.dailyLimit = dailyLimit;
        emit PolicySet(agent, token, maxPerTx, dailyLimit);
    }

    /// @inheritdoc IAgentWallet
    function allowCall(address agent, address target, bytes4 selector, bool allowed) external onlyOwner {
        _activePolicy(agent);
        _requireAllowedTarget(target);
        _allowedCalls[agent][_epochs[agent]][target][selector] = allowed;
        emit CallPermissionSet(agent, target, selector, allowed);
    }

    /// @inheritdoc IAgentWallet
    function allowRecipient(address agent, address recipient, bool allowed) external onlyOwner {
        _activePolicy(agent);
        _requireAllowedTarget(recipient);
        _allowedRecipients[agent][_epochs[agent]][recipient] = allowed;
        emit RecipientPermissionSet(agent, recipient, allowed);
    }

    /// @inheritdoc IAgentWallet
    function revokeAgent(address agent) external onlyOwner {
        _activePolicy(agent);
        delete _policies[agent];
        unchecked {
            ++_epochs[agent];
        }
        emit AgentRevoked(agent);
    }

    // ------------------------------------------------------------------
    // Execution
    // ------------------------------------------------------------------

    /// @inheritdoc IAgentWallet
    function executeAsAgent(address, address, uint256, bytes calldata) external pure {
        revert ExecutionNotImplemented();
    }

    // ------------------------------------------------------------------
    // Reads
    // ------------------------------------------------------------------

    /// @inheritdoc IAgentWallet
    function getAgent(address agent) external view returns (AgentInfo memory info) {
        AgentPolicy storage p = _policies[agent];
        info = AgentInfo({
            active: p.active,
            validAfter: p.validAfter,
            validUntil: p.validUntil,
            token: p.token,
            maxPerTx: p.maxPerTx,
            dailyLimit: p.dailyLimit,
            spentToday: _spentToday(p)
        });
    }

    /// @inheritdoc IAgentWallet
    function isAgentValid(address agent) public view returns (bool) {
        AgentPolicy storage p = _policies[agent];
        return p.active && block.timestamp >= p.validAfter && block.timestamp <= p.validUntil;
    }

    /// @inheritdoc IAgentWallet
    function isCallAllowed(address agent, address target, bytes4 selector) external view returns (bool) {
        return _policies[agent].active && _allowedCalls[agent][_epochs[agent]][target][selector];
    }

    /// @inheritdoc IAgentWallet
    function isRecipientAllowed(address agent, address recipient) external view returns (bool) {
        return _policies[agent].active && _allowedRecipients[agent][_epochs[agent]][recipient];
    }

    /// @inheritdoc IAgentWallet
    function remainingDailyAllowance(address agent) external view returns (uint256) {
        if (!isAgentValid(agent)) return 0;
        AgentPolicy storage p = _policies[agent];
        uint256 spent = _spentToday(p);
        return spent >= p.dailyLimit ? 0 : p.dailyLimit - spent;
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    function _activePolicy(address agent) internal view returns (AgentPolicy storage p) {
        p = _policies[agent];
        if (!p.active) revert AgentNotValid(agent);
    }

    function _requireAllowedTarget(address target) internal view {
        if (target == address(0) || target == address(this) || target == address(entryPoint())) {
            revert ForbiddenTarget(target);
        }
    }

    function _currentDay() internal view returns (uint64) {
        return uint64(block.timestamp / 1 days);
    }

    function _spentToday(AgentPolicy storage p) internal view returns (uint256) {
        return p.currentDay == _currentDay() ? p.spentToday : 0;
    }
}
