/**
 * Screening an address against the snapshot.
 *
 * Three outcomes, and only three: `clear`, `match`, `unavailable`. There is deliberately no fourth
 * that means "we could not check, so probably fine". If the lists cannot be reached and the cached
 * snapshot is too old to trust, this answers `unavailable` and the issuer refuses to sign. A
 * checkmark that does not stand for a completed check is worse than no checkmark, because someone
 * downstream will rely on it.
 */

import type { ListedAddress } from "./parse.js";
import {
  fetchSnapshot,
  isStale,
  readCachedSnapshot,
  snapshotAgeSeconds,
  writeCachedSnapshot,
  OfacUnavailableError,
  type OfacSnapshot,
  type SourceRecord,
} from "./snapshot.js";

/** What a screening concluded. */
export type ScreeningStatus =
  /** The address does not appear on any list in the snapshot. */
  | "clear"
  /** The address is listed. The listings are attached. */
  | "match"
  /** No trustworthy snapshot. Nothing was concluded, and nothing may be issued. */
  | "unavailable";

/** Provenance for a screening: which files, fetched when, saying what. */
export interface ScreeningProvenance {
  /** When the snapshot was fetched, ISO 8601. */
  fetchedAt: string;
  /** How old it was when the screening ran. */
  ageSeconds: number;
  /** How many listed digital-currency addresses it contained. */
  addressCount: number;
  /** Which assets OFAC has filed addresses under, sorted. */
  assets: string[];
  /** One record per source file. */
  sources: SourceRecord[];
}

/** The record of one screening. Kept whatever the outcome. */
export interface Screening {
  status: ScreeningStatus;
  /** The address as it was supplied. */
  address: string;
  /** Every form of the address that was compared against the list. */
  comparedForms: string[];
  /** The listings that matched. Empty unless `status` is `match`. */
  matches: ListedAddress[];
  /** The snapshot the decision rests on, or `null` when there was none. */
  provenance: ScreeningProvenance | null;
  /** One line, safe to show a user. */
  reason: string;
  /** When the screening ran, ISO 8601. */
  checkedAt: string;
}

export interface ScreeningServiceOptions {
  sources: readonly string[];
  maxAgeSeconds: number;
  fetchTimeoutMs: number;
  cachePath: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests. Defaults to `Date`. */
  now?: () => Date;
}

/**
 * Holds the current snapshot and answers screening questions against it.
 *
 * The snapshot is refreshed lazily: a screening that finds the snapshot missing or stale tries to
 * fetch a fresh one first, and only then decides. That keeps "is this data fresh enough" and "is
 * this address listed" as one question with one answer, rather than two that can disagree.
 */
export class ScreeningService {
  #snapshot: OfacSnapshot | null = null;
  #index: Map<string, ListedAddress[]> = new Map();
  #lastFailure: OfacUnavailableError | null = null;
  #refreshing: Promise<OfacSnapshot> | null = null;
  readonly #options: ScreeningServiceOptions;

  constructor(options: ScreeningServiceOptions) {
    this.#options = options;
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }

  /**
   * Load a snapshot at startup: the cache if it is fresh, otherwise a fetch.
   *
   * Never throws. A service that cannot reach OFAC still starts, still serves its health endpoint,
   * and still refuses to issue — which is more useful than a service that will not start at all.
   */
  async initialise(): Promise<void> {
    const cached = await readCachedSnapshot(this.#options.cachePath);
    if (cached !== null) this.#adopt(cached);
    if (this.#needsRefresh()) {
      try {
        await this.refresh();
      } catch {
        // Recorded on `#lastFailure` and reported by `status()`. Not fatal to startup.
      }
    }
  }

  /** Fetch a fresh snapshot and cache it. Concurrent callers share one fetch. */
  async refresh(): Promise<OfacSnapshot> {
    this.#refreshing ??= this.#doRefresh().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async #doRefresh(): Promise<OfacSnapshot> {
    try {
      const snapshot = await fetchSnapshot({
        sources: this.#options.sources,
        timeoutMs: this.#options.fetchTimeoutMs,
        ...(this.#options.fetchImpl ? { fetchImpl: this.#options.fetchImpl } : {}),
      });
      this.#adopt(snapshot);
      this.#lastFailure = null;
      await writeCachedSnapshot(this.#options.cachePath, snapshot);
      return snapshot;
    } catch (error) {
      this.#lastFailure =
        error instanceof OfacUnavailableError
          ? error
          : new OfacUnavailableError(String(error), []);
      throw this.#lastFailure;
    }
  }

  #adopt(snapshot: OfacSnapshot): void {
    const index = new Map<string, ListedAddress[]>();
    for (const listing of snapshot.addresses) {
      const key = normalizeForComparison(listing.address);
      const bucket = index.get(key);
      if (bucket) bucket.push(listing);
      else index.set(key, [listing]);
    }
    this.#snapshot = snapshot;
    this.#index = index;
  }

  #needsRefresh(): boolean {
    return (
      this.#snapshot === null ||
      isStale(this.#snapshot, this.#options.maxAgeSeconds, this.#now())
    );
  }

  /** The snapshot currently held, fresh or not. */
  get snapshot(): OfacSnapshot | null {
    return this.#snapshot;
  }

  /** What the health endpoint reports. */
  status(): {
    available: boolean;
    stale: boolean;
    ageSeconds: number | null;
    maxAgeSeconds: number;
    fetchedAt: string | null;
    addressCount: number;
    assets: string[];
    sources: SourceRecord[];
    lastFailure: { message: string; attempts: { url: string; error: string }[] } | null;
  } {
    const snapshot = this.#snapshot;
    const stale = snapshot === null || isStale(snapshot, this.#options.maxAgeSeconds, this.#now());
    return {
      available: snapshot !== null && !stale,
      stale,
      ageSeconds: snapshot === null ? null : snapshotAgeSeconds(snapshot, this.#now()),
      maxAgeSeconds: this.#options.maxAgeSeconds,
      fetchedAt: snapshot?.fetchedAt ?? null,
      addressCount: snapshot?.addresses.length ?? 0,
      assets: listedAssets(snapshot),
      sources: snapshot?.sources ?? [],
      lastFailure: this.#lastFailure
        ? { message: this.#lastFailure.message, attempts: this.#lastFailure.attempts }
        : null,
    };
  }

  /**
   * Screen one address.
   *
   * Refreshes first if the snapshot is missing or stale. If that refresh fails, the answer is
   * `unavailable` — never `clear`.
   */
  async screen(address: string): Promise<Screening> {
    if (this.#needsRefresh()) {
      try {
        await this.refresh();
      } catch {
        // Falls through to the unavailable branch below.
      }
    }

    const checkedAt = this.#now().toISOString();
    const forms = comparisonForms(address);
    const snapshot = this.#snapshot;

    if (snapshot === null || isStale(snapshot, this.#options.maxAgeSeconds, this.#now())) {
      const detail = this.#lastFailure
        ? `${this.#lastFailure.message}: ${this.#lastFailure.attempts
            .map((attempt) => `${attempt.url} (${attempt.error})`)
            .join("; ")}`
        : snapshot === null
          ? "no sanctions snapshot has ever been fetched"
          : `the cached snapshot is ${snapshotAgeSeconds(snapshot, this.#now())}s old, past the ` +
            `${this.#options.maxAgeSeconds}s limit`;
      return {
        status: "unavailable",
        address,
        comparedForms: forms,
        matches: [],
        provenance: null,
        reason: `Sanctions screening is unavailable, so nothing was checked and nothing will be issued. ${detail}.`,
        checkedAt,
      };
    }

    const matches: ListedAddress[] = [];
    const seen = new Set<string>();
    for (const form of forms) {
      for (const listing of this.#index.get(form) ?? []) {
        const key = `${listing.entryUid}:${listing.idUid}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push(listing);
      }
    }

    const provenance: ScreeningProvenance = {
      fetchedAt: snapshot.fetchedAt,
      ageSeconds: snapshotAgeSeconds(snapshot, this.#now()),
      addressCount: snapshot.addresses.length,
      assets: listedAssets(snapshot),
      sources: snapshot.sources,
    };

    if (matches.length > 0) {
      const names = [...new Set(matches.map((listing) => listing.name))].join(", ");
      return {
        status: "match",
        address,
        comparedForms: forms,
        matches,
        provenance,
        reason: `Listed by OFAC under ${names}. No credential will be issued.`,
        checkedAt,
      };
    }

    return {
      status: "clear",
      address,
      comparedForms: forms,
      matches: [],
      provenance,
      reason:
        `Not present among the ${provenance.addressCount} digital-currency addresses in the OFAC ` +
        `snapshot published ${snapshot.sources[0]?.publishDate ?? "(unknown date)"}.`,
      checkedAt,
    };
  }
}

/** The assets OFAC has filed addresses under in a snapshot, sorted. */
export function listedAssets(snapshot: OfacSnapshot | null): string[] {
  if (snapshot === null) return [];
  return [...new Set(snapshot.addresses.map((listing) => listing.asset))].sort();
}

/**
 * One address, in every form it might have been listed under.
 *
 * OFAC records an address as the chain's own tooling prints it, and the same Starknet address is
 * written both padded to 64 hex digits and with its leading zeros trimmed. Comparing all the forms
 * is the difference between screening an address and screening one spelling of it.
 */
export function comparisonForms(address: string): string[] {
  const trimmed = address.trim();
  const forms = new Set<string>([normalizeForComparison(trimmed)]);

  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
    const digits = trimmed.slice(2).replace(/^0+/, "") || "0";
    forms.add(`0x${digits.toLowerCase()}`);
    if (digits.length <= 64) forms.add(`0x${digits.toLowerCase().padStart(64, "0")}`);
    // Some sources record the same value without the 0x prefix.
    forms.add(digits.toLowerCase());
  }

  return [...forms];
}

/**
 * The comparison key.
 *
 * Case is folded on both sides. For base58 chains that makes matching marginally broader than a
 * byte-for-byte comparison would be, and that is the safe direction: a screening that is too
 * eager refuses someone it should not, which is visible and appealable, while one that is too
 * narrow issues a clean credential to a listed address.
 */
export function normalizeForComparison(address: string): string {
  return address.trim().toLowerCase();
}
