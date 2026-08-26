/**
 * STRK20 action arrays: the transaction shape the wallet proves and submits atomically.
 *
 * A STRK20 transaction is an ordered list of actions, not a single call. The pool applies them in
 * phases — deposit, withdraw, transfer, invoke — and the phases must be non-decreasing, with at
 * most one invoke. Three literal strings inside an action are placeholders the *wallet*
 * substitutes while assembling the transaction, and hex-encoding any of them breaks the
 * substitution silently.
 *
 * These types mirror the wallet-api (SNIP-36) shapes rather than re-exporting the generated ones,
 * so the SDK stays usable without a particular starknet.js layout. The runtime shapes are
 * identical, so what is built here is accepted verbatim by `strk20InvokeTransaction`.
 */

import { toAddress, toFelt, toU128Felt, type Address, type Felt, type FeltLike } from "./felt.js";

/**
 * `"OPEN"` — an amount that means "create an open note here and let the invoked contract fill it".
 * A literal string. Never hex-encode it.
 */
export const OPEN_NOTE = "OPEN" as const;

/**
 * `"${poolAddress}"` — the wallet substitutes the live pool address. A literal string. Never
 * hex-encode it.
 */
export const POOL_ADDRESS_PLACEHOLDER = "${poolAddress}" as const;

/**
 * `"${openNoteIds[n]}"` — the wallet substitutes the id of the nth open note created in this
 * transaction. A literal string. Never hex-encode it.
 */
export function openNoteIdPlaceholder(index = 0): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`open note index must be a non-negative integer, got ${index}`);
  }
  return `\${openNoteIds[${index}]}`;
}

/** Every literal the wallet substitutes, for a caller that wants to assert none were mangled. */
export const WALLET_PLACEHOLDERS = {
  openNote: OPEN_NOTE,
  poolAddress: POOL_ADDRESS_PLACEHOLDER,
  openNoteId: openNoteIdPlaceholder(0),
} as const;

/** A calldata entry: a felt, or one of the placeholder strings the wallet resolves. */
export type CalldataItem = Felt | string;

/** Move public funds into the pool. Always credited to self. */
export interface DepositAction {
  type: "deposit";
  token: Address;
  amount: Felt;
}

/** Move shielded funds out of the pool to a public recipient — here, to the gate. */
export interface WithdrawAction {
  type: "withdraw";
  token: Address;
  amount: Felt;
  recipient: Address;
}

/** Move shielded funds to another pool user, or reserve an open note with `amount: "OPEN"`. */
export interface TransferAction {
  type: "transfer";
  token: Address;
  amount: Felt | typeof OPEN_NOTE;
  recipient: Address;
}

/** Call a contract inside the proved transaction. This is the anonymizer hook. */
export interface InvokeAction {
  type: "invoke";
  contract: Address;
  calldata: CalldataItem[];
}

export type Strk20Action = DepositAction | WithdrawAction | TransferAction | InvokeAction;

/** Ordering the pool applies actions in. Positions must be non-decreasing. */
const PHASE: Record<Strk20Action["type"], number> = {
  deposit: 0,
  withdraw: 1,
  transfer: 2,
  invoke: 3,
};

/** A problem found in an action array before it costs a wallet round-trip to discover. */
export interface ActionProblem {
  code: "EMPTY" | "INVOKE_ONLY" | "MULTIPLE_INVOKES" | "PHASE_ORDER" | "OPEN_NOTE_WITHOUT_INVOKE";
  message: string;
}

/**
 * Check an action array against the pool's assembly rules.
 *
 * Returns every problem found rather than throwing on the first, because an array with two
 * problems is usually one misunderstanding and it is more useful to see both.
 *
 * Note what is deliberately *not* checked: an invoke without an open note. A Cordon `Fund` leaves
 * value escrowed at the gate and returns an empty deposit span, so that combination is correct.
 */
export function validateActions(actions: readonly Strk20Action[]): ActionProblem[] {
  const problems: ActionProblem[] = [];

  if (actions.length === 0) {
    return [{ code: "EMPTY", message: "A STRK20 transaction needs at least one action." }];
  }

  const invokes = actions.filter((action) => action.type === "invoke");
  const openNotes = actions.filter(
    (action) => action.type === "transfer" && action.amount === OPEN_NOTE,
  );

  if (invokes.length === actions.length) {
    problems.push({
      code: "INVOKE_ONLY",
      message:
        "An invoke-only array is rejected by the wallet with INVALID_REQUEST_PAYLOAD. Route value " +
        "through the contract first: withdraw -> transfer(OPEN) -> invoke.",
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
          `Action ${index} (${action.type}) runs in an earlier phase than the one before it. ` +
          "Order actions deposit -> withdraw -> transfer -> invoke.",
      });
      break;
    }
    previous = phase;
  }

  if (openNotes.length > 0 && invokes.length === 0) {
    problems.push({
      code: "OPEN_NOTE_WITHOUT_INVOKE",
      message:
        'A transfer with amount "OPEN" reserves a note that nothing in this transaction fills.',
    });
  }

  return problems;
}

/** Throw if an action array would be rejected. Useful as an assertion before a wallet call. */
export function assertValidActions(actions: readonly Strk20Action[]): void {
  const problems = validateActions(actions);
  if (problems.length > 0) {
    throw new Error(
      `invalid STRK20 action array:\n${problems.map((p) => `  - [${p.code}] ${p.message}`).join("\n")}`,
    );
  }
}

/** Withdraw shielded value to a public address — for Cordon, always the gate. */
export function withdrawAction(params: {
  token: Address;
  amount: FeltLike;
  recipient: Address;
}): WithdrawAction {
  return {
    type: "withdraw",
    token: toAddress(params.token, "token"),
    amount: toU128Felt(params.amount, "amount"),
    recipient: toAddress(params.recipient, "recipient"),
  };
}

/** Reserve an open note for the invoked contract to fill. */
export function openNoteAction(params: { token: Address; recipient: Address }): TransferAction {
  return {
    type: "transfer",
    token: toAddress(params.token, "token"),
    amount: OPEN_NOTE,
    recipient: toAddress(params.recipient, "recipient"),
  };
}

/** A private transfer of a known amount, note to note. */
export function transferAction(params: {
  token: Address;
  amount: FeltLike;
  recipient: Address;
}): TransferAction {
  return {
    type: "transfer",
    token: toAddress(params.token, "token"),
    amount: toU128Felt(params.amount, "amount"),
    recipient: toAddress(params.recipient, "recipient"),
  };
}

/** Shield public funds into the pool. */
export function depositAction(params: { token: Address; amount: FeltLike }): DepositAction {
  return {
    type: "deposit",
    token: toAddress(params.token, "token"),
    amount: toU128Felt(params.amount, "amount"),
  };
}

/**
 * A bare invoke action.
 *
 * Not a valid transaction on its own — see {@link validateActions}. Exported for composing custom
 * arrays; the four builders in `operations` are what you normally want.
 */
export function invokeAction(params: { contract: Address; calldata: CalldataItem[] }): InvokeAction {
  return {
    type: "invoke",
    contract: toAddress(params.contract, "contract"),
    calldata: params.calldata,
  };
}

/**
 * Normalise one calldata entry: felts become canonical hex, wallet placeholders pass through
 * untouched.
 *
 * This is the single place that knows a placeholder must not be hex-encoded, which is why every
 * encoder in this SDK funnels through it.
 */
export function calldataItem(value: CalldataItem | FeltLike): CalldataItem {
  if (typeof value === "string" && isPlaceholder(value)) return value;
  return toFelt(value);
}

/** Whether a calldata entry is a literal the wallet substitutes rather than a field element. */
export function isPlaceholder(value: string): boolean {
  return value === OPEN_NOTE || /^\$\{[A-Za-z]+(\[\d+\])?\}$/.test(value);
}

/** Pretty-print an action array exactly as it goes to the wallet. */
export function formatActions(actions: readonly Strk20Action[]): string {
  return JSON.stringify(actions, null, 2);
}
