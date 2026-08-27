/**
 * Gate operations: the four legs of `privacy_invoke`, their calldata and their action arrays.
 *
 * `PolicyGate::privacy_invoke(operation, token, pool_address, note_id)` takes a `GateOperation` as
 * its first argument, and each variant carries exactly the data its leg needs.
 *
 * | Leg | Who signs | Action array | Returns |
 * | --- | --- | --- | --- |
 * | `Direct` | payer | `withdraw` → `transfer(OPEN)` → `invoke` | the payer's open note |
 * | `Fund` | payer | `withdraw` → `invoke` | an empty span: the value stays with the gate |
 * | `Claim` | **the named payee** | `transfer(OPEN, self)` → `invoke` | the payee's open note |
 * | `Refund` | payer | `transfer(OPEN, self)` → `invoke` | the payer's open note |
 *
 * ## Why this module has no `amount` parameter on any builder
 *
 * The amount lives inside the signed authorisation — it is a field of `SubjectAuthorization` in the
 * contract — and the gate settles exactly what was signed. So the `withdraw` action and the
 * signature have to name the same number, and the consequences of them disagreeing are ugly and
 * silent: withdrawing **more** than was signed leaves the difference behind as dust the payer
 * cannot recover (see the known residual in `contracts/README.md`), and withdrawing **less** is
 * refused with `CORDON_UNDERFUNDED` after the user has paid for the transaction.
 *
 * A comment warning about that would be worth very little. Instead the amount is written once, when
 * the authorisation is signed, and every builder here reads it back off that authorisation. There
 * is no second place to put a number, so the two cannot disagree. The same is true of the
 * settlement terms, the token, the gate and the pool: an `authorize*` call is the only place any of
 * them is stated, and the matching `build*Actions` call takes the result whole.
 *
 * ## Cairo enum encoding
 *
 * Cairo serialises an enum as its variant index followed by that variant's fields in declaration
 * order, and a struct as its fields in declaration order. Everything below follows from that: no
 * framing, no length prefix, no padding.
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
import type { GateContext } from "./context.js";
import { credentialCalldata, type Credential } from "./credential.js";
import {
  feltEquals,
  toAddress,
  toFelt,
  toU128Felt,
  toU64Felt,
  type Address,
  type Felt,
  type FeltLike,
} from "./felt.js";
import {
  DIRECT_TERMS_HASH,
  quotedSettlementHash,
  settlementTermsHash,
  subjectActionHash,
  type Leg,
} from "./hashing.js";
import { randomNonce, signHash, type Signature } from "./keys.js";
import {
  assertUnguessableSettlementId,
  randomSettlementId,
  type Settlement,
} from "./settlement.js";

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
 * A `Fund`'s action array is `withdraw → invoke`: there is no `transfer(OPEN)`, so there is no note
 * to fill and no note id to bind. Both the signature and the calldata carry zero, and the gate
 * refuses anything else with `CORDON_NOTE_ID_NOT_ZERO`.
 */
export const FUND_NOTE_ID: Felt = "0x0";

/**
 * A subject proving, in one value, both who they are and that they authorised this settlement.
 *
 * Mirrors the Cairo `SubjectAuthorization` field for field, `amount` included. The payer uses it on
 * `Direct` and `Fund`; the payee uses the identical shape on `Claim`.
 */
export interface SubjectAuthorization {
  /** The published policy to enforce against the credential. */
  policyId: Felt;
  /** The issuer-signed credential. */
  credential: Credential;
  /** The value this authorisation covers, in token base units. Authoritative. */
  amount: bigint;
  /** The subject's signature over the action hash. */
  signature: Signature;
  /** Subject-chosen, and single-use across every leg of the gate. */
  nonce: Felt;
}

/** What every signed leg records about itself. */
interface AuthorizationBase {
  /** The chain, gate and pool this signature is bound to. */
  context: GateContext;
  /** The ERC20 being settled. */
  token: Address;
  /** The value the gate will move. */
  amount: bigint;
  /** The note id the signature covers. Zero on a `Fund`. */
  noteId: Felt;
  /** The action hash that was signed, for debugging a refusal. */
  actionHash: Felt;
  /** The terms hash inside the action hash. Zero on a `Direct`. */
  termsHash: Felt;
}

/** A signed `Direct` payment, and everything it committed to. */
export interface DirectAuthorization extends AuthorizationBase {
  leg: "Direct";
  /** The payer's authorisation, as the contract takes it. */
  payer: SubjectAuthorization;
}

/** A signed `Fund`, and the settlement terms the payer agreed to. */
export interface FundAuthorization extends AuthorizationBase {
  leg: "Fund";
  payer: SubjectAuthorization;
  /** The escrow's handle. Random, and the payee needs it to claim. */
  settlementId: Felt;
  /** The pseudonym allowed to claim. */
  payeeSubjectKey: Felt;
  /** The policy that payee must satisfy. */
  payeeClaimPolicyId: Felt;
  /** When the claim window closes, in unix seconds. */
  expiresAt: number;
}

/** A signed `Claim`, made by the payee the payer named. */
export interface ClaimAuthorization extends AuthorizationBase {
  leg: "Claim";
  settlementId: Felt;
  /** The payee's credential. Its subject key must be the one the payer named. */
  credential: Credential;
  signature: Signature;
  nonce: Felt;
}

/** A signed `Refund`, made by the payer who funded the settlement. */
export interface RefundAuthorization extends AuthorizationBase {
  leg: "Refund";
  settlementId: Felt;
  signature: Signature;
  nonce: Felt;
}

export type GateAuthorization =
  | DirectAuthorization
  | FundAuthorization
  | ClaimAuthorization
  | RefundAuthorization;

/** Thrown when an authorisation is asked to contradict itself. */
export class OperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationError";
  }
}

/**
 * Sign a `Direct` payment.
 *
 * The `amount` given here is the amount the withdraw action will withdraw and the amount the gate
 * will settle — {@link buildDirectActions} reads it back off the result, so there is nowhere for a
 * second, different number to come from.
 *
 * `noteId` is the **resolved** id of the open note the pool will fill, not the
 * `"${openNoteIds[0]}"` placeholder. The wallet substitutes the placeholder in the calldata, but
 * the gate hashes what it actually received, so the subject has to sign the resolved value.
 */
export function authorizeDirect(
  params: {
    context: GateContext;
    token: Address;
    policyId: FeltLike;
    credential: Credential;
    amount: FeltLike;
    noteId: FeltLike;
    /** Defaults to a fresh 128-bit random nonce. */
    nonce?: FeltLike;
  },
  subjectPrivateKey: FeltLike,
): DirectAuthorization {
  const shared = normalise(params, "Direct");
  const actionHash = subjectActionHash({
    chainId: params.context.chainId,
    gateAddress: params.context.gate,
    poolAddress: params.context.pool,
    leg: "Direct",
    policyId: shared.policyId,
    noteId: shared.noteId,
    token: shared.token,
    amount: shared.amount,
    nonce: shared.nonce,
    termsHash: DIRECT_TERMS_HASH,
  });

  return {
    leg: "Direct",
    context: params.context,
    token: shared.token,
    amount: shared.amount,
    noteId: shared.noteId,
    termsHash: DIRECT_TERMS_HASH,
    actionHash,
    payer: {
      policyId: shared.policyId,
      credential: params.credential,
      amount: shared.amount,
      signature: signHash(actionHash, subjectPrivateKey),
      nonce: shared.nonce,
    },
  };
}

/**
 * Sign a `Fund`: park value with the gate for one named payee under one claim policy.
 *
 * The settlement id is generated here, from the platform CSPRNG, and returned on the result. That
 * is not a convenience. Funding is permissionless and an id is single-use forever, so a
 * predictable id can be burned ahead of you by a stranger — and it is the only handle in the event
 * log, so a guessable one also ties the funding to the claim to whatever business record it came
 * from. Supplying your own is possible and is checked for entropy; supplying an invoice number is
 * refused.
 *
 * Every term is inside the payer's signature. {@link buildFundActions} takes this whole result, so
 * the terms that were signed and the terms that are sent are the same values.
 */
export function authorizeFund(
  params: {
    context: GateContext;
    token: Address;
    policyId: FeltLike;
    credential: Credential;
    amount: FeltLike;
    /** The pseudonym allowed to claim. The payee's credential must name this exact key. */
    payeeSubjectKey: FeltLike;
    /** The policy that payee will be judged against. Its cap must fit `amount`. */
    payeeClaimPolicyId: FeltLike;
    /** When the claim window closes, in unix seconds. */
    expiresAt: FeltLike;
    /** Defaults to {@link randomSettlementId}. A guessable value is refused. */
    settlementId?: FeltLike;
    /** Defaults to a fresh 128-bit random nonce. */
    nonce?: FeltLike;
  },
  subjectPrivateKey: FeltLike,
): FundAuthorization {
  const shared = normalise({ ...params, noteId: FUND_NOTE_ID }, "Fund");

  const payeeSubjectKey = toFelt(params.payeeSubjectKey);
  if (feltEquals(payeeSubjectKey, 0)) {
    throw new OperationError(
      "a Fund needs a payee: a settlement with no named payee could be taken by anyone the claim " +
        "policy accepts, and the gate refuses it with CORDON_ZERO_PAYEE",
    );
  }

  const settlementId =
    params.settlementId === undefined
      ? randomSettlementId()
      : assertUnguessableSettlementId(params.settlementId);
  const expiresAt = Number(BigInt(toU64Felt(params.expiresAt, "expiresAt")));
  const payeeClaimPolicyId = toFelt(params.payeeClaimPolicyId);

  const termsHash = settlementTermsHash({
    settlementId,
    payeeSubjectKey,
    payeeClaimPolicyId,
    expiresAt,
  });

  const actionHash = subjectActionHash({
    chainId: params.context.chainId,
    gateAddress: params.context.gate,
    poolAddress: params.context.pool,
    leg: "Fund",
    policyId: shared.policyId,
    noteId: FUND_NOTE_ID,
    token: shared.token,
    amount: shared.amount,
    nonce: shared.nonce,
    termsHash,
  });

  return {
    leg: "Fund",
    context: params.context,
    token: shared.token,
    amount: shared.amount,
    noteId: FUND_NOTE_ID,
    termsHash,
    actionHash,
    settlementId,
    payeeSubjectKey,
    payeeClaimPolicyId,
    expiresAt,
    payer: {
      policyId: shared.policyId,
      credential: params.credential,
      amount: shared.amount,
      signature: signHash(actionHash, subjectPrivateKey),
      nonce: shared.nonce,
    },
  };
}

/**
 * Sign a `Claim`: the named payee takes a funded settlement.
 *
 * Takes the `Settlement` as read from `PolicyGate::get_settlement`, not loose fields. The amount
 * and the claim policy come from that record, which is where the gate takes them from too, so a
 * claim cannot be signed for the wrong amount or judged against the wrong policy.
 */
export function authorizeClaim(
  params: {
    context: GateContext;
    /** The settlement being claimed, read from the gate. */
    settlement: Settlement;
    settlementId: FeltLike;
    /** The payee's credential. Its subject key must match the settlement's named payee. */
    credential: Credential;
    /** The resolved id of the open note the payee is filling. */
    noteId: FeltLike;
    nonce?: FeltLike;
  },
  subjectPrivateKey: FeltLike,
): ClaimAuthorization {
  const { settlement } = params;
  if (!feltEquals(params.credential.subjectPublicKey, settlement.payeeSubjectKey)) {
    throw new OperationError(
      `this credential names subject ${params.credential.subjectPublicKey}, but the settlement is ` +
        `payable only to ${settlement.payeeSubjectKey}. The gate refuses anyone else with ` +
        "CORDON_NOT_THE_PAYEE.",
    );
  }

  const settlementId = toFelt(params.settlementId);
  const termsHash = quotedSettlementHash(settlementId);
  const noteId = toFelt(params.noteId);
  const nonce = params.nonce === undefined ? randomNonce() : toFelt(params.nonce);

  const actionHash = subjectActionHash({
    chainId: params.context.chainId,
    gateAddress: params.context.gate,
    poolAddress: params.context.pool,
    leg: "Claim",
    policyId: settlement.payeeClaimPolicyId,
    noteId,
    token: settlement.token,
    amount: settlement.amount,
    nonce,
    termsHash,
  });

  return {
    leg: "Claim",
    context: params.context,
    token: settlement.token,
    amount: settlement.amount,
    noteId,
    termsHash,
    actionHash,
    settlementId,
    credential: params.credential,
    signature: signHash(actionHash, subjectPrivateKey),
    nonce,
  };
}

/**
 * Sign a `Refund`: the payer takes back a settlement the window closed on.
 *
 * Like a claim, this reads the amount and the policy off the stored settlement — a refund is judged
 * against the policy the payer satisfied when funding, which the payer has no other way to know for
 * certain.
 */
export function authorizeRefund(
  params: {
    context: GateContext;
    settlement: Settlement;
    settlementId: FeltLike;
    /** The resolved id of the open note the payer is filling. */
    noteId: FeltLike;
    nonce?: FeltLike;
  },
  subjectPrivateKey: FeltLike,
): RefundAuthorization {
  const { settlement } = params;
  const settlementId = toFelt(params.settlementId);
  const termsHash = quotedSettlementHash(settlementId);
  const noteId = toFelt(params.noteId);
  const nonce = params.nonce === undefined ? randomNonce() : toFelt(params.nonce);

  const actionHash = subjectActionHash({
    chainId: params.context.chainId,
    gateAddress: params.context.gate,
    poolAddress: params.context.pool,
    leg: "Refund",
    policyId: settlement.payerPolicyId,
    noteId,
    token: settlement.token,
    amount: settlement.amount,
    nonce,
    termsHash,
  });

  return {
    leg: "Refund",
    context: params.context,
    token: settlement.token,
    amount: settlement.amount,
    noteId,
    termsHash,
    actionHash,
    settlementId,
    signature: signHash(actionHash, subjectPrivateKey),
    nonce,
  };
}

function normalise(
  params: {
    context: GateContext;
    token: Address;
    policyId: FeltLike;
    amount: FeltLike;
    noteId: FeltLike;
    nonce?: FeltLike;
  },
  leg: Leg,
): { token: Address; policyId: Felt; amount: bigint; noteId: Felt; nonce: Felt } {
  const amount = BigInt(toU128Felt(params.amount, "amount"));
  if (amount === 0n) {
    throw new OperationError(
      `a ${leg} for zero moves nothing and is refused with CORDON_NO_VALUE`,
    );
  }
  return {
    token: toAddress(params.token, "token"),
    policyId: toFelt(params.policyId),
    amount,
    noteId: toFelt(params.noteId),
    nonce: params.nonce === undefined ? randomNonce() : toFelt(params.nonce),
  };
}

/**
 * A `SubjectAuthorization` as the twelve felts Cairo's positional `Serde` expects:
 * `[policy_id, …7 credential felts…, amount, sig_r, sig_s, nonce]`.
 */
export function encodeSubjectAuthorization(authorization: SubjectAuthorization): Felt[] {
  return [
    authorization.policyId,
    ...credentialCalldata(authorization.credential),
    toU128Felt(authorization.amount, "amount"),
    authorization.signature.r,
    authorization.signature.s,
    authorization.nonce,
  ];
}

/**
 * Encode the `GateOperation`: variant index first, then that variant's fields in declaration order.
 *
 * ```text
 * Direct(SubjectAuthorization)      -> [0, …12 authorisation felts…]
 * Fund  (payer, settlement_id, payee_subject_key, payee_claim_policy_id, expires_at)
 *                                   -> [1, …12…, settlement_id, payee_key, payee_policy, expires_at]
 * Claim (settlement_id, credential, sig_r, sig_s, nonce)
 *                                   -> [2, settlement_id, …7…, r, s, nonce]
 * Refund(settlement_id, sig_r, sig_s, nonce)
 *                                   -> [3, settlement_id, r, s, nonce]
 * ```
 */
export function encodeGateOperation(authorization: GateAuthorization): Felt[] {
  switch (authorization.leg) {
    case "Direct":
      return [
        toFelt(GATE_OPERATION_VARIANT.Direct),
        ...encodeSubjectAuthorization(authorization.payer),
      ];
    case "Fund":
      return [
        toFelt(GATE_OPERATION_VARIANT.Fund),
        ...encodeSubjectAuthorization(authorization.payer),
        authorization.settlementId,
        authorization.payeeSubjectKey,
        authorization.payeeClaimPolicyId,
        toU64Felt(authorization.expiresAt, "expiresAt"),
      ];
    case "Claim":
      return [
        toFelt(GATE_OPERATION_VARIANT.Claim),
        authorization.settlementId,
        ...credentialCalldata(authorization.credential),
        authorization.signature.r,
        authorization.signature.s,
        authorization.nonce,
      ];
    case "Refund":
      return [
        toFelt(GATE_OPERATION_VARIANT.Refund),
        authorization.settlementId,
        authorization.signature.r,
        authorization.signature.s,
        authorization.nonce,
      ];
  }
}

/** Overrides for calling the gate outside a wallet-assembled transaction, such as in a test. */
export interface CalldataOverrides {
  /** Replaces the `"${poolAddress}"` placeholder. */
  poolAddress?: string;
  /**
   * Replaces the `"${openNoteIds[0]}"` placeholder. Must equal the note id that was signed —
   * a different one is refused with `CORDON_BAD_SUBJECT_SIG`, so it is rejected here instead.
   */
  noteId?: string;
  /** Which open note the placeholder points at. Defaults to the first. */
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
export function encodeGateCalldata(
  authorization: GateAuthorization,
  overrides: CalldataOverrides = {},
): CalldataItem[] {
  const noteId = resolveNoteId(authorization, overrides);
  return [
    ...encodeGateOperation(authorization),
    authorization.token,
    calldataItem(overrides.poolAddress ?? POOL_ADDRESS_PLACEHOLDER),
    calldataItem(noteId),
  ];
}

function resolveNoteId(
  authorization: GateAuthorization,
  overrides: CalldataOverrides,
): string {
  if (authorization.leg === "Fund") {
    if (overrides.noteId !== undefined && !feltEquals(overrides.noteId, 0)) {
      throw new OperationError(
        "a Fund fills no open note, so its note id must be zero; the gate refuses anything else " +
          "with CORDON_NOTE_ID_NOT_ZERO",
      );
    }
    return FUND_NOTE_ID;
  }
  if (overrides.noteId === undefined) return openNoteIdPlaceholder(overrides.openNoteIndex ?? 0);
  if (!feltEquals(overrides.noteId, authorization.noteId)) {
    throw new OperationError(
      `this authorisation was signed for note ${authorization.noteId}, so sending it with note ` +
        `${overrides.noteId} would be refused with CORDON_BAD_SUBJECT_SIG`,
    );
  }
  return overrides.noteId;
}

/**
 * The full action array for a `Direct` settlement: `withdraw` → `transfer(OPEN)` → `invoke`.
 *
 * The withdraw amount is the amount inside the authorisation, so the value the pool moves and the
 * value the payer signed for are the same number by construction.
 */
export function buildDirectActions(params: {
  authorization: DirectAuthorization;
  /** The pool user the resulting open note is credited to. */
  payee: Address;
  /** Test-only; see {@link CalldataOverrides}. */
  overrides?: CalldataOverrides;
}): Strk20Action[] {
  const { authorization } = params;
  return [
    withdrawAction({
      token: authorization.token,
      amount: authorization.amount,
      recipient: authorization.context.gate,
    }),
    openNoteAction({ token: authorization.token, recipient: params.payee }),
    invokeAction({
      contract: authorization.context.gate,
      calldata: encodeGateCalldata(authorization, params.overrides ?? {}),
    }),
  ];
}

/**
 * The full action array for a `Fund`: `withdraw` → `invoke`.
 *
 * No open note, because nothing comes back in this transaction — the gate books a settlement, keeps
 * the value, and returns an empty deposit span.
 */
export function buildFundActions(params: {
  authorization: FundAuthorization;
  /** Test-only; see {@link CalldataOverrides}. */
  overrides?: CalldataOverrides;
}): Strk20Action[] {
  const { authorization } = params;
  return [
    withdrawAction({
      token: authorization.token,
      amount: authorization.amount,
      recipient: authorization.context.gate,
    }),
    invokeAction({
      contract: authorization.context.gate,
      calldata: encodeGateCalldata(authorization, params.overrides ?? {}),
    }),
  ];
}

/**
 * The full action array for a `Claim`: `transfer(OPEN, self)` → `invoke`.
 *
 * There is deliberately **no withdraw**. The value has been sitting at the gate since the `Fund`,
 * and the payee funds nothing; a withdraw here would push value into the gate that no leg pays out,
 * where it becomes dust.
 */
export function buildClaimActions(params: {
  authorization: ClaimAuthorization;
  /** Who the claimed note is credited to — the payee themselves. */
  recipient: Address;
  /** Test-only; see {@link CalldataOverrides}. */
  overrides?: CalldataOverrides;
}): Strk20Action[] {
  const { authorization } = params;
  return [
    openNoteAction({ token: authorization.token, recipient: params.recipient }),
    invokeAction({
      contract: authorization.context.gate,
      calldata: encodeGateCalldata(authorization, params.overrides ?? {}),
    }),
  ];
}

/** The full action array for a `Refund`: `transfer(OPEN, self)` → `invoke`, back to the payer. */
export function buildRefundActions(params: {
  authorization: RefundAuthorization;
  /** Who the refunded note is credited to — the original payer. */
  recipient: Address;
  /** Test-only; see {@link CalldataOverrides}. */
  overrides?: CalldataOverrides;
}): Strk20Action[] {
  const { authorization } = params;
  return [
    openNoteAction({ token: authorization.token, recipient: params.recipient }),
    invokeAction({
      contract: authorization.context.gate,
      calldata: encodeGateCalldata(authorization, params.overrides ?? {}),
    }),
  ];
}

/**
 * Build the action array for any signed leg.
 *
 * `payee` (for a `Direct`) or `recipient` (for a `Claim` or `Refund`) says who the resulting open
 * note is credited to; a `Fund` creates no note and needs neither.
 */
export type BuildActionsParams =
  | { authorization: DirectAuthorization; payee: Address; overrides?: CalldataOverrides }
  | { authorization: FundAuthorization; overrides?: CalldataOverrides }
  | { authorization: ClaimAuthorization; recipient: Address; overrides?: CalldataOverrides }
  | { authorization: RefundAuthorization; recipient: Address; overrides?: CalldataOverrides };

export function buildActions(params: BuildActionsParams): Strk20Action[] {
  switch (params.authorization.leg) {
    case "Direct":
      return buildDirectActions(params as Parameters<typeof buildDirectActions>[0]);
    case "Fund":
      return buildFundActions(params as Parameters<typeof buildFundActions>[0]);
    case "Claim":
      return buildClaimActions(params as Parameters<typeof buildClaimActions>[0]);
    case "Refund":
      return buildRefundActions(params as Parameters<typeof buildRefundActions>[0]);
  }
}
