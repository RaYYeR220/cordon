/**
 * The OFAC snapshot: fetch it, cache it, know how old it is, and refuse when it is not there.
 *
 * The service's whole claim is that a `NOT_SANCTIONED` credential means somebody actually looked.
 * That claim survives exactly as long as this module refuses to invent an answer. There is no
 * default-clean path in here: if the sources cannot be reached and no fresh cached snapshot
 * exists, screening is `unavailable` and the issuer refuses to sign.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseOfacList, type ListedAddress } from "./parse.js";

/** One source file, and what came back from it. */
export interface SourceRecord {
  /** The URL as configured. */
  url: string;
  /**
   * Where it actually resolved to; `treasury.gov` redirects to the sanctions list service, which
   * redirects again to object storage. The query string is stripped: it carries a short-lived
   * signed token that has no business being written to a cache file or served from an endpoint.
   */
  resolvedUrl: string;
  /** When this source was fetched, ISO 8601. */
  fetchedAt: string;
  /** OFAC's own publication date for the file. */
  publishDate: string | null;
  /** OFAC's own record count. */
  recordCount: number | null;
  /** `<sdnEntry>` elements seen. */
  entryCount: number;
  /** Digital-currency addresses found. */
  addressCount: number;
  /** Bytes downloaded. */
  bytes: number;
}

/** Everything the service knows about the sanctions lists at one moment. */
export interface OfacSnapshot {
  /** When the fetch completed, ISO 8601. This is the age a health check reports. */
  fetchedAt: string;
  /** One record per source, in the order they were fetched. */
  sources: SourceRecord[];
  /** Every listed digital-currency address, with its listing context. */
  addresses: ListedAddress[];
}

/** Thrown when a snapshot cannot be produced. Never swallowed into a "clean" answer. */
export class OfacUnavailableError extends Error {
  /** What was tried, and what each attempt said. */
  readonly attempts: { url: string; error: string }[];

  constructor(message: string, attempts: { url: string; error: string }[]) {
    super(message);
    this.name = "OfacUnavailableError";
    this.attempts = attempts;
  }
}

/** Fetch every source and build a snapshot. Throws {@link OfacUnavailableError} if any fails. */
export async function fetchSnapshot(options: {
  sources: readonly string[];
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<OfacSnapshot> {
  const doFetch = options.fetchImpl ?? fetch;
  const sources: SourceRecord[] = [];
  const addresses: ListedAddress[] = [];
  const attempts: { url: string; error: string }[] = [];

  for (const url of options.sources) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      let body: string;
      let resolvedUrl: string;
      try {
        const response = await doFetch(url, {
          signal: controller.signal,
          redirect: "follow",
          headers: { accept: "application/xml, text/xml, */*" },
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        resolvedUrl = stripQuery(response.url || url);
        body = await response.text();
      } finally {
        clearTimeout(timer);
      }

      const parsed = parseOfacList(body);
      sources.push({
        url,
        resolvedUrl,
        fetchedAt: new Date().toISOString(),
        publishDate: parsed.publishDate,
        recordCount: parsed.recordCount,
        entryCount: parsed.entryCount,
        addressCount: parsed.addresses.length,
        bytes: body.length,
      });
      addresses.push(...parsed.addresses);
    } catch (error) {
      attempts.push({ url, error: describe(error) });
    }
  }

  // Every source has to land. A partial snapshot is a screening with a hole in it, and a hole in a
  // sanctions screen is indistinguishable from a pass.
  if (attempts.length > 0) {
    throw new OfacUnavailableError(
      `could not fetch ${attempts.length} of ${options.sources.length} OFAC sources`,
      attempts,
    );
  }

  return { fetchedAt: new Date().toISOString(), sources, addresses };
}

/** How old a snapshot is, in seconds. */
export function snapshotAgeSeconds(
  snapshot: OfacSnapshot,
  now = new Date(),
): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(snapshot.fetchedAt)) / 1000));
}

/** Whether a snapshot is too old to base an issuance decision on. */
export function isStale(snapshot: OfacSnapshot, maxAgeSeconds: number, now = new Date()): boolean {
  return snapshotAgeSeconds(snapshot, now) > maxAgeSeconds;
}

/** Read a cached snapshot, or `null` if there is none or it cannot be read. */
export async function readCachedSnapshot(path: string): Promise<OfacSnapshot | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as OfacSnapshot;
    if (typeof parsed.fetchedAt !== "string" || !Array.isArray(parsed.addresses)) return null;
    if (Number.isNaN(Date.parse(parsed.fetchedAt))) return null;
    return parsed;
  } catch {
    // A missing or corrupt cache is not an error: it means the next screening triggers a fetch.
    // It is never a reason to answer "clean".
    return null;
  }
}

/** Write a snapshot to the cache, atomically, so a crash mid-write cannot corrupt it. */
export async function writeCachedSnapshot(path: string, snapshot: OfacSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(snapshot), "utf8");
  await rename(temporary, path);
}

/** Drop the query string, which on the OFAC redirect chain is a signed, expiring token. */
function stripQuery(url: string): string {
  const cut = url.indexOf("?");
  return cut === -1 ? url : url.slice(0, cut);
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "AbortError" ? "timed out" : `${error.name}: ${error.message}`;
  }
  return String(error);
}
