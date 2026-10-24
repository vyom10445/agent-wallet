// Owner approvals (Phase 9): what the owner signs, verification of the owner's tx, and proof re-checks on read.
// None of this signs or sends a transaction, and nothing here trusts a database row on its own.
export { buildOwnerApproval, SIGN_WITH } from "./ownerApproval.js";
export { verifyOwnerApproval, inspectOwnerTx, VerifyError, CHECK_NAMES } from "./verify.js";
export { createProofs } from "./proof.js";
