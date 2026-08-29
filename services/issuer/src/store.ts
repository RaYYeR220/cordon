/**
 * What the issuer remembers: every credential it signed, every screening it ran, every revocation.
 *
 * A JSON file, written atomically. An issuer that cannot say what it attested and on what evidence
 * is not an issuer, it is a signing oracle — so the screening that justified each credential is
 * stored alongside it, including the screenings that ended in a refusal. The refusals are the more
 * interesting half of the record.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CredentialJson } from "@cordon/sdk";
import type { Screening } from "./ofac/screening.js";

/**
 * What an operator asserted, when this service had no source of its own.
 *
 * Present on exactly the credentials nothing was screened for, which is what keeps the register
 * readable: a record carries either a `screening` or an `attestation`, never both and never
 * neither, so "what was this credential worth" has one answer you can point at.
 */
export interface Attestation {
  /** Always this, so a reader never has to infer it from the absence of a screening. */
  evidence: "operator-attestation";
  /** What the operator was relying on, in their own words. */
  basis: string;
  /** ISO 8601. */
  at: string;
}

/** One issued credential and the evidence behind it. */
export interface IssuedRecord {
  /** The credential id, as a felt. Unique per issuer. */
  credentialId: string;
  /** The claim asserted, as a readable short string. */
  claim: string;
  /** The credential itself, ready to hand back to the subject. */
  credential: CredentialJson;
  /** The public Starknet address that was screened, or null when nothing was screened. */
  screenedAddress: string | null;
  /** The screening that justified issuing, or null for an operator attestation. */
  screening: Screening | null;
  /** The operator's assertion, or null when the service checked a source itself. */
  attestation: Attestation | null;
  /** ISO 8601. */
  issuedAt: string;
  /** ISO 8601, set when the issuer withdraws the credential. */
  revokedAt: string | null;
  /** Why it was revoked, as recorded by the operator. */
  revocationReason: string | null;
}

/** A screening that did not produce a credential. Kept, because a refusal is a record too. */
export interface RefusalRecord {
  /** ISO 8601. */
  at: string;
  /** The address that was screened. */
  address: string;
  /** The subject pseudonym the request was for. */
  subjectPublicKey: string;
  /** The screening outcome: `match` or `unavailable`. */
  screening: Screening;
}

interface StoreShape {
  version: 1;
  issued: IssuedRecord[];
  refusals: RefusalRecord[];
}

const EMPTY: StoreShape = { version: 1, issued: [], refusals: [] };

/** The issuer's records, persisted to one JSON file. */
export class Store {
  #path: string;
  #state: StoreShape = { ...EMPTY, issued: [], refusals: [] };
  #writing: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  /** Load from disk. A missing file is an empty store, not an error. */
  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8")) as StoreShape;
      this.#state = {
        version: 1,
        issued: Array.isArray(parsed.issued) ? parsed.issued : [],
        refusals: Array.isArray(parsed.refusals) ? parsed.refusals : [],
      };
    } catch {
      this.#state = { version: 1, issued: [], refusals: [] };
    }
  }

  /** Every credential issued, newest first. */
  list(): IssuedRecord[] {
    return [...this.#state.issued].reverse();
  }

  /** Every refusal recorded, newest first. */
  refusals(): RefusalRecord[] {
    return [...this.#state.refusals].reverse();
  }

  /** One credential by id, or `undefined`. */
  find(credentialId: string): IssuedRecord | undefined {
    return this.#state.issued.find((record) => record.credentialId === credentialId);
  }

  /** Record an issuance. */
  async add(record: IssuedRecord): Promise<void> {
    this.#state.issued.push(record);
    await this.#persist();
  }

  /** Record a refusal. */
  async addRefusal(record: RefusalRecord): Promise<void> {
    this.#state.refusals.push(record);
    await this.#persist();
  }

  /**
   * Mark a credential revoked.
   *
   * This is the issuer's own record. Revocation only bites on chain once it is written to the
   * `RevocationRegistry`, and the response says so rather than implying the credential is already
   * dead everywhere.
   */
  async revoke(credentialId: string, reason: string, at: string): Promise<IssuedRecord | null> {
    const record = this.find(credentialId);
    if (!record || record.revokedAt !== null) return null;
    record.revokedAt = at;
    record.revocationReason = reason;
    await this.#persist();
    return record;
  }

  async #persist(): Promise<void> {
    // Serialise writes so two requests cannot interleave a read-modify-write of the same file.
    this.#writing = this.#writing.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      const temporary = `${this.#path}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(this.#state, null, 2), "utf8");
      await rename(temporary, this.#path);
    });
    await this.#writing;
  }
}
