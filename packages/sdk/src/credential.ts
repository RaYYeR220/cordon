/**
 * The credential: what an issuer says about a subject, and everything you can do with it off
 * chain.
 *
 * A Cordon credential is deliberately small and self-contained — six asserted felts and a
 * signature. It carries no name, no address and no document; the subject is a public key the
 * holder generated locally. That is what lets it travel through a URL or a QR code without leaking
 * anything, and what makes local validation possible without calling a server.
 */

import { decodeBase64Url, encodeBase64Url } from "./base64url.js";
import {
  U64_MAX,
  feltEquals,
  feltToShortString,
  padFelt,
  toBigInt,
  toFelt,
  type Felt,
  type FeltLike,
} from "./felt.js";
import { credentialHash } from "./hashing.js";
import { signHash, verifyHash, type Signature } from "./keys.js";
import { refusalForCode, type Refusal } from "./refusals.js";

/** An issuer-signed attestation about a pseudonymous subject. Mirrors the Cairo `Credential`. */
export interface Credential {
  /** The issuer that signed this, as registered in the `IssuerRegistry`. */
  issuerId: Felt;
  /** Issuer-scoped identifier. The handle revocation uses. */
  credentialId: Felt;
  /** The subject's pseudonymous STARK-curve public key. Never a wallet address. */
  subjectPublicKey: Felt;
  /** The attested claim, matched against a policy's `required_claim`. */
  claim: Felt;
  /** Unix seconds after which the credential is worthless. */
  expiresAt: number;
  /** The issuer's STARK-curve signature over {@link credentialHash}. */
  signature: Signature;
}

/** The same fields, in whatever form a caller has them. */
export interface CredentialInput {
  issuerId: FeltLike;
  credentialId: FeltLike;
  subjectPublicKey: FeltLike;
  claim: FeltLike;
  expiresAt: FeltLike;
  signature: { r: FeltLike; s: FeltLike };
}

/** Thrown when a credential is structurally invalid — malformed, not merely unacceptable. */
export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

/** Normalise a credential's fields into canonical felts. */
export function createCredential(input: CredentialInput): Credential {
  const expiresAt = toBigInt(input.expiresAt);
  if (expiresAt > U64_MAX) throw new CredentialError(`expiresAt does not fit in a u64: ${expiresAt}`);
  if (expiresAt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CredentialError(`expiresAt is beyond any real timestamp: ${expiresAt}`);
  }
  return {
    issuerId: toFelt(input.issuerId),
    credentialId: toFelt(input.credentialId),
    subjectPublicKey: toFelt(input.subjectPublicKey),
    claim: toFelt(input.claim),
    expiresAt: Number(expiresAt),
    signature: { r: toFelt(input.signature.r), s: toFelt(input.signature.s) },
  };
}

/** Attest a credential: hash the fields and sign them with an issuer key. */
export function issueCredential(
  fields: Omit<CredentialInput, "signature">,
  issuerPrivateKey: FeltLike,
): Credential {
  const signature = signHash(credentialHash(fields), issuerPrivateKey);
  return createCredential({ ...fields, signature });
}

/**
 * The credential as the seven felts Cairo's positional `Serde` expects.
 *
 * Order is the wire format. It matches the `Credential` struct declaration in
 * `contracts/src/types.cairo`, signature fields last.
 */
export function credentialCalldata(credential: Credential): Felt[] {
  return [
    credential.issuerId,
    credential.credentialId,
    credential.subjectPublicKey,
    credential.claim,
    toFelt(credential.expiresAt),
    credential.signature.r,
    credential.signature.s,
  ];
}

/** Read a credential back out of the seven felts a contract call or an event carried. */
export function credentialFromCalldata(calldata: readonly FeltLike[]): Credential {
  if (calldata.length !== 7) {
    throw new CredentialError(`a credential is 7 felts, got ${calldata.length}`);
  }
  const [issuerId, credentialId, subjectPublicKey, claim, expiresAt, r, s] = calldata as [
    FeltLike,
    FeltLike,
    FeltLike,
    FeltLike,
    FeltLike,
    FeltLike,
    FeltLike,
  ];
  return createCredential({
    issuerId,
    credentialId,
    subjectPublicKey,
    claim,
    expiresAt,
    signature: { r, s },
  });
}

/** The JSON shape a credential is stored and transported in. All felts are 0x hex. */
export interface CredentialJson {
  issuerId: string;
  credentialId: string;
  subjectPublicKey: string;
  claim: string;
  expiresAt: number;
  signature: { r: string; s: string };
}

/** A credential as plain JSON, ready for `JSON.stringify`. */
export function credentialToJson(credential: Credential): CredentialJson {
  return {
    issuerId: credential.issuerId,
    credentialId: credential.credentialId,
    subjectPublicKey: credential.subjectPublicKey,
    claim: credential.claim,
    expiresAt: credential.expiresAt,
    signature: { r: credential.signature.r, s: credential.signature.s },
  };
}

/** Parse a credential from JSON (or from an already-parsed object), validating its shape. */
export function credentialFromJson(value: unknown): Credential {
  const source = typeof value === "string" ? safeParse(value) : value;
  if (typeof source !== "object" || source === null) {
    throw new CredentialError("a credential must be a JSON object");
  }
  const record = source as Record<string, unknown>;
  const signature = record["signature"];
  if (typeof signature !== "object" || signature === null) {
    throw new CredentialError("credential.signature is missing");
  }
  const sig = signature as Record<string, unknown>;
  for (const field of ["issuerId", "credentialId", "subjectPublicKey", "claim", "expiresAt"]) {
    if (record[field] === undefined) throw new CredentialError(`credential.${field} is missing`);
  }
  if (sig["r"] === undefined || sig["s"] === undefined) {
    throw new CredentialError("credential.signature needs both r and s");
  }
  return createCredential({
    issuerId: record["issuerId"] as FeltLike,
    credentialId: record["credentialId"] as FeltLike,
    subjectPublicKey: record["subjectPublicKey"] as FeltLike,
    claim: record["claim"] as FeltLike,
    expiresAt: record["expiresAt"] as FeltLike,
    signature: { r: sig["r"] as FeltLike, s: sig["s"] as FeltLike },
  });
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new CredentialError(`credential is not valid JSON: ${(cause as Error).message}`);
  }
}

/**
 * The compact wire format version. Byte 0 of every encoded credential.
 *
 * A reader that meets an unknown version says so instead of misreading the bytes that follow.
 */
export const CREDENTIAL_ENCODING_VERSION = 1;

/** Length in bytes of a v1 encoded credential: `1 + 4×32 + 8 + 2×32`. */
const ENCODED_LENGTH = 201;

/**
 * Encode a credential as a compact base64url string, short enough for a URL or a QR code.
 *
 * The layout is fixed-width, so it is the same 268 characters for every credential and nothing
 * about the contents can be inferred from the length:
 *
 * | Offset | Bytes | Field |
 * | --- | --- | --- |
 * | 0 | 1 | version |
 * | 1 | 32 | `issuerId` |
 * | 33 | 32 | `credentialId` |
 * | 65 | 32 | `subjectPublicKey` |
 * | 97 | 32 | `claim` |
 * | 129 | 8 | `expiresAt`, big-endian u64 |
 * | 137 | 32 | `signature.r` |
 * | 169 | 32 | `signature.s` |
 *
 * JSON is the better choice when a human has to read it; this is for when a machine has to carry
 * it. {@link decodeCredential} reverses it exactly.
 */
export function encodeCredential(credential: Credential): string {
  const bytes = new Uint8Array(ENCODED_LENGTH);
  bytes[0] = CREDENTIAL_ENCODING_VERSION;
  writeFelt(bytes, 1, credential.issuerId);
  writeFelt(bytes, 33, credential.credentialId);
  writeFelt(bytes, 65, credential.subjectPublicKey);
  writeFelt(bytes, 97, credential.claim);
  writeU64(bytes, 129, credential.expiresAt);
  writeFelt(bytes, 137, credential.signature.r);
  writeFelt(bytes, 169, credential.signature.s);
  return encodeBase64Url(bytes);
}

/** Decode a credential produced by {@link encodeCredential}. */
export function decodeCredential(encoded: string): Credential {
  const bytes = decodeBase64Url(stripPrefix(encoded));
  if (bytes.length !== ENCODED_LENGTH) {
    throw new CredentialError(
      `an encoded credential is ${ENCODED_LENGTH} bytes, got ${bytes.length}`,
    );
  }
  const version = bytes[0];
  if (version !== CREDENTIAL_ENCODING_VERSION) {
    throw new CredentialError(
      `unsupported credential encoding version ${version}; this SDK reads version ` +
        `${CREDENTIAL_ENCODING_VERSION}`,
    );
  }
  return createCredential({
    issuerId: readFelt(bytes, 1),
    credentialId: readFelt(bytes, 33),
    subjectPublicKey: readFelt(bytes, 65),
    claim: readFelt(bytes, 97),
    expiresAt: readU64(bytes, 129),
    signature: { r: readFelt(bytes, 137), s: readFelt(bytes, 169) },
  });
}

/** The URI scheme a Cordon credential travels under. */
export const CREDENTIAL_URI_SCHEME = "cordon-credential:";

/**
 * A `cordon-credential:` URI, which is what a QR code should contain.
 *
 * A bare {@link encodeCredential} string is fine inside your own app; the scheme is what lets a
 * scanner hand it to the right place.
 */
export function credentialUri(credential: Credential): string {
  return `${CREDENTIAL_URI_SCHEME}${encodeCredential(credential)}`;
}

function stripPrefix(encoded: string): string {
  const text = encoded.trim();
  if (text.startsWith(CREDENTIAL_URI_SCHEME)) return text.slice(CREDENTIAL_URI_SCHEME.length);
  // Also accept a full link with the credential in a `#c=` fragment or a `?c=` query.
  const match = /[#?&]c=([A-Za-z0-9\-_]+)/.exec(text);
  return match?.[1] ?? text;
}

function writeFelt(bytes: Uint8Array, offset: number, value: Felt): void {
  const hex = padFelt(value);
  for (let index = 0; index < 32; index += 1) {
    bytes[offset + index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
}

function readFelt(bytes: Uint8Array, offset: number): Felt {
  let hex = "";
  for (let index = 0; index < 32; index += 1) {
    hex += (bytes[offset + index] as number).toString(16).padStart(2, "0");
  }
  return toFelt(`0x${hex}`);
}

function writeU64(bytes: Uint8Array, offset: number, value: number): void {
  let remaining = BigInt(value);
  for (let index = 7; index >= 0; index -= 1) {
    bytes[offset + index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}

function readU64(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value = (value << 8n) | BigInt(bytes[offset + index] as number);
  }
  return value;
}

/** What to check a credential against locally. Everything is optional; each field adds a check. */
export interface CredentialCheckOptions {
  /** Unix seconds to judge expiry against. Defaults to now. */
  now?: number;
  /** The issuer's registered public key. Without it the signature cannot be checked. */
  issuerPublicKey?: FeltLike;
  /** Refuse credentials from any other issuer, the way a policy that pins one does. */
  expectedIssuerId?: FeltLike;
  /** Refuse a credential that does not attest this claim. */
  requiredClaim?: FeltLike;
  /** Credential ids this issuer has revoked, if you have read them from the chain. */
  revokedCredentialIds?: readonly FeltLike[];
  /** Refuse a credential that is not about this subject. */
  expectedSubjectPublicKey?: FeltLike;
}

/** The verdict of {@link validateCredential}. */
export interface CredentialCheck {
  /** True only if every check that could be run passed. */
  valid: boolean;
  /**
   * The refusals this credential would hit, named with the same panic codes the gate raises — so
   * a UI can say "this would be refused as CORDON_EXPIRED" before anyone pays for a transaction.
   */
  refusals: Refusal[];
  /** Checks skipped because the option they need was not supplied. */
  skipped: string[];
  /** Seconds until expiry; negative once expired. */
  secondsUntilExpiry: number;
}

/**
 * Check a credential the way the gate would, as far as is possible off chain.
 *
 * This is a pre-flight, not a substitute for the chain: only the gate can see the live issuer
 * registry, the revocation registry and the block timestamp. What it does buy you is that the
 * failures it reports carry the same panic codes as the on-chain ones, so a user is told the
 * actual rule before they pay for a transaction that would revert.
 */
export function validateCredential(
  credential: Credential,
  options: CredentialCheckOptions = {},
): CredentialCheck {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const refusals: Refusal[] = [];
  const skipped: string[] = [];
  const refuse = (code: string): void => {
    const refusal = refusalForCode(code);
    if (refusal) refusals.push(refusal);
  };

  if (options.expectedIssuerId !== undefined) {
    if (!feltEquals(credential.issuerId, options.expectedIssuerId)) refuse("CORDON_BAD_ISSUER");
  } else {
    skipped.push("issuer pinning (no expectedIssuerId given)");
  }

  if (options.issuerPublicKey !== undefined) {
    const ok = verifyHash(
      credentialHash({
        issuerId: credential.issuerId,
        credentialId: credential.credentialId,
        subjectPublicKey: credential.subjectPublicKey,
        claim: credential.claim,
        expiresAt: credential.expiresAt,
      }),
      options.issuerPublicKey,
      credential.signature,
    );
    if (!ok) refuse("CORDON_BAD_CRED");
  } else {
    skipped.push("issuer signature (no issuerPublicKey given)");
  }

  if (credential.expiresAt <= now) refuse("CORDON_EXPIRED");

  if (options.revokedCredentialIds !== undefined) {
    const revoked = options.revokedCredentialIds.some((id) =>
      feltEquals(id, credential.credentialId),
    );
    if (revoked) refuse("CORDON_REVOKED");
  } else {
    skipped.push("revocation (no revokedCredentialIds given)");
  }

  if (options.requiredClaim !== undefined) {
    if (!feltEquals(credential.claim, options.requiredClaim)) refuse("CORDON_CLAIM_MISMATCH");
  } else {
    skipped.push("claim match (no requiredClaim given)");
  }

  if (
    options.expectedSubjectPublicKey !== undefined &&
    !feltEquals(credential.subjectPublicKey, options.expectedSubjectPublicKey)
  ) {
    refuse("CORDON_BAD_SUBJECT_SIG");
  }

  return {
    valid: refusals.length === 0,
    refusals,
    skipped,
    secondsUntilExpiry: credential.expiresAt - now,
  };
}

/** A credential rendered for a human: short strings decoded, expiry as a date. */
export interface CredentialSummary {
  issuer: string;
  credentialId: string;
  claim: string;
  subject: string;
  expiresAt: string;
  expired: boolean;
}

/** Decode the readable parts of a credential for display. */
export function summarizeCredential(
  credential: Credential,
  now = Math.floor(Date.now() / 1000),
): CredentialSummary {
  return {
    issuer: feltToShortString(credential.issuerId) ?? credential.issuerId,
    credentialId: feltToShortString(credential.credentialId) ?? credential.credentialId,
    claim: feltToShortString(credential.claim) ?? credential.claim,
    subject: credential.subjectPublicKey,
    expiresAt: new Date(credential.expiresAt * 1000).toISOString(),
    expired: credential.expiresAt <= now,
  };
}
