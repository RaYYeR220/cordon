/**
 * Issuing: the one place a credential is signed, and the one place it is refused.
 *
 * The signing itself is `@cordon/sdk`'s — `issueCredential` hashes the fields with the same
 * Poseidon preimage the gate verifies against and signs it with the STARK curve. Reimplementing
 * that here would be the single most likely way to produce credentials the chain refuses with
 * `CORDON_BAD_CRED` and no explanation, so this file does not contain a hash function.
 *
 * What it does contain is the rule that a credential follows a completed screening and nothing
 * else.
 */

import {
  credentialToJson,
  feltToShortString,
  issueCredential,
  subjectPublicKey,
  toFelt,
  type Credential,
  type Felt,
} from "@cordon/sdk";
import { NOT_SANCTIONED, claimCatalogue, type ClaimSpec } from "./claims.js";
import type { Screening } from "./ofac/screening.js";

export { NOT_SANCTIONED };

/** A request to attest a subject. */
export interface IssueRequest {
  /** The subject's locally generated pseudonym. Never a wallet address. */
  subjectPublicKey: Felt;
  /** The public Starknet address to screen. Not part of the credential. */
  address: string;
  /** Issuer-scoped identifier for the credential. */
  credentialId: Felt;
  /** Unix seconds after which the credential is worthless. */
  expiresAt: number;
}

/** The result of an attempt to issue. */
export type IssueOutcome =
  | { issued: true; credential: Credential; screening: Screening }
  | { issued: false; status: 403 | 503; screening: Screening; reason: string };

/**
 * Screen, then sign — in that order, with no path that skips the screen.
 *
 * A `match` refuses with 403: the address is listed, and that is a decision. An `unavailable`
 * refuses with 503: nothing was decided, and the caller should retry rather than conclude
 * anything. The distinction matters to whoever is on the other end, so it is not flattened into
 * one error.
 */
export function issue(
  request: IssueRequest,
  screening: Screening,
  issuerId: Felt,
  issuerPrivateKey: Felt,
): IssueOutcome {
  if (screening.status === "unavailable") {
    return {
      issued: false,
      status: 503,
      screening,
      reason: screening.reason,
    };
  }
  if (screening.status === "match") {
    return {
      issued: false,
      status: 403,
      screening,
      reason: screening.reason,
    };
  }

  const credential = issueCredential(
    {
      issuerId,
      credentialId: request.credentialId,
      subjectPublicKey: request.subjectPublicKey,
      claim: NOT_SANCTIONED,
      expiresAt: request.expiresAt,
    },
    issuerPrivateKey,
  );

  return { issued: true, credential, screening };
}

/** A request to attest something this service has no source for. */
export interface AttestRequest {
  subjectPublicKey: Felt;
  credentialId: Felt;
  expiresAt: number;
  /** The claim, which must be one this deployment is configured to attest. */
  claim: string;
  /** What the operator is relying on. Recorded verbatim; an attestation without one is unauditable. */
  basis: string;
}

/**
 * Sign a claim on the operator's word.
 *
 * Deliberately a separate function from {@link issue}, and deliberately takes no `Screening`. The
 * two paths must not be able to drift into each other: nothing here can accidentally attach a
 * screening record to a credential that was never screened, and nothing in `issue` can sign a
 * claim it has no source for. The honesty of the register depends on that separation, not on a
 * caller remembering which fields to fill in.
 */
export function attest(
  request: AttestRequest,
  issuerId: Felt,
  issuerPrivateKey: Felt,
): Credential {
  return issueCredential(
    {
      issuerId,
      credentialId: request.credentialId,
      subjectPublicKey: request.subjectPublicKey,
      claim: request.claim,
      expiresAt: request.expiresAt,
    },
    issuerPrivateKey,
  );
}

/** The issuer's own public identity: what a registry operator needs to register it. */
export interface IssuerIdentity {
  /** The issuer id, as a felt. */
  issuerId: Felt;
  /** The issuer id decoded, when it is a short string. */
  issuerName: string | null;
  /** The public key `register_issuer` takes. The private half never leaves the process. */
  publicKey: Felt;
  /** Every claim this deployment will sign, and what stands behind each one. */
  claims: ClaimSpec[];
  /** The claim this issuer has a live source for, and can sign without anyone's word. */
  claim: string;
  /** Off-chain metadata: who runs it, what it screens, how to reach it. */
  metadataUri: string;
  /**
   * The address that will hold the operator role: the only one that may revoke this issuer's
   * credentials on chain, and the only one that may pass the role on.
   */
  operator: string;
  /** The four arguments `IssuerRegistry::register_issuer` takes, in order. */
  registerIssuer: {
    issuerId: string;
    publicKey: string;
    operator: string;
    metadataUri: string;
  };
}

/** Derive the issuer's public identity from its configuration. */
export function issuerIdentity(options: {
  issuerId: Felt;
  issuerPrivateKey: Felt;
  metadataUri: string;
  operator: string;
  attestedClaims?: readonly string[];
}): IssuerIdentity {
  const publicKey = subjectPublicKey(options.issuerPrivateKey);
  return {
    issuerId: options.issuerId,
    issuerName: feltToShortString(options.issuerId),
    publicKey,
    claims: claimCatalogue(options.attestedClaims ?? []),
    claim: NOT_SANCTIONED,
    metadataUri: options.metadataUri,
    operator: options.operator,
    registerIssuer: {
      issuerId: options.issuerId,
      publicKey,
      operator: options.operator,
      metadataUri: options.metadataUri,
    },
  };
}

/**
 * A credential id derived from the subject and the moment.
 *
 * Deterministic in its inputs so a caller can reproduce it, and unique per issuance so revoking
 * one credential does not revoke a subject's later ones. Callers may supply their own instead.
 */
export function defaultCredentialId(subject: Felt, issuedAtSeconds: number): Felt {
  const suffix = issuedAtSeconds.toString(36).toUpperCase();
  const stem = subject.replace(/^0x/, "").slice(0, 8).toUpperCase();
  return toFelt(`CRED_${stem}_${suffix}`);
}

/** The credential in the JSON shape the API returns. */
export function toJson(credential: Credential): ReturnType<typeof credentialToJson> {
  return credentialToJson(credential);
}
