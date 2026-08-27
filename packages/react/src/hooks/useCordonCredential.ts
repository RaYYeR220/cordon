"use client";

/**
 * `useCordonCredential` — hold a credential, and say honestly what the chain thinks of it.
 *
 * A credential is six asserted felts and an issuer signature. Three of the things that can be
 * wrong with it are local (the signature, the expiry, the claim) and two are on chain (whether the
 * issuer is still registered, and whether this credential id has been revoked). This hook does
 * both and keeps them apart: a credential whose revocation status could not be read is reported as
 * **unknown**, never as "not revoked". Revocation is exactly the check an attacker benefits from
 * you skipping.
 *
 * It also holds the subject keypair — the pseudonym the credential is about. By default the
 * private half is **not persisted**: it is derived from a wallet signature when it is needed, so
 * there is no long-lived secret in `localStorage` unless the integrator opts in.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  credentialFromJson,
  credentialToJson,
  decodeCredential,
  deriveSubjectKeypair,
  feltEquals,
  generateSubjectKeypair,
  refusalForCode,
  subjectKeyTypedData,
  summarizeCredential,
  validateCredential,
  type Credential,
  type CredentialCheck,
  type CredentialSummary,
  type Felt,
  type Refusal,
  type SubjectKeypair,
} from "@cordon/sdk";

import { useCordonContext } from "../context/CordonProvider.js";
import {
  readIssuerActive,
  readIssuerPublicKey,
  readRevoked,
  type Strk20NormalizedError,
} from "../strk20/index.js";

/** The credential's standing, in one word. */
export type CredentialStatus =
  /** Nothing loaded. */
  | "none"
  /** The chain reads that back the local checks are in flight. */
  | "checking"
  /** Every check that could be run passed. */
  | "valid"
  /** At least one rule would refuse it. `refusals` names them with the gate's own codes. */
  | "refused"
  /** A check could not be run, so the credential's standing is genuinely unknown. */
  | "unknown";

export interface UseCordonCredentialOptions {
  /** A credential supplied by the host app, instead of one loaded from storage. */
  credential?: Credential | null;
  /** Judge the claim against this policy's `requiredClaim`, when you know the policy. */
  requiredClaim?: Felt;
  /** Pin the issuer, the way a policy with a non-zero `issuerId` does. */
  expectedIssuerId?: Felt;
  /** Storage key suffix, so two flows in one app can hold different credentials. */
  slot?: string;
  /**
   * Persist the subject private key alongside the credential.
   *
   * Off by default, and it should stay off: the key can be re-derived from a wallet signature on
   * any device, so writing it to `localStorage` adds a stealable secret and buys a click.
   */
  persistSubjectKey?: boolean;
}

export interface UseCordonCredential {
  status: CredentialStatus;
  credential: Credential | null;
  /** Short strings decoded and the expiry as a date, for display. */
  summary: CredentialSummary | null;
  /** The full local verdict, including which checks were skipped and why. */
  check: CredentialCheck | null;
  /** Every rule that would refuse this credential, named with the gate's own panic codes. */
  refusals: Refusal[];
  /** Seconds until expiry; negative once expired. Null with no credential. */
  secondsUntilExpiry: number | null;
  expired: boolean;
  /** `true`, `false`, or `null` when the revocation registry could not be read. Never assumed. */
  revoked: boolean | null;
  /** `true`, `false`, or `null` when the issuer registry could not be read. */
  issuerActive: boolean | null;
  /** The issuer's registered attesting key, or null when it could not be read. */
  issuerPublicKey: Felt | null;
  /** Set when a chain read failed, so a UI can say what went wrong rather than guess. */
  error: Strk20NormalizedError | null;

  /** The subject pseudonym this session holds, or null until derived or generated. */
  subject: SubjectKeypair | null;
  /** True when the loaded credential is about the subject key we hold. */
  matchesSubject: boolean;
  /** Ask the connected wallet to sign the SNIP-12 message the pseudonym derives from. */
  deriveSubject: (context?: string) => Promise<SubjectKeypair | null>;
  /** Generate a fresh pseudonym from the platform CSPRNG. Back it up: it is not recoverable. */
  generateSubject: () => SubjectKeypair;
  setSubject: (keypair: SubjectKeypair | null) => void;

  /**
   * Load a credential from JSON, a compact base64url string, or a `cordon-credential:` URI.
   * Returns the credential, or null with `importError` set.
   */
  load: (text: string) => Credential | null;
  set: (credential: Credential | null) => void;
  clear: () => void;
  /** Why the last `load` failed, in the SDK's own words. Cleared by the next successful one. */
  importError: string | null;
  /** Re-read the issuer and revocation registries. */
  refresh: () => Promise<void>;
  checking: boolean;
}

function storageKey(gate: string, slot: string, part: string): string {
  return `cordon:${gate.toLowerCase()}:${slot}:${part}`;
}

export function useCordonCredential(
  options: UseCordonCredentialOptions = {},
): UseCordonCredential {
  const { config, storage, provider, registries, connection } = useCordonContext();
  const slot = options.slot ?? "default";
  const persistSubjectKey = options.persistSubjectKey ?? false;

  const [stored, setStored] = useState<Credential | null>(null);
  const [subject, setSubjectState] = useState<SubjectKeypair | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [issuerPublicKey, setIssuerPublicKey] = useState<Felt | null>(null);
  const [issuerActive, setIssuerActive] = useState<boolean | null>(null);
  const [revoked, setRevoked] = useState<boolean | null>(null);
  const [error, setError] = useState<Strk20NormalizedError | null>(null);
  const [checking, setChecking] = useState(false);

  const credential = options.credential !== undefined ? options.credential : stored;

  // Rehydrate from storage once, on the client only.
  useEffect(() => {
    if (!storage || options.credential !== undefined) return;
    const rawCredential = storage.getItem(storageKey(config.gateAddress, slot, "credential"));
    if (rawCredential) {
      try {
        setStored(credentialFromJson(rawCredential));
      } catch {
        // A stored credential we cannot parse is not a crash. Leave it and let the user load one.
      }
    }
    if (!persistSubjectKey) return;
    const rawKey = storage.getItem(storageKey(config.gateAddress, slot, "subject"));
    if (rawKey) {
      try {
        const parsed = JSON.parse(rawKey) as SubjectKeypair;
        if (parsed.privateKey && parsed.publicKey) setSubjectState(parsed);
      } catch {
        // Same: a malformed key is dropped rather than thrown.
      }
    }
  }, [storage, config.gateAddress, slot, persistSubjectKey, options.credential]);

  const persist = useCallback(
    (next: Credential | null): void => {
      if (!storage) return;
      const key = storageKey(config.gateAddress, slot, "credential");
      if (next) storage.setItem(key, JSON.stringify(credentialToJson(next)));
      else storage.removeItem(key);
    },
    [storage, config.gateAddress, slot],
  );

  const set = useCallback(
    (next: Credential | null): void => {
      setStored(next);
      setImportError(null);
      persist(next);
    },
    [persist],
  );

  const load = useCallback(
    (text: string): Credential | null => {
      const trimmed = text.trim();
      if (!trimmed) {
        setImportError("Nothing to load.");
        return null;
      }
      // JSON first, because that is what an issuer console hands a user; the compact encoding is
      // what a QR code carries. Both are reported by their own error when they fail.
      const errors: string[] = [];
      for (const parse of [credentialFromJson, decodeCredential]) {
        try {
          const parsed = parse(trimmed);
          set(parsed);
          return parsed;
        } catch (cause) {
          errors.push((cause as Error).message);
        }
      }
      setImportError(
        `This is not a Cordon credential. As JSON: ${errors[0]}. As an encoded string: ${errors[1]}.`,
      );
      return null;
    },
    [set],
  );

  const clear = useCallback((): void => {
    set(null);
    setIssuerPublicKey(null);
    setIssuerActive(null);
    setRevoked(null);
    setError(null);
  }, [set]);

  const setSubject = useCallback(
    (keypair: SubjectKeypair | null): void => {
      setSubjectState(keypair);
      if (!storage || !persistSubjectKey) return;
      const key = storageKey(config.gateAddress, slot, "subject");
      if (keypair) storage.setItem(key, JSON.stringify(keypair));
      else storage.removeItem(key);
    },
    [storage, persistSubjectKey, config.gateAddress, slot],
  );

  const generateSubject = useCallback((): SubjectKeypair => {
    const keypair = generateSubjectKeypair();
    setSubject(keypair);
    return keypair;
  }, [setSubject]);

  /**
   * Derive the pseudonym from a wallet signature.
   *
   * Only as reproducible as the wallet's signer. Every starknet.js-based signer is deterministic
   * (RFC 6979), which is what makes this work; a wallet that signs with fresh randomness would
   * hand back a different pseudonym each time, and the caller should compare two derivations
   * before relying on it.
   */
  const deriveSubject = useCallback(
    async (context?: string): Promise<SubjectKeypair | null> => {
      if (!connection) return null;
      try {
        const data = subjectKeyTypedData(
          context === undefined
            ? { chainId: config.chainId }
            : { chainId: config.chainId, context },
        );
        const signature = await connection.account.signMessage(data);
        const felts = Array.isArray(signature)
          ? signature.map(String)
          : [String((signature as { r: unknown }).r), String((signature as { s: unknown }).s)];
        const keypair = deriveSubjectKeypair(
          context === undefined ? { signature: felts } : { signature: felts, context },
        );
        setSubject(keypair);
        return keypair;
      } catch {
        // A declined signature is a decision, not a failure to report as an error state.
        return null;
      }
    },
    [connection, config.chainId, setSubject],
  );

  const registryAddresses = registries?.available ? registries.value : null;

  const refresh = useCallback(async (): Promise<void> => {
    if (!credential || !registryAddresses) return;
    setChecking(true);
    setError(null);
    try {
      const [key, active, isRevoked] = await Promise.all([
        readIssuerPublicKey(provider, registryAddresses.issuerRegistry, credential.issuerId),
        readIssuerActive(provider, registryAddresses.issuerRegistry, credential.issuerId),
        readRevoked(
          provider,
          registryAddresses.revocationRegistry,
          credential.issuerId,
          credential.credentialId,
        ),
      ]);
      // Each read stands alone. One that failed leaves its own field null and records the reason;
      // it does not poison the two that succeeded.
      setIssuerPublicKey(key.available ? key.value : null);
      setIssuerActive(active.available ? active.value : null);
      setRevoked(isRevoked.available ? isRevoked.value : null);
      const failure = [key, active, isRevoked].find((reading) => !reading.available);
      if (failure && !failure.available) setError(failure.error);
    } finally {
      setChecking(false);
    }
  }, [credential, registryAddresses, provider]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const check = useMemo<CredentialCheck | null>(() => {
    if (!credential) return null;
    return validateCredential(credential, {
      ...(issuerPublicKey !== null ? { issuerPublicKey } : {}),
      ...(revoked === true ? { revokedCredentialIds: [credential.credentialId] } : {}),
      ...(revoked === false ? { revokedCredentialIds: [] } : {}),
      ...(options.requiredClaim !== undefined ? { requiredClaim: options.requiredClaim } : {}),
      ...(options.expectedIssuerId !== undefined
        ? { expectedIssuerId: options.expectedIssuerId }
        : {}),
    });
  }, [credential, issuerPublicKey, revoked, options.requiredClaim, options.expectedIssuerId]);

  const refusals = useMemo<Refusal[]>(() => {
    const found = check?.refusals ? [...check.refusals] : [];
    // `is_issuer_active` answering false is a refusal the local check cannot see on its own: it
    // compares fields, and this one is a fact about the registry. The wording comes from the SDK's
    // decoder rather than from a copy kept here, so there is exactly one place a refusal is
    // described and nothing to drift out of step when a code is reworded.
    if (issuerActive === false && !found.some((refusal) => refusal.code === "CORDON_BAD_ISSUER")) {
      const badIssuer = refusalForCode("CORDON_BAD_ISSUER");
      if (badIssuer) found.unshift(badIssuer);
    }
    return found;
  }, [check, issuerActive]);

  const status = useMemo<CredentialStatus>(() => {
    if (!credential) return "none";
    if (checking) return "checking";
    if (refusals.length > 0) return "refused";
    // A skipped check is not a passed check. Revocation unread means the standing is unknown.
    if (revoked === null || issuerActive === null || issuerPublicKey === null) return "unknown";
    return "valid";
  }, [credential, checking, refusals, revoked, issuerActive, issuerPublicKey]);

  return {
    status,
    credential,
    summary: credential ? summarizeCredential(credential) : null,
    check,
    refusals,
    secondsUntilExpiry: check?.secondsUntilExpiry ?? null,
    expired: check ? check.secondsUntilExpiry <= 0 : false,
    revoked,
    issuerActive,
    issuerPublicKey,
    error,
    subject,
    matchesSubject:
      credential !== null &&
      subject !== null &&
      feltEquals(credential.subjectPublicKey, subject.publicKey),
    deriveSubject,
    generateSubject,
    setSubject,
    load,
    set,
    clear,
    importError,
    refresh,
    checking,
  };
}

export type { CredentialSummary, SubjectKeypair };
