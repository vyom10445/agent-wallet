// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title IAgentWallet
/// @notice Frozen public interface (H2) for the agent-permission layer added on top of SimpleAccount (EntryPoint v0.7).
/// @dev Only the functions AgentWallet ADDS are declared here. These are inherited unchanged from
///      account-abstraction v0.7.0 SimpleAccount and are part of the wallet ABI too:
///        execute(address,uint256,bytes)            owner or EntryPoint
///        executeBatch(address[],uint256[],bytes[]) owner or EntryPoint
///        owner() / entryPoint() / getNonce() / getDeposit() / addDeposit() / withdrawDepositTo(address,uint256)
///        validateUserOp(PackedUserOperation,bytes32,uint256) / initialize(address) / upgradeToAndCall(address,bytes)
///      SimpleAccount.execute/executeBatch are not virtual, so they cannot be redeclared or overridden here.
///      All token amounts are in the token's base units (MockUSDC: 6 decimals, 1 USDC = 1_000_000).
interface IAgentWallet {
    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    /// @notice Full permission record for one agent, returned by getAgent().
    struct AgentInfo {
        bool active; // true between addAgent and revokeAgent
        uint48 validAfter; // first unix timestamp the agent may act (inclusive)
        uint48 validUntil; // last unix timestamp the agent may act (inclusive)
        address token; // the only ERC20 this agent may spend (0 = no spending allowed)
        uint256 maxPerTx; // max token amount per executeAsAgent call
        uint256 dailyLimit; // max token amount per UTC day (block.timestamp / 1 days)
        uint256 spentToday; // amount already spent in the current UTC day
    }

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    event AgentAdded(address indexed agent, uint48 validAfter, uint48 validUntil);
    event AgentRevoked(address indexed agent);
    event PolicySet(address indexed agent, address indexed token, uint256 maxPerTx, uint256 dailyLimit);
    event CallPermissionSet(address indexed agent, address indexed target, bytes4 indexed selector, bool allowed);
    event RecipientPermissionSet(address indexed agent, address indexed recipient, bool allowed);
    /// @notice Emitted when an agent transfers the policy token. spentToday includes this amount.
    event AgentSpent(
        address indexed agent, address indexed token, address indexed recipient, uint256 amount, uint256 spentToday
    );
    /// @notice Emitted for every successful executeAsAgent call (spending or not).
    event AgentExecuted(address indexed agent, address indexed target, bytes4 indexed selector, uint256 value);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error InvalidAgent(address agent);
    error AgentAlreadyActive(address agent);
    error AgentNotValid(address agent);
    error InvalidValidityWindow(uint48 validAfter, uint48 validUntil);
    error UnauthorizedCaller(address caller);
    error ForbiddenTarget(address target);
    error NativeValueNotAllowed(uint256 value);
    error CallNotAllowed(address agent, address target, bytes4 selector);
    error RecipientNotAllowed(address agent, address recipient);
    error InvalidTokenCall(bytes4 selector);
    error ExceedsPerTxLimit(uint256 amount, uint256 maxPerTx);
    error ExceedsDailyLimit(uint256 amount, uint256 remaining);

    // ------------------------------------------------------------------
    // Administrative functions (owner only: owner EOA directly, or the account itself via an owner-signed UserOp)
    // ------------------------------------------------------------------

    /// @notice Register an agent key. Starts with no policy and no permissions.
    /// @dev Reverts InvalidAgent for address(0), the owner, or the wallet itself.
    function addAgent(address agent, uint48 validAfter, uint48 validUntil) external;

    /// @notice Set the spend policy of an agent. token = ERC20 to spend; amounts in token base units.
    function setPolicy(address agent, address token, uint256 maxPerTx, uint256 dailyLimit) external;

    /// @notice Allow or disallow an agent to call `selector` on `target` (non-spending calls).
    /// @dev Calls to the agent's policy token never use this list; they go through the spend rules.
    function allowCall(address agent, address target, bytes4 selector, bool allowed) external;

    /// @notice Allow or disallow `recipient` as a destination for the agent's token transfers.
    function allowRecipient(address agent, address recipient, bool allowed) external;

    /// @notice Revoke an agent immediately. Clears its policy, permissions and counters.
    function revokeAgent(address agent) external;

    // ------------------------------------------------------------------
    // Execution
    // ------------------------------------------------------------------

    /// @notice Execute one call under `agent`'s restrictions.
    /// @dev Callable by the EntryPoint (UserOp signed by `agent`) or directly by `agent`.
    ///      value must be 0. target must not be the wallet or the EntryPoint.
    ///      If target == policy token: data must be exactly transfer(address,uint256) to an allowed recipient
    ///      within maxPerTx and the remaining daily limit. Otherwise (target, selector) must be allowed.
    function executeAsAgent(address agent, address target, uint256 value, bytes calldata data) external;

    // ------------------------------------------------------------------
    // Read functions
    // ------------------------------------------------------------------

    function getAgent(address agent) external view returns (AgentInfo memory);

    /// @notice active && validAfter <= block.timestamp <= validUntil.
    function isAgentValid(address agent) external view returns (bool);

    function isCallAllowed(address agent, address target, bytes4 selector) external view returns (bool);

    function isRecipientAllowed(address agent, address recipient) external view returns (bool);

    /// @notice dailyLimit - spentToday for the current UTC day (0 if the agent is not valid).
    function remainingDailyAllowance(address agent) external view returns (uint256);
}
