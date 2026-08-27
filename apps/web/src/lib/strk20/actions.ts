/**
 * The plain STRK20 actions the debug console exercises.
 *
 * These are shell operations — shield, private transfer, unshield, and a generic anonymizer
 * round-trip — not Cordon settlements. The four gated legs are built by `@cordon/sdk`, and the
 * action types, `validateActions` and `formatActions` come from `@cordon/react/strk20`, so there
 * is one definition of what a valid action array is rather than one per package.
 */

import { num } from "starknet";
import {
  OPEN_NOTE,
  POOL_ADDRESS_PLACEHOLDER,
  openNoteIdPlaceholder,
  type Address,
  type Felt,
  type Strk20CalldataItem,
  type Strk20DepositAction,
  type Strk20InvokeAction,
  type Strk20TransferAction,
  type Strk20WithdrawAction,
} from "@cordon/react/strk20";

/** Encode an amount as the 0x felt the wallet expects. */
export function toFeltAmount(amount: bigint): Felt {
  if (amount < 0n) throw new RangeError("amount must not be negative");
  return num.toHex(amount);
}

function normalizeAddress(address: Address, label: string): Address {
  if (!address || !/^0x[0-9a-fA-F]+$/.test(address)) {
    throw new TypeError(`${label} must be a 0x-prefixed address, got ${JSON.stringify(address)}`);
  }
  return num.toHex(address);
}

/** Shield: move public funds into the pool. Always credited to self. */
export function buildShield(params: { token: Address; amount: bigint }): [Strk20DepositAction] {
  return [
    {
      type: "deposit",
      token: normalizeAddress(params.token, "token"),
      amount: toFeltAmount(params.amount),
    },
  ];
}

/** Private transfer: shielded balance to another pool user, note to note. */
export function buildPrivateTransfer(params: {
  token: Address;
  amount: bigint;
  recipient: Address;
}): [Strk20TransferAction] {
  return [
    {
      type: "transfer",
      token: normalizeAddress(params.token, "token"),
      amount: toFeltAmount(params.amount),
      recipient: normalizeAddress(params.recipient, "recipient"),
    },
  ];
}

/** Unshield: move shielded funds back out to a public address. */
export function buildUnshield(params: {
  token: Address;
  amount: bigint;
  recipient: Address;
}): [Strk20WithdrawAction] {
  return [
    {
      type: "withdraw",
      token: normalizeAddress(params.token, "token"),
      amount: toFeltAmount(params.amount),
      recipient: normalizeAddress(params.recipient, "recipient"),
    },
  ];
}

/**
 * The anonymizer round-trip.
 *
 * The pool moves the tokens to the anonymizer BEFORE calling it, then the
 * anonymizer approves the pool for the amount it wants credited back and returns
 * a `Span<OpenNoteDeposit>` that the pool settles into the open notes created in
 * the same transaction. That is why this is three actions and not one:
 *
 *   1. `withdraw` sends the value to the anonymizer contract,
 *   2. `transfer` with amount `"OPEN"` reserves the note the output lands in,
 *   3. `invoke` calls the anonymizer.
 *
 * An `invoke`-only array is rejected by the wallet with INVALID_REQUEST_PAYLOAD.
 *
 * `"OPEN"`, `"${poolAddress}"` and `"${openNoteIds[0]}"` are literal strings the
 * wallet substitutes while assembling the transaction. Hex-encoding them breaks
 * the substitution, so they are passed through untouched.
 */
export function buildAnonymizerRoundTrip(params: {
  token: Address;
  amount: bigint;
  /** The anonymizer contract the value routes through. */
  anonymizer: Address;
  /** Who the resulting open note is credited to (a pool user). */
  noteRecipient: Address;
  /**
   * Calldata appended after the standard prefix
   * `[token, ${poolAddress}, ${openNoteIds[0]}]`, which is what every anonymizer
   * needs to identify the token, authenticate its caller and fill the note.
   */
  extraCalldata?: Strk20CalldataItem[];
}): [Strk20WithdrawAction, Strk20TransferAction, Strk20InvokeAction] {
  const token = normalizeAddress(params.token, "token");
  const anonymizer = normalizeAddress(params.anonymizer, "anonymizer");
  const noteRecipient = normalizeAddress(params.noteRecipient, "noteRecipient");

  return [
    { type: "withdraw", token, amount: toFeltAmount(params.amount), recipient: anonymizer },
    { type: "transfer", token, amount: OPEN_NOTE, recipient: noteRecipient },
    {
      type: "invoke",
      contract: anonymizer,
      calldata: [
        token,
        POOL_ADDRESS_PLACEHOLDER,
        openNoteIdPlaceholder(0),
        ...(params.extraCalldata ?? []),
      ],
    },
  ];
}

/**
 * A bare invoke action. Exported for composing custom arrays — it is NOT a valid
 * transaction on its own, see `validateActions`.
 */
export function buildInvoke(params: {
  contract: Address;
  calldata: Strk20CalldataItem[];
}): Strk20InvokeAction {
  return {
    type: "invoke",
    contract: normalizeAddress(params.contract, "contract"),
    calldata: params.calldata,
  };
}
