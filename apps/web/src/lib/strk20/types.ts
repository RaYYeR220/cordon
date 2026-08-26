/**
 * The STRK20 wallet-API surface, typed.
 *
 * These mirror the wallet-api spec shapes (SNIP-36) rather than re-exporting the
 * generated types, so this module stays usable outside a Starknet.js install and
 * keeps a stable surface if the upstream package reshuffles its exports. The
 * runtime shapes are identical, so values built here are accepted verbatim by
 * `WalletAccountV6.strk20InvokeTransaction`.
 */

/** A field element, as a 0x-prefixed hex string. */
export type Felt = string;

/** A contract address, as a 0x-prefixed hex string. */
export type Address = string;

/**
 * Literal placeholders the wallet substitutes while assembling a STRK20
 * transaction. They travel as plain strings and must NEVER be hex-normalised —
 * `num.toHex("OPEN")` produces garbage the wallet cannot resolve.
 */
export const OPEN_NOTE = "OPEN" as const;
export const POOL_ADDRESS_PLACEHOLDER = "${poolAddress}" as const;

/** `${openNoteIds[n]}` — the id of the nth open note created in this transaction. */
export function openNoteIdPlaceholder(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`open note index must be a non-negative integer, got ${index}`);
  }
  return `\${openNoteIds[${index}]}`;
}

/** A calldata entry: a literal felt, or a placeholder the wallet resolves. */
export type Strk20CalldataItem = Felt | string;

/** Move public funds into the pool. Always to self. */
export type Strk20DepositAction = {
  type: "deposit";
  token: Address;
  amount: Felt;
};

/** Move shielded funds out of the pool to a public recipient. */
export type Strk20WithdrawAction = {
  type: "withdraw";
  token: Address;
  amount: Felt;
  recipient: Address;
};

/**
 * Move shielded funds to another pool user. `amount: "OPEN"` creates an open
 * note instead: a placeholder note an invoke action in the same transaction
 * fills with whatever the anonymizer returns.
 */
export type Strk20TransferAction = {
  type: "transfer";
  token: Address;
  amount: Felt | typeof OPEN_NOTE;
  recipient: Address;
};

/** Call a contract inside the proved transaction (the anonymizer hook). */
export type Strk20InvokeAction = {
  type: "invoke";
  contract: Address;
  calldata: Strk20CalldataItem[];
};

export type Strk20Action =
  | Strk20DepositAction
  | Strk20WithdrawAction
  | Strk20TransferAction
  | Strk20InvokeAction;

/** One shielded balance as returned by `wallet_strk20Balances`. */
export type Strk20Balance = {
  token: Address;
  /** Raw amount in the token's smallest unit, 0x-prefixed. */
  amount: Felt;
};

/** Result of the read-only capability probe. */
export type Strk20SupportStatus =
  /** The wallet answered the probe with a well-formed balance list. */
  | "supported"
  /** The wallet is connected but does not implement the STRK20 methods. */
  | "not-implemented"
  /** The user declined the probe. Support is unknown, not absent. */
  | "declined"
  /** The wallet is on a chain where no privacy pool is deployed. */
  | "wrong-chain"
  /** The probe failed for a reason we will not guess about. */
  | "error";

export type Strk20Capability = {
  status: Strk20SupportStatus;
  /** One sentence describing the verdict, safe to render directly. */
  reason: string;
  walletName: string;
  chainId: string | null;
  /** `wallet_supportedSpecs` — the JSON-RPC spec versions the wallet speaks. */
  specVersions: string[];
  /** `wallet_supportedWalletApi` — the wallet-API versions the wallet speaks. */
  walletApiVersions: string[];
  /** The probe call itself, kept so the debug page can show what was asked. */
  probe: {
    method: "wallet_strk20Balances";
    /** False when the probe was skipped, e.g. on a chain with no pool. */
    performed: boolean;
    durationMs: number;
  };
  /** The probe doubles as the first shielded-balance read when it succeeds. */
  balances: Strk20Balance[] | null;
  error: Strk20NormalizedError | null;
};

/**
 * An error, reduced to what can honestly be said about it: where it came from,
 * the numeric JSON-RPC code if there was one, the revert reason if the node
 * returned one, and the untouched original message.
 */
export type Strk20NormalizedError = {
  /** `wallet` = wallet-API error, `rpc` = node error, `unknown` = neither. */
  source: "wallet" | "rpc" | "unknown";
  /** Numeric JSON-RPC error code, or null when the error carried none. */
  code: number | null;
  /** Spec name for `code` (e.g. `INVALID_REQUEST_PAYLOAD`), or null. */
  name: string | null;
  /** The message as thrown. Never rewritten. */
  message: string;
  /**
   * The Cairo revert reason, when the node returned one. Short-string felts are
   * decoded (`0x434f52444f4e...` -> `CORDON_OVER_CAP`) and the raw text is kept.
   */
  revertReason: string | null;
  /** Panic codes lifted out of the revert reason, decoded where possible. */
  panicCodes: string[];
  /** `error.data` verbatim, for anything the fields above did not capture. */
  data: unknown;
};

/** A submitted STRK20 transaction and what became of it. */
export type Strk20SubmitResult = {
  transactionHash: string;
  status: "submitted" | "succeeded" | "reverted" | "unconfirmed";
  /** Set when the receipt says REVERTED, or the wait failed. */
  error: Strk20NormalizedError | null;
  executionStatus: string | null;
  finalityStatus: string | null;
  /** Actual fee in the fee token's smallest unit, when the receipt carried one. */
  actualFee: string | null;
  eventCount: number | null;
};
