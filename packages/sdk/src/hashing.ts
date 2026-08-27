/**
 * The hash preimages Cordon verifies signatures against.
 *
 * These reproduce `contracts/src/hashing.cairo` field for field. They are a public contract, not
 * an implementation detail: if this file and the Cairo file disagree by one element or one byte of
 * a domain tag, every signature produced here is refused on chain as `CORDON_BAD_CRED` or
 * `CORDON_BAD_SUBJECT_SIG`, and the revert says nothing about why.
 *
 * `test/conformance.test.ts` asserts the fixture vectors pinned in
 * `contracts/src/tests/test_hashing.cairo` against this implementation. Run it before you sign
 * anything for real.
 */

import { hash, num } from "starknet";
import {
  toAddress,
  toFelt,
  toU128Felt,
  toU64Felt,
  type Address,
  type Felt,
  type FeltLike,
} from "./felt.js";

/**
 * Domain-separation tags. Template: `CORDON_<PURPOSE>:V<VERSION>`.
 *
 * The tag is the first element of every preimage, and it is what stops one hash being replayed as
 * another — a subject may hold one key used in several roles. A change to a field list means a new
 * tag, never a silent reinterpretation of signatures already in circulation.
 */
export const DOMAIN_TAGS = {
  /** Issuer-signed attestation. */
  credential: "CORDON_CREDENTIAL:V1",
  /** Subject-signed authorisation of one leg at one gate. */
  subjectAction: "CORDON_SUBJECT_ACTION:V4",
  /** The settlement terms nested inside an action hash. */
  settlementTerms: "CORDON_SETTLEMENT_TERMS:V1",
  /** Seed for deriving a subject key from a wallet signature. Never verified on chain. */
  subjectKeyDerivation: "CORDON_SUBJECT_KEY:V1",
} as const;

/** `'CORDON_CREDENTIAL:V1'` as a felt. */
export const CREDENTIAL_TAG: Felt = toFelt(DOMAIN_TAGS.credential);
/** `'CORDON_SUBJECT_ACTION:V4'` as a felt. */
export const SUBJECT_ACTION_TAG: Felt = toFelt(DOMAIN_TAGS.subjectAction);
/** `'CORDON_SETTLEMENT_TERMS:V1'` as a felt. */
export const SETTLEMENT_TERMS_TAG: Felt = toFelt(DOMAIN_TAGS.settlementTerms);

/**
 * `CORDON_NOTE_ANY` — the sentinel meaning "I could not know which note this fills".
 *
 * Signing it gives up the one thing that makes a leaked authorisation worthless to a thief. Prefer
 * the prepare-twice flow, which learns the real note id; reach for this only through
 * `acceptAnyNoteAndAllowRedirection`, which is named that way on purpose.
 */
export const NOTE_ANY: Felt = toFelt("CORDON_NOTE_ANY");

/**
 * How far ahead an unbound authorisation's deadline may sit, in seconds.
 *
 * Mirrors `MAX_UNBOUND_WINDOW` in `policy_gate.cairo`. Beyond this the gate refuses with
 * `CORDON_WINDOW_TOO_LONG`.
 */
export const MAX_UNBOUND_WINDOW_SECONDS = 600;

/** The four legs of `privacy_invoke`, as the names this SDK uses for them. */
export type Leg = "Direct" | "Fund" | "Claim" | "Refund";

/**
 * Leg tags — which `GateOperation` an authorisation is for, inside the signed message.
 *
 * Short strings rather than the enum's discriminant, on purpose: a discriminant is a position, and
 * positions move when someone adds a variant. A tag means the same thing forever and is legible in
 * a raw calldata dump.
 */
export const LEG_TAGS: Readonly<Record<Leg, Felt>> = {
  Direct: toFelt("CORDON_LEG_DIRECT"),
  Fund: toFelt("CORDON_LEG_FUND"),
  Claim: toFelt("CORDON_LEG_CLAIM"),
  Refund: toFelt("CORDON_LEG_REFUND"),
};

/**
 * The terms hash a `Direct` leg carries: a literal zero.
 *
 * A `Direct` payment has no settlement, so there are no terms to bind. Note that this is **not**
 * `settlementTermsHash` of four zeros — that is a large non-zero felt, and using it here produces
 * a signature the gate refuses with `CORDON_BAD_SUBJECT_SIG` and no further explanation.
 */
export const DIRECT_TERMS_HASH: Felt = "0x0";

/** The fields an issuer's signature covers. */
export interface CredentialHashInput {
  /** The issuer, as registered in the `IssuerRegistry`. Conventionally a short string. */
  issuerId: FeltLike;
  /** Issuer-scoped identifier, the handle revocation uses. */
  credentialId: FeltLike;
  /** The subject's pseudonymous STARK-curve public key. Never a wallet address. */
  subjectPublicKey: FeltLike;
  /** The attested claim, matched against `Policy.required_claim`. */
  claim: FeltLike;
  /** Unix seconds after which the credential is worthless. */
  expiresAt: FeltLike;
}

/** The terms of a settlement, as the nested hash binds them. */
export interface SettlementTermsHashInput {
  /** The settlement id. Must be random — see `randomSettlementId`. */
  settlementId: FeltLike;
  /** The pseudonym allowed to claim. Zero on `Claim` and `Refund`. */
  payeeSubjectKey: FeltLike;
  /** The policy the payee must satisfy. Zero on `Claim` and `Refund`. */
  payeeClaimPolicyId: FeltLike;
  /** When the claim window closes. Zero on `Claim` and `Refund`. */
  expiresAt: FeltLike;
}

/**
 * The fields a subject's signature covers.
 *
 * One preimage serves all four legs, and what each leg puts in it differs:
 *
 * | Leg | Signer | `policyId` | `noteBinding` | `amount` | `termsHash` |
 * | --- | --- | --- | --- | --- | --- |
 * | `Direct` | payer | the payer policy | the resolved note id, or `NOTE_ANY` | what the pool withdrew | `0` |
 * | `Fund` | payer | the payer policy | `0` — no note exists, and `NOTE_ANY` is refused | what the pool withdrew | all four terms |
 * | `Claim` | payee | the settlement's `payeeClaimPolicyId` | the payee's resolved note id, or `NOTE_ANY` | the settlement's amount | the id, rest zero |
 * | `Refund` | payer | the settlement's `payerPolicyId` | the payer's resolved note id, or `NOTE_ANY` | the settlement's amount | the id, rest zero |
 *
 * Two fields here exist because earlier versions got this wrong, and both are worth knowing about.
 *
 * The **leg** is in the message because `:V2` left it out and justified that with the shared nonce
 * registry. The registry stops a *second* use of a signature; it says nothing about the first use
 * being the wrong one. A payer who signed a `Direct` payment into their own note had also — one
 * nonce, one entirely legitimate use — authorised a `Fund` parking that money in an escrow whose
 * terms were chosen by whoever assembled the transaction.
 *
 * The **note binding** is in the message because dropping it is not safe either. A reverted
 * transaction is included on Starknet with its full calldata, and a revert does not burn the nonce
 * — so a claim that fails for any ordinary reason (the window closed, an over-velocity refusal,
 * too little shielded balance for the pool's fee) publishes a still-valid authorisation to the
 * whole chain. Without a destination in the message, anyone could resubmit it into a note of their
 * own, and the credential, the signature and the payee key would all still check out.
 */
export interface SubjectActionHashInput {
  /** The chain this will execute on. Read it from the provider, never from a config default. */
  chainId: FeltLike;
  /** The `PolicyGate` that will verify this signature. */
  gateAddress: Address;
  /** The privacy pool that will pull the value. Must equal `PolicyGate::privacy_pool()`. */
  poolAddress: Address;
  /** Which leg this authorises. */
  leg: Leg;
  /** The published rule set this authorisation is judged against. */
  policyId: FeltLike;
  /**
   * Where this payment is allowed to land: the resolved open note id, or {@link NOTE_ANY}.
   *
   * A `Fund` fills no note and always binds `0`.
   */
  noteBinding: FeltLike;
  /**
   * Unix seconds after which this authorisation is dead. `0` means no deadline, which the gate
   * allows only when `noteBinding` names a note.
   */
  validUntil: FeltLike;
  /** The ERC20 being settled. */
  token: Address;
  /**
   * The exact value the gate will move.
   *
   * Authoritative: the gate takes the amount from the signed authorisation and consults its own
   * balance only to check it can cover it. It never derives an amount from `balance_of`, because
   * `balance_of` is a permissionlessly writable global — a stranger could otherwise inflate,
   * deflate or block a payment the subject had already signed.
   */
  amount: FeltLike;
  /** Subject-chosen, and single-use across every leg of the gate. */
  nonce: FeltLike;
  /** {@link DIRECT_TERMS_HASH} on `Direct`; otherwise a {@link settlementTermsHash}. */
  termsHash: FeltLike;
}

/**
 * The exact felt list an issuer's signature covers, tag first.
 *
 * Exposed because seeing the preimage is how you debug a signature mismatch: print this next to
 * the Cairo side's span and the disagreeing element is obvious.
 *
 * ```text
 * ['CORDON_CREDENTIAL:V1', issuer_id, credential_id, subject_public_key, claim, expires_at]
 * ```
 */
export function credentialPreimage(input: CredentialHashInput): Felt[] {
  return [
    CREDENTIAL_TAG,
    toFelt(input.issuerId),
    toFelt(input.credentialId),
    toFelt(input.subjectPublicKey),
    toFelt(input.claim),
    toU64Felt(input.expiresAt, "expiresAt"),
  ];
}

/**
 * The message an issuer signs to attest a credential.
 *
 * The signature fields of a credential are deliberately outside the preimage — they are the
 * signature over it. Every asserted field is inside it, so no one can swap the claim, the subject
 * or the expiry underneath an issuer's signature.
 *
 * Still `:V1`, deliberately. It binds no chain and no verifier: a credential is a portable
 * statement about a subject, true at every gate that trusts the same issuer, on every network.
 * Scoping a credential to a use is the policy's job. An action authorisation is the opposite kind
 * of statement, which is why that one is bound to everything it can be.
 */
export function credentialHash(input: CredentialHashInput): Felt {
  return poseidon(credentialPreimage(input));
}

/**
 * The exact felt list the nested settlement-terms hash covers.
 *
 * ```text
 * ['CORDON_SETTLEMENT_TERMS:V1', settlement_id, payee_subject_key, payee_claim_policy_id, expires_at]
 * ```
 */
export function settlementTermsPreimage(input: SettlementTermsHashInput): Felt[] {
  return [
    SETTLEMENT_TERMS_TAG,
    toFelt(input.settlementId),
    toFelt(input.payeeSubjectKey),
    toFelt(input.payeeClaimPolicyId),
    toU64Felt(input.expiresAt, "expiresAt"),
  ];
}

/**
 * The terms of a settlement, hashed for nesting inside an action hash.
 *
 * It carries its own domain tag even though it is only ever nested, so its digest can never be
 * mistaken for a hash of some other four-felt structure.
 *
 * `Fund` fills every field: the payer is agreeing to all of them. `Claim` and `Refund` fill only
 * the id and zero the rest — use {@link quotedSettlementHash} for those. `Direct` has no
 * settlement and uses {@link DIRECT_TERMS_HASH}, a literal zero.
 */
export function settlementTermsHash(input: SettlementTermsHashInput): Felt {
  return poseidon(settlementTermsPreimage(input));
}

/**
 * The terms hash a `Claim` or `Refund` carries: the settlement id, and nothing else to choose.
 *
 * Binding the id is what stops one claim signature being valid for any open settlement that
 * happens to share a claim policy, a token and an amount.
 */
export function quotedSettlementHash(settlementId: FeltLike): Felt {
  return settlementTermsHash({
    settlementId,
    payeeSubjectKey: 0,
    payeeClaimPolicyId: 0,
    expiresAt: 0,
  });
}

/**
 * The exact felt list a subject's signature covers, tag first.
 *
 * ```text
 * ['CORDON_SUBJECT_ACTION:V4', chain_id, gate_address, pool_address, leg,
 *  policy_id, note_binding, valid_until, token, amount, nonce, terms_hash]
 * ```
 */
export function subjectActionPreimage(input: SubjectActionHashInput): Felt[] {
  const leg = LEG_TAGS[input.leg];
  if (leg === undefined) {
    throw new TypeError(
      `unknown leg ${JSON.stringify(input.leg)}; expected one of ${Object.keys(LEG_TAGS).join(", ")}`,
    );
  }
  return [
    SUBJECT_ACTION_TAG,
    toFelt(input.chainId),
    toAddress(input.gateAddress, "gateAddress"),
    toAddress(input.poolAddress, "poolAddress"),
    leg,
    toFelt(input.policyId),
    toFelt(input.noteBinding),
    toU64Felt(input.validUntil, "validUntil"),
    toAddress(input.token, "token"),
    toU128Felt(input.amount, "amount"),
    toFelt(input.nonce),
    toFelt(input.termsHash),
  ];
}

/**
 * The message a subject signs to authorise one specific leg, at one specific gate.
 *
 * Twelve elements. Holding a credential is not the same as authorising a payment: the credential
 * says who the subject is, this says that this subject wants this value moved, on this leg, under
 * this policy, at this contract, through this pool, into this note, once.
 */
export function subjectActionHash(input: SubjectActionHashInput): Felt {
  return poseidon(subjectActionPreimage(input));
}

/**
 * `poseidon_hash_span` over a flat span of felts — the Starknet Poseidon sponge, byte for byte
 * what `core::poseidon::poseidon_hash_span` computes.
 */
export function poseidon(elements: readonly FeltLike[]): Felt {
  return num.toHex(hash.computePoseidonHashOnElements(elements.map((element) => toFelt(element))));
}
