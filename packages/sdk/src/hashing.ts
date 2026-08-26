/**
 * The two hash preimages Cordon verifies signatures against.
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
 * The tag is the first element of every preimage, and it is what stops a credential signature from
 * ever being replayed as an action signature — a subject may well hold one key used in both roles.
 * A change to a field list means a new tag, never a silent reinterpretation of signatures already
 * in circulation.
 */
export const DOMAIN_TAGS = {
  /** Issuer-signed attestation. */
  credential: "CORDON_CREDENTIAL:V1",
  /** Subject-signed authorisation of one settlement at one gate. */
  subjectAction: "CORDON_SUBJECT_ACTION:V2",
  /** Seed for deriving a subject key from a wallet signature. Never verified on chain. */
  subjectKeyDerivation: "CORDON_SUBJECT_KEY:V1",
} as const;

/** `'CORDON_CREDENTIAL:V1'` as a felt. */
export const CREDENTIAL_TAG: Felt = toFelt(DOMAIN_TAGS.credential);
/** `'CORDON_SUBJECT_ACTION:V2'` as a felt. */
export const SUBJECT_ACTION_TAG: Felt = toFelt(DOMAIN_TAGS.subjectAction);

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

/**
 * The fields a subject's signature covers.
 *
 * One preimage serves all four legs of `privacy_invoke`, and what each leg puts in it differs:
 *
 * | Leg | Signer | `policyId` | `noteId` | `amount` |
 * | --- | --- | --- | --- | --- |
 * | `Direct` | payer | the payer policy | the resolved `${openNoteIds[0]}` | what the pool sent |
 * | `Fund` | payer | the payer policy | `0` — no open note exists | what the pool sent |
 * | `Claim` | payee | the settlement's `payeeClaimPolicyId` | the payee's own note | the settlement's amount |
 * | `Refund` | payer | the settlement's `payerPolicyId` | the payer's own note | the settlement's amount |
 *
 * The leg itself is deliberately absent. It does not need to be there: every leg burns a nonce
 * against the signing subject's key from one registry shared across all of them, so a signature
 * carried from one leg to another replays its nonce and is refused with `CORDON_NONCE_USED`.
 */
export interface SubjectActionHashInput {
  /** The Starknet chain this settlement is for, e.g. `SN_MAIN`. */
  chainId: FeltLike;
  /** The `PolicyGate` that will verify this signature. */
  gateAddress: Address;
  /** The published rule set this authorisation is judged against. */
  policyId: FeltLike;
  /** The open note the pool will fill, or `0` on a `Fund`, which reserves none. */
  noteId: FeltLike;
  /** The ERC20 being settled. */
  token: Address;
  /** Value in the token's base units — the plaintext amount the gate is moving. */
  amount: FeltLike;
  /** Subject-chosen, and single-use across every leg of the gate. */
  nonce: FeltLike;
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
 * The hash binds no chain id and no verifier: a Cordon credential is a portable statement about a
 * subject, valid at any gate that trusts the same issuer registry. Scoping a credential to a use
 * is the policy's job.
 */
export function credentialHash(input: CredentialHashInput): Felt {
  return poseidon(credentialPreimage(input));
}

/**
 * The exact felt list a subject's signature covers, tag first.
 *
 * ```text
 * ['CORDON_SUBJECT_ACTION:V2', chain_id, gate_address, policy_id, note_id, token, amount, nonce]
 * ```
 */
export function subjectActionPreimage(input: SubjectActionHashInput): Felt[] {
  return [
    SUBJECT_ACTION_TAG,
    toFelt(input.chainId),
    toAddress(input.gateAddress, "gateAddress"),
    toFelt(input.policyId),
    toFelt(input.noteId),
    toAddress(input.token, "token"),
    toU128Felt(input.amount, "amount"),
    toFelt(input.nonce),
  ];
}

/**
 * The message a subject signs to authorise one specific settlement.
 *
 * Holding a credential is not the same as authorising a payment: the credential says who the
 * subject is, this signature says that *this* subject wants *this* value moved under *this* policy
 * at *this* gate, once.
 *
 * `amount` is the plaintext balance the pool hands the gate, so a relayer cannot inflate a
 * settlement past what the subject signed for. `nonce` is consumed per
 * `(subject_public_key, nonce)` and is what makes it once. Since `:V2` the chain id and the gate
 * address are inside the preimage too, so a signature cannot be carried to a second deployment
 * enforcing the same `policy_id`.
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
