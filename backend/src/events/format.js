// Shared by the indexer and the feed: event names, nonce split and revert decoding.
import { explainRevertData } from "../chain/userop.js";

export const INDEXED_TYPES = ["AgentSpent", "AgentExecuted", "AgentRevoked", "PolicySet", "CreditsPurchased", "UserOperationEvent", "UserOperationRevertReason"];
const MASK64 = (1n << 64n) - 1n;

/** nonce = key (192 bits) << 64 | sequence (64 bits). Agent ops use key = agent address, owner ops key 0. */
export function splitNonce(nonce) {
  const key = BigInt(nonce) >> 64n;
  return {
    key,
    sequence: BigInt(nonce) & MASK64,
    label: key === 0n ? "owner" : key < 1n << 160n ? "agent" : "other",
    keyHex: key === 0n ? "0x0" : `0x${key.toString(16).padStart(40, "0")}`,
  };
}

/** UserOperationRevertReason bytes -> "ExceedsPerTxLimit(...)" etc., or the raw hex. */
export const explainRevert = (data) => (data && data !== "0x" ? explainRevertData(data) : null);
