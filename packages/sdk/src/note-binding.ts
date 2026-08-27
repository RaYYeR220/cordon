/**
 * Where a payment is allowed to land.
 *
 * Every authorisation names its destination, and the gate checks the transaction fills exactly that
 * note. That is what makes a leaked authorisation worthless: a thief cannot create a note with
 * someone else's id, because a note id is `poseidon(NOTE_ID_TAG, channel_key, token, index, 0)` and
 * the channel key commits to its owner's private key.
 *
 * It matters because authorisations do leak, without anyone needing a privileged position. A
 * reverted transaction is included on Starknet with its full calldata, and a revert does not burn
 * the nonce — so a claim that fails for an ordinary reason (the window closed, an over-velocity
 * refusal, too little shielded balance for the pool's fee) publishes a live authorisation to the
 * whole chain. Anyone can resubmit it into a note of their own, and the credential, the signature
 * and the payee key all still check out.
 *
 * So the signed field is a *binding*, and it is one of two things. Use {@link bindToNote} with an
 * id learned from the prepare-twice flow. The other one is deliberately hard to type.
 */

import { feltEquals, toFelt, type Felt, type FeltLike } from "./felt.js";
import { MAX_UNBOUND_WINDOW_SECONDS, NOTE_ANY } from "./hashing.js";

/** What an authorisation commits to about its destination. */
export type NoteBinding =
  /** The resolved open note id. A leaked authorisation is worthless to anyone else. */
  | { mode: "note"; noteId: Felt; validUntil: number }
  /** {@link NOTE_ANY}: whichever note the transaction fills. Redirectable until the deadline. */
  | { mode: "any-note"; validUntil: number };

/** Thrown when a binding cannot be built, or would be refused on chain. */
export class NoteBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteBindingError";
  }
}

/**
 * Bind an authorisation to one resolved open note. **This is the mode to use.**
 *
 * Get `noteId` from the prepare-twice flow — `prepareDirect`, `prepareClaim` and `prepareRefund`
 * do it for you, and `readResolvedNoteId` does it if you are driving the wallet yourself.
 *
 * `validUntil` is optional here: a bound authorisation is not redirectable, so it does not need to
 * die on a clock. Pass one anyway if you want the authorisation to lapse.
 */
export function bindToNote(
  noteId: FeltLike,
  options: { validUntil?: number } = {},
): NoteBinding {
  const felt = toFelt(noteId);
  if (feltEquals(felt, NOTE_ANY)) {
    throw new NoteBindingError(
      "that is the NOTE_ANY sentinel, not a note id. The gate refuses a resolved note equal to " +
        "the sentinel with CORDON_NOTE_IS_SENTINEL. If you meant to give up the binding, say so " +
        "with acceptAnyNoteAndAllowRedirection().",
    );
  }
  if (feltEquals(felt, 0)) {
    throw new NoteBindingError(
      "zero is the Fund leg's binding, not a resolved note id. A Direct, Claim or Refund binding " +
        "of zero would never match the note the wallet fills, and the gate refuses it with " +
        "CORDON_NOTE_MISMATCH.",
    );
  }
  return { mode: "note", noteId: felt, validUntil: normaliseDeadline(options.validUntil ?? 0) };
}

/**
 * Give up the note binding: accept whichever note the transaction fills.
 *
 * The name is long because the trade is real. An authorisation signed this way can be lifted out of
 * a reverted transaction's calldata and resubmitted by anyone into a note of their own, until the
 * deadline passes. Use it only where the resolved note id genuinely cannot be obtained before
 * signing — a wallet with no `strk20PrepareInvoke`, or a signer that is offline at prepare time —
 * and never as a fallback when a prepare call fails. A failed prepare is a failure to report, not a
 * reason to weaken what the subject signs.
 *
 * The gate charges for it: the deadline is mandatory and cannot be more than
 * {@link MAX_UNBOUND_WINDOW_SECONDS} seconds out. That turns "redirectable until the nonce burns"
 * — which, for a reverted transaction, is forever — into a window an attacker has to already be
 * watching for.
 *
 * The choice is inside the signed message, so a subject can see which one they made.
 */
export function acceptAnyNoteAndAllowRedirection(params: {
  /** Unix seconds. Mandatory, and within {@link MAX_UNBOUND_WINDOW_SECONDS} of now. */
  validUntil: number;
  /** Unix seconds to measure the window from. Defaults to now. */
  now?: number;
}): NoteBinding {
  const validUntil = normaliseDeadline(params.validUntil);
  const now = Math.floor(params.now ?? Date.now() / 1000);

  if (validUntil === 0) {
    throw new NoteBindingError(
      "an unbound authorisation must carry a deadline; the gate refuses one without with " +
        "CORDON_NEEDS_DEADLINE",
    );
  }
  if (validUntil <= now) {
    throw new NoteBindingError(
      `validUntil ${validUntil} is not in the future (now ${now}); the gate refuses it with ` +
        "CORDON_AUTH_EXPIRED",
    );
  }
  if (validUntil - now > MAX_UNBOUND_WINDOW_SECONDS) {
    throw new NoteBindingError(
      `validUntil ${validUntil} is ${validUntil - now}s out, past the ` +
        `${MAX_UNBOUND_WINDOW_SECONDS}s the gate allows for an unbound authorisation ` +
        "(CORDON_WINDOW_TOO_LONG). Sign closer to submission, or bind the note.",
    );
  }
  return { mode: "any-note", validUntil };
}

/** The `Fund` leg's binding: no note exists, so it commits to zero and needs no deadline. */
export function fundBinding(options: { validUntil?: number } = {}): NoteBinding {
  return { mode: "note", noteId: "0x0", validUntil: normaliseDeadline(options.validUntil ?? 0) };
}

/** The felt a binding contributes to the signed message and to the calldata. */
export function bindingFelt(binding: NoteBinding): Felt {
  return binding.mode === "any-note" ? NOTE_ANY : binding.noteId;
}

/** Whether a binding gives up the destination. */
export function isUnbound(binding: NoteBinding): boolean {
  return binding.mode === "any-note";
}

/** A one-line description of what a binding commits to, for a confirmation screen. */
export function describeBinding(binding: NoteBinding): string {
  if (binding.mode === "any-note") {
    return (
      `Any note, until ${new Date(binding.validUntil * 1000).toISOString()}. Until then this ` +
      "authorisation can be redirected to another note if it becomes public."
    );
  }
  if (feltEquals(binding.noteId, 0)) return "No note: this leg parks the value with the gate.";
  return binding.validUntil === 0
    ? `Only note ${binding.noteId}.`
    : `Only note ${binding.noteId}, until ${new Date(binding.validUntil * 1000).toISOString()}.`;
}

function normaliseDeadline(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new NoteBindingError(`validUntil must be a non-negative integer, got ${value}`);
  }
  return value;
}
