/**
 * Subject and issuer keys: generation, derivation, signing and verification.
 *
 * Two kinds of key exist in Cordon and they are never the same key:
 *
 * - an **issuer key**, held by an attestation service, registered in the `IssuerRegistry`, and
 *   used to sign credentials;
 * - a **subject key**, generated locally by a user, whose public half is the pseudonym the chain
 *   sees. It is not a wallet key and must never be a wallet key: nonce replay protection and
 *   velocity accounting are keyed by it, so binding it to an address would undo the privacy the
 *   pool provides.
 *
 * Signing and verification are STARK-curve ECDSA, matching `core::ecdsa::check_ecdsa_signature`.
 */

import { ec, typedData as snTypedData, type TypedData } from "starknet";
import { padFelt, toFelt, type Felt, type FeltLike } from "./felt.js";
import {
  DOMAIN_TAGS,
  credentialHash,
  poseidon,
  subjectActionHash,
  type CredentialHashInput,
  type SubjectActionHashInput,
} from "./hashing.js";

/** A STARK-curve ECDSA signature, as the two felts a Cairo contract takes. */
export interface Signature {
  r: Felt;
  s: Felt;
}

/** A subject's pseudonym and the secret behind it. */
export interface SubjectKeypair {
  /**
   * The secret. Never send it anywhere: it is not recoverable from the public key, and anyone
   * holding it can authorise settlements against the subject's credentials and caps.
   */
  privateKey: Felt;
  /**
   * The pseudonym. This is the `subject_public_key` inside a credential and the only identifier
   * the chain ever sees — the x-coordinate of the STARK-curve public key.
   */
  publicKey: Felt;
}

/** Thrown when a key or a signature is malformed. */
export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}

/**
 * Generate a fresh subject keypair from the platform CSPRNG.
 *
 * Works in a browser (`crypto.getRandomValues`) and in Node. The result is a pseudonym with no
 * link to any wallet; back it up, or use {@link deriveSubjectKeypair} so it can be regenerated
 * from the wallet instead of stored.
 */
export function generateSubjectKeypair(): SubjectKeypair {
  const privateKey = bytesToFelt(ec.starkCurve.utils.randomPrivateKey());
  return { privateKey, publicKey: subjectPublicKey(privateKey) };
}

/** The pseudonym (public key x-coordinate) behind a private key. */
export function subjectPublicKey(privateKey: FeltLike): Felt {
  return toFelt(ec.starkCurve.getStarkKey(toFelt(privateKey)));
}

/**
 * The SNIP-12 message a wallet signs to derive a subject key.
 *
 * Signing this in the wallet and feeding the result to {@link deriveSubjectKeypair} regenerates
 * the same pseudonym on any device, so a user never has to store a secret. The message names what
 * it is for, so a wallet that shows the payload shows a user something meaningful.
 *
 * @param chainId - e.g. `SN_MAIN`. Different chains derive different keys on purpose.
 * @param context - a label that separates one pseudonym from another under the same wallet, so a
 *   user can hold, say, a personal and a treasury identity without linking them.
 */
export function subjectKeyTypedData(params: { chainId: string; context?: string }): TypedData {
  return {
    types: {
      StarknetDomain: [
        { name: "name", type: "shortstring" },
        { name: "version", type: "shortstring" },
        { name: "chainId", type: "shortstring" },
        { name: "revision", type: "shortstring" },
      ],
      CordonSubjectKey: [
        { name: "purpose", type: "shortstring" },
        { name: "context", type: "shortstring" },
      ],
    },
    primaryType: "CordonSubjectKey",
    domain: { name: "Cordon", version: "1", chainId: params.chainId, revision: "1" },
    message: { purpose: "subject key derivation", context: params.context ?? "default" },
  };
}

/**
 * The hash of {@link subjectKeyTypedData}, for wallets that want the digest rather than the
 * structure.
 */
export function subjectKeyMessageHash(params: {
  chainId: string;
  accountAddress: string;
  context?: string;
}): Felt {
  const data = subjectKeyTypedData(
    params.context === undefined
      ? { chainId: params.chainId }
      : { chainId: params.chainId, context: params.context },
  );
  return toFelt(snTypedData.getMessageHash(data, params.accountAddress));
}

/**
 * Rebuild a subject keypair from a wallet signature over {@link subjectKeyTypedData}.
 *
 * This is how a user regenerates their pseudonym on a new device with nothing but their wallet.
 * The signature is hashed under its own domain tag and ground into a valid STARK-curve scalar, so
 * the wallet signature itself never becomes a private key.
 *
 * **It is only as reproducible as the wallet's signer.** Every starknet.js-based signer is
 * deterministic (RFC 6979), which is what makes this work. If a wallet signs with fresh randomness
 * each time, the derived key changes with it — use {@link generateSubjectKeypair} and back the key
 * up instead. Check by deriving twice and comparing the public keys before you rely on it.
 */
export function deriveSubjectKeypair(params: {
  /** The signature the wallet returned, as felts. Both `[r, s]` and longer arrays are accepted. */
  signature: readonly FeltLike[];
  /** Must match the `context` passed to {@link subjectKeyTypedData}. */
  context?: string;
}): SubjectKeypair {
  if (params.signature.length === 0) {
    throw new KeyError("cannot derive a subject key from an empty signature");
  }
  const seed = poseidon([
    DOMAIN_TAGS.subjectKeyDerivation,
    toFelt(params.context ?? "default"),
    ...params.signature,
  ]);
  const privateKey = toFelt(`0x${ec.starkCurve.grindKey(seed)}`);
  return { privateKey, publicKey: subjectPublicKey(privateKey) };
}

/**
 * Sign a message hash with the STARK curve.
 *
 * Deterministic (RFC 6979): the same hash and key always produce the same signature.
 */
export function signHash(messageHash: FeltLike, privateKey: FeltLike): Signature {
  const signature = ec.starkCurve.sign(toFelt(messageHash), toFelt(privateKey));
  return { r: toFelt(signature.r), s: toFelt(signature.s) };
}

/**
 * Verify a STARK-curve signature against a public key x-coordinate.
 *
 * The gate stores only the x-coordinate, and `check_ecdsa_signature` accepts a signature valid
 * under either y for that x. Both are tried here so this function answers exactly what the
 * contract would answer, rather than being stricter than the chain and rejecting signatures that
 * would in fact settle.
 */
export function verifyHash(
  messageHash: FeltLike,
  publicKey: FeltLike,
  signature: Signature,
): boolean {
  let sig: InstanceType<typeof ec.starkCurve.Signature>;
  try {
    sig = new ec.starkCurve.Signature(BigInt(toFelt(signature.r)), BigInt(toFelt(signature.s)));
  } catch {
    return false;
  }
  const x = padFelt(publicKey);
  const message = toFelt(messageHash);
  for (const parity of ["02", "03"]) {
    try {
      if (ec.starkCurve.verify(sig, message, `${parity}${x}`)) return true;
    } catch {
      // A public key x with no point on the curve, or an out-of-range signature scalar. Neither
      // would verify on chain either, so keep going and answer false.
    }
  }
  return false;
}

/** Sign a credential with an issuer key. The result goes in the credential's `sig_r`/`sig_s`. */
export function signCredential(
  input: CredentialHashInput,
  issuerPrivateKey: FeltLike,
): Signature {
  return signHash(credentialHash(input), issuerPrivateKey);
}

/** Check an issuer's signature over a credential, exactly as step 5 of the gate does. */
export function verifyCredentialSignature(
  input: CredentialHashInput,
  issuerPublicKey: FeltLike,
  signature: Signature,
): boolean {
  return verifyHash(credentialHash(input), issuerPublicKey, signature);
}

/** Sign one settlement with the subject key behind `credential.subjectPublicKey`. */
export function signSubjectAction(
  input: SubjectActionHashInput,
  subjectPrivateKey: FeltLike,
): Signature {
  return signHash(subjectActionHash(input), subjectPrivateKey);
}

/** Check a subject's authorisation of a settlement, exactly as step 9 of the gate does. */
export function verifySubjectAction(
  input: SubjectActionHashInput,
  subjectPublicKeyValue: FeltLike,
  signature: Signature,
): boolean {
  return verifyHash(subjectActionHash(input), subjectPublicKeyValue, signature);
}

/**
 * A nonce with enough entropy that two settlements never collide.
 *
 * A nonce is a felt, consumed once per `(subject_public_key, nonce)`. Sixteen random bytes is far
 * beyond what a collision would need, and it leaks nothing about the subject.
 */
export function randomNonce(): Felt {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toFelt(`0x${hex(bytes)}`);
}

function bytesToFelt(bytes: Uint8Array): Felt {
  return toFelt(`0x${hex(bytes)}`);
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}
