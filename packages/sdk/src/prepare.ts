/**
 * The prepare-twice flow: learn the note id, sign it, submit.
 *
 * An authorisation names the note it is allowed to fill, and that binding is what makes a leaked
 * authorisation worthless. The complication is that on the Wallet API route the signer cannot
 * compute the note id: the application submits the literal `"${openNoteIds[0]}"` and the *wallet*
 * substitutes the resolved felt, which is
 * `poseidon(NOTE_ID_TAG, channel_key, token, index, 0)` — and the channel key commits to the
 * wallet's private key.
 *
 * `strk20PrepareInvoke` is the way out. It returns a **fully resolved** Starknet `Call`, so the
 * substituted note id is sitting in `call.calldata`. The flow is:
 *
 * 1. prepare once with a throwaway authorisation, to learn the note id;
 * 2. sign the real authorisation bound to that id;
 * 3. prepare again with the real signature, and submit that.
 *
 * The id is stable across the round trip because none of its inputs depend on the invoke calldata —
 * only the channel key, the token and the note index. The index moves only if another transaction
 * lands on the same channel in between, and then the second prepare produces a *different* id,
 * which this module treats as a hard failure. That is the point: the transaction fails closed
 * instead of paying the wrong party.
 *
 * Nothing here ever falls back to `NOTE_ANY`. A wallet that cannot resolve calldata, or a prepare
 * that fails, is a reported condition — see {@link NotePreparationError}. Weakening what the
 * subject signs is a decision for the caller to make explicitly, with
 * `acceptAnyNoteAndAllowRedirection`.
 */

import type { Strk20Action } from "./actions.js";
import { isPlaceholder } from "./actions.js";
import type { GateContext } from "./context.js";
import type { Credential } from "./credential.js";
import { feltEquals, isFelt, toFelt, type Address, type Felt, type FeltLike } from "./felt.js";
import { NOTE_ANY } from "./hashing.js";
import { bindToNote, type NoteBinding } from "./note-binding.js";
import {
  authorizeClaim,
  authorizeDirect,
  authorizeFund,
  authorizeRefund,
  buildClaimActions,
  buildDirectActions,
  buildFundActions,
  buildRefundActions,
  type ClaimAuthorization,
  type DirectAuthorization,
  type FundAuthorization,
  type GateAuthorization,
  type RefundAuthorization,
} from "./operations.js";
import type { Settlement } from "./settlement.js";

/** A Starknet call with its placeholders already substituted. */
export interface ResolvedCall {
  contractAddress: string;
  entrypoint?: string;
  selector?: string;
  calldata: string[];
}

/** What `strk20PrepareInvoke` hands back. */
export interface PreparedInvoke {
  /** The resolved call. `calldata` is what will actually execute. */
  call: ResolvedCall;
  /** The proof the wallet built. Opaque here; hand it back to the wallet to submit. */
  proof?: unknown;
}

/**
 * The wallet's `strk20PrepareInvoke`, as a plain function.
 *
 * A function rather than an object so this package never has to guess at one wallet's method
 * shape. Adapt whatever you have in a line:
 *
 * ```ts
 * const prepare: Strk20Prepare = (actions) => wallet.strk20PrepareInvoke({ actions });
 * ```
 */
export type Strk20Prepare = (actions: Strk20Action[]) => Promise<PreparedInvoke>;

/**
 * Thrown when the resolved note id cannot be read from a prepared call.
 *
 * This is the honest-degradation path. A wallet that does not substitute placeholders, or returns
 * no calldata, is named here rather than quietly downgraded to `NOTE_ANY` — the whole value of the
 * binding is that the subject saw the choice they made.
 */
export class NotePreparationError extends Error {
  /** The prepared call, when there was one, so a caller can report what came back. */
  readonly prepared: PreparedInvoke | undefined;

  constructor(message: string, prepared?: PreparedInvoke) {
    super(message);
    this.name = "NotePreparationError";
    this.prepared = prepared;
  }
}

/**
 * Thrown when the note id moved between the two prepares.
 *
 * Another transaction landed on the same channel and advanced the note index, so the id the
 * authorisation was signed for is no longer the id this transaction would fill. Submitting anyway
 * would revert with `CORDON_NOTE_MISMATCH`; retry the whole flow to sign for the new note.
 */
export class NoteDriftError extends Error {
  readonly signedNoteId: Felt;
  readonly preparedNoteId: Felt;

  constructor(signedNoteId: Felt, preparedNoteId: Felt) {
    super(
      `the open note moved between prepares: signed for ${signedNoteId}, the transaction would ` +
        `fill ${preparedNoteId}. Another transaction landed on this channel in between. Retry the ` +
        "flow to sign for the new note; submitting this would revert with CORDON_NOTE_MISMATCH.",
    );
    this.name = "NoteDriftError";
    this.signedNoteId = signedNoteId;
    this.preparedNoteId = preparedNoteId;
  }
}

/**
 * Read the resolved open note id out of a prepared call.
 *
 * The note id is the last felt of the gate's calldata — `privacy_invoke(operation, token,
 * pool_address, note_id)` — and this SDK built that calldata, so the position is known rather than
 * guessed.
 *
 * Throws {@link NotePreparationError} if the wallet did not resolve the placeholder, which is a
 * condition to report, not to work around.
 */
export function readResolvedNoteId(prepared: PreparedInvoke): Felt {
  const calldata = prepared?.call?.calldata;
  if (!Array.isArray(calldata) || calldata.length === 0) {
    throw new NotePreparationError(
      "strk20PrepareInvoke returned no calldata, so the resolved note id cannot be read. This " +
        "wallet cannot support a bound authorisation. Either use a wallet that returns a resolved " +
        "call, or decide explicitly to sign an unbound one with " +
        "acceptAnyNoteAndAllowRedirection() — this SDK will not make that choice for you.",
      prepared,
    );
  }

  const last = calldata[calldata.length - 1];
  if (typeof last !== "string") {
    throw new NotePreparationError(
      `the last calldata element is ${typeof last}, not a felt; the prepared call is not the ` +
        "gate invoke this SDK built",
      prepared,
    );
  }
  if (isPlaceholder(last)) {
    throw new NotePreparationError(
      `strk20PrepareInvoke returned the unsubstituted placeholder ${last}. This wallet does not ` +
        "resolve calldata at prepare time, so the note id is not knowable before signing.",
      prepared,
    );
  }
  if (!isFelt(last)) {
    throw new NotePreparationError(
      `the last calldata element ${JSON.stringify(last)} is not a field element`,
      prepared,
    );
  }
  if (feltEquals(last, NOTE_ANY)) {
    throw new NotePreparationError(
      "the resolved note id equals the NOTE_ANY sentinel, which the gate refuses with " +
        "CORDON_NOTE_IS_SENTINEL",
      prepared,
    );
  }
  if (feltEquals(last, 0)) {
    throw new NotePreparationError(
      "the resolved note id is zero, which is the Fund leg's binding and never a real note",
      prepared,
    );
  }
  return toFelt(last);
}

/** A signed leg, its action array, and the resolved call ready to submit. */
export interface PreparedGateTransaction<TAuthorization extends GateAuthorization> {
  /** The authorisation, bound to the note this transaction will actually fill. */
  authorization: TAuthorization;
  /** The action array that was prepared. */
  actions: Strk20Action[];
  /** The resolved call. */
  call: ResolvedCall;
  /** The wallet's proof, to submit. */
  proof?: unknown;
  /** The note id the authorisation is bound to. Zero on a `Fund`. */
  noteId: Felt;
}

interface FlowOptions {
  /** The wallet's `strk20PrepareInvoke`. */
  prepare: Strk20Prepare;
  /** Optional deadline on the authorisation. A bound one does not need it. */
  validUntil?: number;
}

/**
 * Run the two prepares for a leg that fills a note.
 *
 * `signFor` is called twice: once with a throwaway binding to learn the note, once with the real
 * one. The first authorisation is never returned and never submitted.
 */
async function bindAndPrepare<TAuthorization extends GateAuthorization>(
  options: FlowOptions,
  signFor: (binding: NoteBinding) => TAuthorization,
  build: (authorization: TAuthorization) => Strk20Action[],
): Promise<PreparedGateTransaction<TAuthorization>> {
  // A probe only has to have the right *shape*: the note id depends on the channel key, the token
  // and the note index, never on the invoke calldata. It is bound to a placeholder note so that
  // nothing valid is ever produced by the first pass.
  const probeBinding = bindToNote(PROBE_NOTE_ID, { validUntil: 1 });
  const probe = build(signFor(probeBinding));
  const noteId = readResolvedNoteId(await options.prepare(probe));

  const binding = bindToNote(
    noteId,
    options.validUntil === undefined ? {} : { validUntil: options.validUntil },
  );
  const authorization = signFor(binding);
  const actions = build(authorization);
  const prepared = await options.prepare(actions);

  const preparedNoteId = readResolvedNoteId(prepared);
  if (!feltEquals(preparedNoteId, noteId)) {
    throw new NoteDriftError(noteId, preparedNoteId);
  }

  return {
    authorization,
    actions,
    call: prepared.call,
    ...(prepared.proof === undefined ? {} : { proof: prepared.proof }),
    noteId,
  };
}

/**
 * A note id used only for the first, throwaway prepare.
 *
 * Never signed for anything that leaves this module: the probe authorisation is discarded as soon
 * as the real note id is known, and it carries a deadline of 1 (the unix epoch) so that even if one
 * escaped it would be dead on arrival with `CORDON_AUTH_EXPIRED`.
 */
const PROBE_NOTE_ID: Felt = "0x1";

/**
 * Sign and prepare a `Direct` payment, bound to the note it will actually fill.
 *
 * This is the default path for a gated private payment.
 *
 * ```ts
 * const { call, proof } = await prepareDirect(
 *   { prepare, context, token, policyId, credential, amount, payee },
 *   subject.privateKey,
 * );
 * ```
 */
export async function prepareDirect(
  params: FlowOptions & {
    context: GateContext;
    token: Address;
    policyId: FeltLike;
    credential: Credential;
    amount: FeltLike;
    /** The pool user the resulting open note is credited to. */
    payee: Address;
    nonce?: FeltLike;
  },
  subjectPrivateKey: FeltLike,
): Promise<PreparedGateTransaction<DirectAuthorization>> {
  return bindAndPrepare(
    params,
    (binding) =>
      authorizeDirect(
        {
          context: params.context,
          token: params.token,
          policyId: params.policyId,
          credential: params.credential,
          amount: params.amount,
          binding,
          ...(params.nonce === undefined ? {} : { nonce: params.nonce }),
        },
        subjectPrivateKey,
      ),
    (authorization) => buildDirectActions({ authorization, payee: params.payee }),
  );
}

/**
 * Sign and prepare a `Claim`: the named payee takes a funded settlement into their own note.
 *
 * This is the leg the binding matters most for. A claim that fails for an ordinary reason publishes
 * a live authorisation in the reverted transaction's calldata, and without a binding anyone could
 * resubmit it into a note of their own.
 */
export async function prepareClaim(
  params: FlowOptions & {
    context: GateContext;
    settlement: Settlement;
    settlementId: FeltLike;
    credential: Credential;
    /** Who the claimed note is credited to — the payee themselves. */
    recipient: Address;
    nonce?: FeltLike;
  },
  subjectPrivateKey: FeltLike,
): Promise<PreparedGateTransaction<ClaimAuthorization>> {
  return bindAndPrepare(
    params,
    (binding) =>
      authorizeClaim(
        {
          context: params.context,
          settlement: params.settlement,
          settlementId: params.settlementId,
          credential: params.credential,
          binding,
          ...(params.nonce === undefined ? {} : { nonce: params.nonce }),
        },
        subjectPrivateKey,
      ),
    (authorization) => buildClaimActions({ authorization, recipient: params.recipient }),
  );
}

/** Sign and prepare a `Refund`: the payer takes back a settlement the window closed on. */
export async function prepareRefund(
  params: FlowOptions & {
    context: GateContext;
    settlement: Settlement;
    settlementId: FeltLike;
    /** Who the refunded note is credited to — the original payer. */
    recipient: Address;
    nonce?: FeltLike;
  },
  subjectPrivateKey: FeltLike,
): Promise<PreparedGateTransaction<RefundAuthorization>> {
  return bindAndPrepare(
    params,
    (binding) =>
      authorizeRefund(
        {
          context: params.context,
          settlement: params.settlement,
          settlementId: params.settlementId,
          binding,
          ...(params.nonce === undefined ? {} : { nonce: params.nonce }),
        },
        subjectPrivateKey,
      ),
    (authorization) => buildRefundActions({ authorization, recipient: params.recipient }),
  );
}

/**
 * Sign and prepare a `Fund`.
 *
 * One prepare, not two: a funding leg fills no note, so its binding is always zero and there is
 * nothing to learn. Here for symmetry, and so a caller can use one shape for every leg.
 */
export async function prepareFund(
  params: FlowOptions & {
    context: GateContext;
    token: Address;
    policyId: FeltLike;
    credential: Credential;
    amount: FeltLike;
    payeeSubjectKey: FeltLike;
    payeeClaimPolicyId: FeltLike;
    expiresAt: FeltLike;
    settlementId?: FeltLike;
    nonce?: FeltLike;
  },
  subjectPrivateKey: FeltLike,
): Promise<PreparedGateTransaction<FundAuthorization>> {
  const authorization = authorizeFund(
    {
      context: params.context,
      token: params.token,
      policyId: params.policyId,
      credential: params.credential,
      amount: params.amount,
      payeeSubjectKey: params.payeeSubjectKey,
      payeeClaimPolicyId: params.payeeClaimPolicyId,
      expiresAt: params.expiresAt,
      ...(params.validUntil === undefined ? {} : { validUntil: params.validUntil }),
      ...(params.settlementId === undefined ? {} : { settlementId: params.settlementId }),
      ...(params.nonce === undefined ? {} : { nonce: params.nonce }),
    },
    subjectPrivateKey,
  );

  const actions = buildFundActions({ authorization });
  const prepared = await params.prepare(actions);

  return {
    authorization,
    actions,
    call: prepared.call,
    ...(prepared.proof === undefined ? {} : { proof: prepared.proof }),
    noteId: "0x0",
  };
}
