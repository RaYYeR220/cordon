/**
 * Typed builders for STRK20 action arrays.
 *
 * A STRK20 transaction is an ordered array of actions the wallet proves and
 * submits atomically. These builders are the only place in the app that
 * constructs one, so the protocol's sharp edges live here rather than in the UI.
 */

import { num } from "starknet";
import {
  OPEN_NOTE,
  POOL_ADDRESS_PLACEHOLDER,
  openNoteIdPlaceholder,
  type Address,
  type Felt,
  type Strk20Action,
  type Strk20CalldataItem,
  type Strk20DepositAction,
  type Strk20InvokeAction,
  type Strk20TransferAction,
  type Strk20WithdrawAction,
} from "./types";

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

/** Ordering the pool applies actions in. Positions must be non-decreasing. */
const PHASE: Record<Strk20Action["type"], number> = {
  deposit: 0,
  withdraw: 1,
  transfer: 2,
  invoke: 3,
};

export type ActionProblem = {
  code:
    | "EMPTY"
    | "INVOKE_ONLY"
    | "MULTIPLE_INVOKES"
    | "PHASE_ORDER"
    | "INVOKE_WITHOUT_OPEN_NOTE"
    | "OPEN_NOTE_WITHOUT_INVOKE";
  message: string;
};

/**
 * Check an action array against the pool's assembly rules before paying a wallet
 * round-trip to learn the same thing. Returns every problem found, in order.
 */
export function validateActions(actions: readonly Strk20Action[]): ActionProblem[] {
  const problems: ActionProblem[] = [];

  if (actions.length === 0) {
    return [{ code: "EMPTY", message: "A STRK20 transaction needs at least one action." }];
  }

  const invokes = actions.filter((a) => a.type === "invoke");
  const openNotes = actions.filter((a) => a.type === "transfer" && a.amount === OPEN_NOTE);

  if (invokes.length === actions.length) {
    problems.push({
      code: "INVOKE_ONLY",
      message:
        "An invoke-only array is rejected by the wallet with INVALID_REQUEST_PAYLOAD. " +
        "Route value through the contract first: withdraw -> transfer(OPEN) -> invoke.",
    });
  }
  if (invokes.length > 1) {
    problems.push({
      code: "MULTIPLE_INVOKES",
      message: `At most one invoke-phase action per transaction; this array has ${invokes.length}.`,
    });
  }

  let previous = -1;
  for (const [index, action] of actions.entries()) {
    const phase = PHASE[action.type];
    if (phase < previous) {
      problems.push({
        code: "PHASE_ORDER",
        message:
          `Action ${index} (${action.type}) runs in an earlier phase than the action before it. ` +
          "Order actions deposit -> withdraw -> transfer -> invoke.",
      });
      break;
    }
    previous = phase;
  }

  if (invokes.length > 0 && openNotes.length === 0) {
    problems.push({
      code: "INVOKE_WITHOUT_OPEN_NOTE",
      message:
        "The invoked contract returns open-note deposits, but no transfer action with " +
        'amount "OPEN" reserves a note for them.',
    });
  }
  if (openNotes.length > 0 && invokes.length === 0) {
    problems.push({
      code: "OPEN_NOTE_WITHOUT_INVOKE",
      message: 'A transfer with amount "OPEN" reserves a note that nothing in this transaction fills.',
    });
  }

  return problems;
}

/** Pretty-print an action array exactly as it goes to the wallet. */
export function formatActions(actions: readonly Strk20Action[]): string {
  return JSON.stringify(actions, null, 2);
}
