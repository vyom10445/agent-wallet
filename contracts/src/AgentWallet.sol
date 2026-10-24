// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {SimpleAccount} from "account-abstraction/samples/SimpleAccount.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {SIG_VALIDATION_FAILED, SIG_VALIDATION_SUCCESS, _packValidationData} from "account-abstraction/core/Helpers.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IAgentWallet} from "./interfaces/IAgentWallet.sol";

/// @title AgentWallet
/// @notice SimpleAccount (EntryPoint v0.7) plus per-agent spending policies managed by the owner.
/// @dev Owner signature validation, nonces, execute/executeBatch and the ERC-4337 lifecycle are inherited unchanged.
///      Agents act only through UserOps whose callData is executeAsAgent(agent = signer, ...); the EntryPoint is the
///      only caller executeAsAgent accepts. Every decrease of the policy token balance during an agent call is counted
///      against maxPerTx and the daily limit and must go to an allowed recipient.
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
    /// @dev Only callable by the EntryPoint, after _validateSignature checked that the UserOp signer is `agent`.
    function executeAsAgent(address agent, address target, uint256 value, bytes calldata data) external {
        if (msg.sender != address(entryPoint())) revert UnauthorizedCaller(msg.sender);
        if (!isAgentValid(agent)) revert AgentNotValid(agent);
        _revertWith(_agentCallError(agent, target, value, data));

        AgentPolicy storage p = _policies[agent];
        address token = p.token;
        uint256 balanceBefore = token == address(0) ? 0 : IERC20(token).balanceOf(address(this));

        _call(target, 0, data);

        if (token != address(0)) {
            uint256 balanceAfter = IERC20(token).balanceOf(address(this));
            if (balanceAfter < balanceBefore) _recordSpend(agent, p, target, data, balanceBefore - balanceAfter);
        }
        emit AgentExecuted(agent, target, bytes4(data[:4]), value);
    }

    // ------------------------------------------------------------------
    // ERC-4337 validation
    // ------------------------------------------------------------------

    /// @dev A UserOp calling executeAsAgent is valid only if it is signed by the agent named in its first argument,
    ///      uses nonce key uint192(agent), and passes that agent's time-independent checks; the validity window is returned to the EntryPoint as
    ///      validAfter/validUntil because ERC-7562 forbids reading block.timestamp during validation. Every other
    ///      UserOp goes to the unchanged SimpleAccount owner check. Only the wallet's own storage is read here.
    function _validateSignature(PackedUserOperation calldata userOp, bytes32 userOpHash)
        internal
        override
        returns (uint256 validationData)
    {
        bytes calldata callData = userOp.callData;
        if (callData.length < 4 || bytes4(callData[:4]) != this.executeAsAgent.selector) {
            return super._validateSignature(userOp, userOpHash);
        }

        (address agent, address target, uint256 value, bytes memory data) =
            abi.decode(callData[4:], (address, address, uint256, bytes));

        address signer = ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(userOpHash), userOp.signature);
        if (signer != agent) return SIG_VALIDATION_FAILED;
        // Agents must use their own nonce key so they cannot consume the owner's (key 0) or another agent's sequence.
        if (userOp.nonce >> 64 != uint160(agent)) return SIG_VALIDATION_FAILED;
        if (_agentCallError(agent, target, value, data).length != 0) return SIG_VALIDATION_FAILED;

        AgentPolicy storage p = _policies[agent];
        return _packValidationData(false, p.validUntil, p.validAfter);
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

    /// @dev Checks that do not depend on time, shared by validation and execution. Empty return = allowed,
    ///      otherwise the ABI-encoded custom error to revert with.
    function _agentCallError(address agent, address target, uint256 value, bytes memory data)
        internal
        view
        returns (bytes memory)
    {
        AgentPolicy storage p = _policies[agent];
        if (!p.active) return abi.encodeWithSelector(AgentNotValid.selector, agent);
        if (value != 0) return abi.encodeWithSelector(NativeValueNotAllowed.selector, value);
        if (target == address(0) || target == address(this) || target == address(entryPoint())) {
            return abi.encodeWithSelector(ForbiddenTarget.selector, target);
        }
        if (data.length < 4) return abi.encodeWithSelector(CallNotAllowed.selector, agent, target, bytes4(0));
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes4 selector = bytes4(data); // length checked above
        if (target == p.token) {
            // Only an exact transfer(address,uint256) to an allowed recipient within maxPerTx.
            if (selector != IERC20.transfer.selector || data.length != 68) {
                return abi.encodeWithSelector(InvalidTokenCall.selector, selector);
            }
            uint256 recipientWord;
            uint256 amount;
            assembly ("memory-safe") {
                recipientWord := mload(add(data, 36))
                amount := mload(add(data, 68))
            }
            if (recipientWord >> 160 != 0) return abi.encodeWithSelector(InvalidTokenCall.selector, selector);
            // forge-lint: disable-next-line(unsafe-typecast)
            address recipient = address(uint160(recipientWord));
            if (!_allowedRecipients[agent][_epochs[agent]][recipient]) {
                return abi.encodeWithSelector(RecipientNotAllowed.selector, agent, recipient);
            }
            if (amount > p.maxPerTx) return abi.encodeWithSelector(ExceedsPerTxLimit.selector, amount, p.maxPerTx);
            return "";
        }
        if (!_allowedCalls[agent][_epochs[agent]][target][selector]) {
            return abi.encodeWithSelector(CallNotAllowed.selector, agent, target, selector);
        }
        return "";
    }

    /// @dev Counts a policy-token decrease of `amount` caused by an agent call. Reverting here reverts the whole call,
    ///      so the counter only ever includes spending that actually happened.
    function _recordSpend(address agent, AgentPolicy storage p, address target, bytes calldata data, uint256 amount)
        internal
    {
        address recipient;
        if (target == p.token) {
            (recipient,) = abi.decode(data[4:], (address, uint256));
        } else {
            // Pulled through an allowance by an allowlisted contract: that contract is the payee and must be allowed.
            recipient = target;
            if (!_allowedRecipients[agent][_epochs[agent]][target]) revert RecipientNotAllowed(agent, target);
        }
        if (amount > p.maxPerTx) revert ExceedsPerTxLimit(amount, p.maxPerTx);

        uint64 today = _currentDay();
        uint256 spent = p.currentDay == today ? p.spentToday : 0;
        uint256 remaining = spent >= p.dailyLimit ? 0 : p.dailyLimit - spent;
        if (amount > remaining) revert ExceedsDailyLimit(amount, remaining);

        p.currentDay = today;
        p.spentToday = spent + amount;
        emit AgentSpent(agent, p.token, recipient, amount, spent + amount);
    }

    function _revertWith(bytes memory err) internal pure {
        if (err.length != 0) {
            assembly ("memory-safe") {
                revert(add(err, 32), mload(err))
            }
        }
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
