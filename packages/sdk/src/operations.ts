/**
 * Gate operations: the four legs of `privacy_invoke`, their calldata and their action arrays.
 *
 * `PolicyGate::privacy_invoke(operation, token, pool_address, note_id)` takes a `GateOperation` as
 * its first argument, and each variant carries exactly the data its leg needs and nothing it does
 * not — so no caller ever passes a field the contract ignores.
 *
 * | Leg | Who signs | Action array | Returns |
 * | --- | --- | --- | --- |
 * | `Direct` | payer | `withdraw` → `transfer(OPEN)` → `invoke` | the payer's open note |
 * | `Fund` | payer | `withdraw` → `invoke` | an empty span: the value stays with the gate |
 * | `Claim` | **payee** | `transfer(OPEN, self)` → `invoke` | the payee's open note |
 * | `Refund` | payer | `transfer(OPEN, self)` → `invoke` | the payer's open note |
 *
 * `Direct` is the whole product in one transaction. `Fund`/`Claim` exist because a payer cannot
 * vouch for a payee: the gate never sees who the `transfer(OPEN)` credits, so a policy with
 * `require_payee_credential` can only be satisfied by the payee authenticating themselves, in
 * their own transaction, at the moment they take the money. `Refund` is what stops escrowed value
 * being stranded when nobody claims.
 *
 * ## Cairo enum encoding
 *
 * Cairo serialises an enum as its variant index followed by that variant's fields in declaration
 * order, and a struct as its fields in declaration order. Everything below follows from that:
 * no framing, no length prefix, no padding.
 */

import {
  POOL_ADDRESS_PLACEHOLDER,
  calldataItem,
  invokeAction,
  openNoteAction,
  openNoteIdPlaceholder,
  withdrawAction,
  type CalldataItem,
  type Strk20Action,
} from "./actions.js";
import { credentialCalldata, type Credential } from "./credential.js";
import { toAddress, toFelt, toU64Felt, type Address, type Felt, type FeltLike } from "./felt.js";
import { subjectActionHash } from "./hashing.js";
import { signHash, type Signature } from "./keys.js";

/**
 * Variant indices, in the order the Cairo enum declares them. These *are* the wire format — the
 * discriminant is the first felt of the calldata.
 */
export const GATE_OPERATION_VARIANT = {
  Direct: 0,
  Fund: 1,
  Claim: 2,
  Refund: 3,
} as const;

/**
 * The note id a `Fund` signs and sends.
 *
 * A `Fund`'s action array is `withdraw → invoke`: there is no `transfer(OPEN)`, so there is no
 * note to fill and no note id to bind. Both the signature and the calldata carry zero.
 */
export const FUND_NOTE_ID: Felt = "0x0";

/**
 * A subject proving, in one value, both who they are and that they authorised this settlement.
 *
 * The payer uses it on `Direct` and `Fund`; the payee uses the identical shape on `Claim`. One
 * type, because a payee check that drifted from a payer check would be a hole nobody notices.
 */
export interface SubjectAuthorization {
  /** The published policy to enforce against the credential. */
  policyId: Felt;
  /** The issuer-signed credential. */
  credential: Credential;
  /** The subject's signature over {@link subjectActionHash}. */
  signature: Signature;
  /** Subject-chosen, and single-use across every leg of the gate. */
  nonce: Felt;
}

/** Settle straight through to the payee's note. The common case. */
export interface DirectOperation {
  kind: "Direct";
  payer: SubjectAuthorization;
}

/** Gate the value now, park it with the gate, and let a credentialed payee claim it later. */
export interface FundOperation {
  kind: "Fund";
  /** The payer's own authorisation. The full payer policy is enforced on this leg. */
  payer: SubjectAuthorization;
  /** Chosen by the payer, and the handle both later legs quote. Claimed once, ever. */
  settlementId: FeltLike;
  /** The policy the payee will have to satisfy. Must already be published and active. */
  payeeClaimPolicyId: FeltLike;
  /** When the claim window closes and the refund window opens, in unix seconds. */
  expiresAt: FeltLike;
}

/** The payee taking a funded settlement, authenticated by their own key. */
export interface ClaimOperation {
  kind: "Claim";
  /** Which settlement to take. */
  settlementId: FeltLike;
  /** The payee's credential, checked against the settlement's `payeeClaimPolicyId`. */
  credential: Credential;
  /** The payee's signature over the action hash. */
  signature: Signature;
  /** The payee's nonce, single-use across every leg of the gate. */
  nonce: FeltLike;
}

/** The payer taking back a settlement the window closed on. */
export interface RefundOperation {
  kind: "Refund";
  /** Which settlement to unwind. */
  settlementId: FeltLike;
  /** The payer's signature over the action hash. */
  signature: Signature;
  /** The payer's nonce for this refund. A refund is an authorisation like any other. */
  nonce: FeltLike;
}

export type GateOperation = DirectOperation | FundOperation | ClaimOperation | RefundOperation;

/**
 * A `SubjectAuthorization` as the eleven felts Cairo's positional `Serde` expects:
 * `[policy_id, …7 credential felts…, sig_r, sig_s, nonce]`.
 */
export function encodeSubjectAuthorization(authorization: SubjectAuthorization): Felt[] {
  return [
    toFelt(authorization.policyId),
    ...credentialCalldata(authorization.credential),
    toFelt(authorization.signature.r),
    toFelt(authorization.signature.s),
    toFelt(authorization.nonce),
  ];
}

/**
 * Encode a `GateOperation`: variant index first, then that variant's fields in declaration order.
 *
 * ```text
 * Direct(SubjectAuthorization)                     -> [0, …11 authorisation felts…]
 * Fund  (payer, settlement_id, payee_claim_policy_id, expires_at)
 *                                                  -> [1, …11…, settlement_id, payee_policy, expires_at]
 * Claim (settlement_id, credential, sig_r, sig_s, nonce)
 *                                                  -> [2, settlement_id, …7…, r, s, nonce]
 * Refund(settlement_id, sig_r, sig_s, nonce)       -> [3, settlement_id, r, s, nonce]
 * ```
 */
export function encodeGateOperation(operation: GateOperation): Felt[] {
  switch (operation.kind) {
    case "Direct":
      return [
        toFelt(GATE_OPERATION_VARIANT.Direct),
        ...encodeSubjectAuthorization(operation.payer),
      ];
    case "Fund":
      return [
        toFelt(GATE_OPERATION_VARIANT.Fund),
        ...encodeSubjectAuthorization(operation.payer),
        toFelt(operation.settlementId),
        toFelt(operation.payeeClaimPolicyId),
        toU64Felt(operation.expiresAt, "expiresAt"),
      ];
    case "Claim":
      return [
        toFelt(GATE_OPERATION_VARIANT.Claim),
        toFelt(operation.settlementId),
        ...credentialCalldata(operation.credential),
        toFelt(operation.signature.r),
        toFelt(operation.signature.s),
        toFelt(operation.nonce),
      ];
    case "Refund":
      return [
        toFelt(GATE_OPERATION_VARIANT.Refund),
        toFelt(operation.settlementId),
        toFelt(operation.signature.r),
        toFelt(operation.signature.s),
        toFelt(operation.nonce),
      ];
  }
}

/** The arguments `privacy_invoke` takes. */
export interface PrivacyInvokeParams {
  /** Which leg the gate should run. */
  operation: GateOperation;
  /** The ERC20 being settled. */
  token: Address;
  /**
   * Overrides the `"${poolAddress}"` placeholder. Only useful when calling the gate outside a
   * wallet-assembled transaction, such as against a mock pool in a test.
   */
  poolAddress?: string;
  /**
   * Overrides the note id. Defaults to `"${openNoteIds[0]}"`, or to zero on a `Fund`, which
   * reserves no note.
   */
  noteId?: string;
  /** Which open note the placeholder should point at. Defaults to the first. */
  openNoteIndex?: number;
}

/**
 * The flat calldata for the `invoke` action, in the argument order `privacy_invoke` declares:
 *
 * ```text
 * [ …operation…, token, "${poolAddress}", "${openNoteIds[0]}" ]
 * ```
 *
 * `"${poolAddress}"` and `"${openNoteIds[0]}"` are literal strings the wallet substitutes while
 * assembling the transaction. They travel as-is; hex-encoding either one breaks the substitution
 * and the gate refuses the result as `CORDON_BAD_POOL`.
 */
export function encodePrivacyInvokeCalldata(params: PrivacyInvokeParams): CalldataItem[] {
  return [
    ...encodeGateOperation(params.operation),
    toAddress(params.token, "token"),
    calldataItem(params.poolAddress ?? POOL_ADDRESS_PLACEHOLDER),
    calldataItem(params.noteId ?? defaultNoteId(params.operation, params.openNoteIndex ?? 0)),
  ];
}

function defaultNoteId(operation: GateOperation, index: number): string {
  return operation.kind === "Fund" ? FUND_NOTE_ID : openNoteIdPlaceholder(index);
}

/**
 * Everything the action hash binds, in one place.
 *
 * Getting one of these wrong is the single most common way a settlement fails, because the gate
 * can only answer `CORDON_BAD_SUBJECT_SIG` and cannot say which field disagreed. What each leg
 * puts here is tabulated on {@link subjectActionHash}.
 */
export interface ActionSigningParams {
  /** The chain the settlement runs on, e.g. `SN_MAIN`. */
  chainId: FeltLike;
  /** The `PolicyGate` that will verify the signature. */
  gate: Address;
  /** The policy this authorisation is judged against. */
  policyId: FeltLike;
  /**
   * The open note the pool will fill.
   *
   * This is the *resolved* id, not the `"${openNoteIds[0]}"` placeholder: the wallet substitutes
   * the placeholder in the calldata, but the gate hashes whatever it actually received, so the
   * subject has to sign the resolved value. Use {@link FUND_NOTE_ID} on a `Fund`, which reserves
   * no note.
   */
  noteId: FeltLike;
  /** The ERC20 being settled. */
  token: Address;
  /**
   * The exact amount the gate will move: what the pool sent on `Direct` and `Fund`, and the
   * stored settlement's amount on `Claim` and `Refund`.
   */
  amount: FeltLike;
  /**
   * Subject-chosen, and single-use **across every leg of the gate**, not per leg. One nonce
   * registry serves `Direct`, `Fund`, `Claim` and `Refund` alike, which is what lets the leg stay
   * out of the signed message: a signature carried from one leg to another replays its nonce and
   * is refused with `CORDON_NONCE_USED`. Use {@link randomNonce} unless you are tracking them.
   */
  nonce: FeltLike;
}

/** Sign one leg's authorisation with the subject key behind the credential. */
export function signAction(params: ActionSigningParams, subjectPrivateKey: FeltLike): Signature {
  return signHash(
    subjectActionHash({
      chainId: params.chainId,
      gateAddress: params.gate,
      policyId: params.policyId,
      noteId: params.noteId,
      token: params.token,
      amount: params.amount,
      nonce: params.nonce,
    }),
    subjectPrivateKey,
  );
}

/**
 * Sign an authorisation and package it with the credential it is made under.
 *
 * This is the value `Direct` and `Fund` carry. `Claim` and `Refund` take the signature on its own,
 * because the gate reads their policy from the stored settlement rather than from the caller.
 */
export function authorizeAction(
  params: ActionSigningParams & { credential: Credential },
  subjectPrivateKey: FeltLike,
): SubjectAuthorization {
  return {
    policyId: toFelt(params.policyId),
    credential: params.credential,
    signature: signAction(params, subjectPrivateKey),
    nonce: toFelt(params.nonce),
  };
}

/** What every gate transaction names, whatever the leg. */
interface GateTransactionBase {
  /** The deployed `PolicyGate`. */
  gate: Address;
  /** The ERC20 being settled. */
  token: Address;
  /** Test-only overrides; see {@link PrivacyInvokeParams}. */
  poolAddress?: string;
  noteId?: string;
  openNoteIndex?: number;
}

/** A `Direct` settlement: gated value straight into the payee's note. */
export interface DirectTransactionParams extends GateTransactionBase {
  /** Value to move, in token base units. Must equal the amount the payer signed over. */
  amount: FeltLike;
  /** The pool user the resulting open note is credited to. */
  payee: Address;
  /** The payer's authorisation, from {@link authorizeAction}. */
  payer: SubjectAuthorization;
}

/** A `Fund`: gated value parked for a payee who must present their own credential. */
export interface FundTransactionParams extends GateTransactionBase {
  amount: FeltLike;
  /** The payer's authorisation, signed with {@link FUND_NOTE_ID} as the note id. */
  payer: SubjectAuthorization;
  /** Names the escrow. Single-use, ever. */
  settlementId: FeltLike;
  /** The policy the payee's credential will be judged against on `Claim`. */
  payeeClaimPolicyId: FeltLike;
  /** Unix seconds after which only a `Refund` is possible. */
  expiresAt: FeltLike;
}

/** A `Claim`: the payee takes an escrow, presenting their own credential. */
export interface ClaimTransactionParams extends GateTransactionBase {
  settlementId: FeltLike;
  /** The payee's credential. */
  credential: Credential;
  /** The payee's signature over the action hash. */
  signature: Signature;
  /** The payee's nonce. */
  nonce: FeltLike;
  /** Who the claimed note is credited to — the payee themselves. */
  recipient: Address;
}

/** A `Refund`: the payer takes back an unclaimed escrow. */
export interface RefundTransactionParams extends GateTransactionBase {
  settlementId: FeltLike;
  /** The payer's signature over the action hash. */
  signature: Signature;
  /** The payer's nonce. */
  nonce: FeltLike;
  /** Who the refunded note is credited to — the original payer. */
  recipient: Address;
}

/** The `invoke` calldata for a `Direct` settlement. */
export function encodeDirectCalldata(params: DirectTransactionParams): CalldataItem[] {
  return encodePrivacyInvokeCalldata({
    ...passthrough(params),
    operation: { kind: "Direct", payer: params.payer },
  });
}

/** The `invoke` calldata for a `Fund`. */
export function encodeFundCalldata(params: FundTransactionParams): CalldataItem[] {
  return encodePrivacyInvokeCalldata({
    ...passthrough(params),
    operation: {
      kind: "Fund",
      payer: params.payer,
      settlementId: params.settlementId,
      payeeClaimPolicyId: params.payeeClaimPolicyId,
      expiresAt: params.expiresAt,
    },
  });
}

/** The `invoke` calldata for a `Claim`. */
export function encodeClaimCalldata(params: ClaimTransactionParams): CalldataItem[] {
  return encodePrivacyInvokeCalldata({
    ...passthrough(params),
    operation: {
      kind: "Claim",
      settlementId: params.settlementId,
      credential: params.credential,
      signature: params.signature,
      nonce: params.nonce,
    },
  });
}

/** The `invoke` calldata for a `Refund`. */
export function encodeRefundCalldata(params: RefundTransactionParams): CalldataItem[] {
  return encodePrivacyInvokeCalldata({
    ...passthrough(params),
    operation: {
      kind: "Refund",
      settlementId: params.settlementId,
      signature: params.signature,
      nonce: params.nonce,
    },
  });
}

/**
 * The full action array for a `Direct` settlement: `withdraw` → `transfer(OPEN)` → `invoke`.
 *
 * The pool moves the value to the gate *before* calling it, the open note reserves where the gated
 * value lands, and the invoke runs the policy. An invoke-only array is rejected by the wallet with
 * `INVALID_REQUEST_PAYLOAD`, which is why this is three actions and not one.
 */
export function buildDirectActions(params: DirectTransactionParams): Strk20Action[] {
  return [
    withdrawAction({ token: params.token, amount: params.amount, recipient: params.gate }),
    openNoteAction({ token: params.token, recipient: params.payee }),
    invokeAction({
      contract: toAddress(params.gate, "gate"),
      calldata: encodeDirectCalldata(params),
    }),
  ];
}

/**
 * The full action array for a `Fund`: `withdraw` → `invoke`.
 *
 * No open note, because nothing comes back in this transaction — the gate books a settlement,
 * keeps the value, and returns an empty deposit span.
 */
export function buildFundActions(params: FundTransactionParams): Strk20Action[] {
  return [
    withdrawAction({ token: params.token, amount: params.amount, recipient: params.gate }),
    invokeAction({ contract: toAddress(params.gate, "gate"), calldata: encodeFundCalldata(params) }),
  ];
}

/**
 * The full action array for a `Claim`: `transfer(OPEN, self)` → `invoke`.
 *
 * There is no withdraw: the value has been sitting at the gate since the `Fund`, and the payee
 * funds nothing. The open note is where the gate deposits it once the payee's credential clears.
 * A leg the pool *did* fund is refused with `CORDON_UNEXPECTED_VALUE`.
 */
export function buildClaimActions(params: ClaimTransactionParams): Strk20Action[] {
  return [
    openNoteAction({ token: params.token, recipient: params.recipient }),
    invokeAction({
      contract: toAddress(params.gate, "gate"),
      calldata: encodeClaimCalldata(params),
    }),
  ];
}

/** The full action array for a `Refund`: `transfer(OPEN, self)` → `invoke`, back to the payer. */
export function buildRefundActions(params: RefundTransactionParams): Strk20Action[] {
  return [
    openNoteAction({ token: params.token, recipient: params.recipient }),
    invokeAction({
      contract: toAddress(params.gate, "gate"),
      calldata: encodeRefundCalldata(params),
    }),
  ];
}

function passthrough(params: GateTransactionBase): Omit<PrivacyInvokeParams, "operation"> {
  return {
    token: params.token,
    ...(params.poolAddress !== undefined ? { poolAddress: params.poolAddress } : {}),
    ...(params.noteId !== undefined ? { noteId: params.noteId } : {}),
    ...(params.openNoteIndex !== undefined ? { openNoteIndex: params.openNoteIndex } : {}),
  };
}
