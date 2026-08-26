/**
 * The STRK20 wallet-API surface, typed.
 *
 * The action shapes themselves come from `@cordon/sdk`, which already mirrors the wallet-api
 * (SNIP-36) structs and knows which literals the wallet substitutes. Declaring them twice is how
 * the two drift, so they are re-exported here under both the SDK's names and the `Strk20*` names
 * an app that reads the spec alongside this package will reach for.
 *
 * What is declared here is everything the SDK deliberately has no opinion about, because it is
 * pure and offline: what a wallet answered when asked whether it speaks STRK20, what a balance
 * read returned, what a node said when a transaction reverted.
 */

export {
  OPEN_NOTE,
  POOL_ADDRESS_PLACEHOLDER,
  WALLET_PLACEHOLDERS,
  assertValidActions,
  calldataItem,
  depositAction,
  formatActions,
  invokeAction,
  isPlaceholder,
  openNoteAction,
  openNoteIdPlaceholder,
  transferAction,
  validateActions,
  withdrawAction,
} from "@cordon/sdk";

export type {
  ActionProblem,
  Address,
  CalldataItem,
  Felt,
  FeltLike,
  DepositAction as Strk20DepositAction,
  InvokeAction as Strk20InvokeAction,
  Strk20Action,
  CalldataItem as Strk20CalldataItem,
  TransferAction as Strk20TransferAction,
  WithdrawAction as Strk20WithdrawAction,
} from "@cordon/sdk";

import type { Address } from "@cordon/sdk";

/** One shielded balance as returned by `wallet_strk20Balances`. */
export type Strk20Balance = {
  token: Address;
  /** Raw amount in the token's smallest unit, 0x-prefixed. */
  amount: string;
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
  /** The probe call itself, kept so a debug view can show exactly what was asked. */
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
 * An error, reduced to what can honestly be said about it: where it came from, the numeric
 * JSON-RPC code if there was one, the revert reason if the node returned one, and the untouched
 * original message.
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
   * The Cairo revert reason, when the node returned one. Short-string felts are decoded
   * (`0x434f52444f4e...` -> `CORDON_OVER_CAP`) and the raw text is kept.
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

/**
 * A value that might not be readable.
 *
 * The whole package is built on this: a balance, a policy or a revocation status that could not be
 * read renders as "unavailable" with the reason attached. It never renders as zero, and never as
 * an optimistic success.
 */
export type Unavailable = { available: false; error: Strk20NormalizedError };
export type Available<T> = { available: true; value: T };
export type Reading<T> = Available<T> | Unavailable;
