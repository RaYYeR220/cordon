/**
 * Fail closed.
 *
 * This is the file that matters. The service's claim is that a `NOT_SANCTIONED` credential means
 * somebody actually looked, and that claim is worth exactly as much as the guarantee that no code
 * path answers "clean" when the lookup did not happen. Every way the lookup can fail is exercised
 * here: an unreachable host, an HTTP error, a source that answers with something that is not a
 * sanctions list, a partial fetch, and a cache too old to trust.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { ScreeningService, comparisonForms, normalizeForComparison } from "../src/ofac/screening.js";
import { readCachedSnapshot } from "../src/ofac/snapshot.js";
import {
  CLEAN_ADDRESS,
  LISTED_ETH,
  LISTED_STARKNET,
  LISTED_STARKNET_UNPADDED,
  erroringFetch,
  failingFetch,
  fixtureFetch,
  fixtureXml,
  temporaryDirectory,
} from "./support.js";

const xml = await fixtureXml();

let directory: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ path: directory, cleanup } = await temporaryDirectory());
});

afterEach(async () => {
  await cleanup();
});

function service(overrides: {
  fetchImpl?: typeof fetch;
  maxAgeSeconds?: number;
  now?: () => Date;
  sources?: string[];
  cachePath?: string;
}): ScreeningService {
  return new ScreeningService({
    sources: overrides.sources ?? ["https://ofac.test/sdn.xml"],
    maxAgeSeconds: overrides.maxAgeSeconds ?? 86_400,
    fetchTimeoutMs: 5_000,
    cachePath: overrides.cachePath ?? join(directory, "ofac.json"),
    fetchImpl: overrides.fetchImpl ?? fixtureFetch(xml),
    ...(overrides.now ? { now: overrides.now } : {}),
  });
}

describe("screening against a live snapshot", () => {
  it("clears an address that is not on any list, and says what it checked against", async () => {
    const screening = service({});
    const result = await screening.screen(CLEAN_ADDRESS);

    expect(result.status).toBe("clear");
    expect(result.matches).toEqual([]);
    expect(result.provenance?.addressCount).toBe(4);
    expect(result.provenance?.assets).toEqual(["ETH", "STRK", "TRX", "XBT"]);
    expect(result.provenance?.sources[0]?.publishDate).toBe("01/15/2026");
    expect(result.reason).toContain("01/15/2026");
  });

  it("matches a listed address regardless of case", async () => {
    const screening = service({});
    const result = await screening.screen(LISTED_ETH.toLowerCase());

    expect(result.status).toBe("match");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ name: "Pat EXAMPLE-PERSON", asset: "ETH" });
    expect(result.reason).toContain("Pat EXAMPLE-PERSON");
  });

  it("matches a Starknet address whichever way its leading zeros are written", async () => {
    const screening = service({});
    for (const form of [LISTED_STARKNET, LISTED_STARKNET_UNPADDED, LISTED_STARKNET.toUpperCase()]) {
      const result = await screening.screen(form);
      expect(result.status, `${form} should match`).toBe("match");
      expect(result.matches[0]?.asset).toBe("STRK");
    }
  });

  it("records every form it compared, so a decision can be re-derived", async () => {
    const screening = service({});
    const result = await screening.screen(LISTED_STARKNET_UNPADDED);
    expect(result.comparedForms).toContain(LISTED_STARKNET_UNPADDED.toLowerCase());
    expect(result.comparedForms).toContain(LISTED_STARKNET.toLowerCase());
  });

  it("caches the snapshot so a restart does not need the network", async () => {
    const cachePath = join(directory, "ofac.json");
    await service({ cachePath }).screen(CLEAN_ADDRESS);

    const cached = await readCachedSnapshot(cachePath);
    expect(cached?.addresses).toHaveLength(4);

    // A second service with no working network still screens, from the cache.
    const offline = service({ cachePath, fetchImpl: failingFetch() });
    await offline.initialise();
    expect((await offline.screen(LISTED_ETH)).status).toBe("match");
  });
});

describe("failing closed", () => {
  it("answers unavailable, never clear, when the source cannot be reached", async () => {
    const screening = service({ fetchImpl: failingFetch() });
    const result = await screening.screen(CLEAN_ADDRESS);

    expect(result.status).toBe("unavailable");
    expect(result.matches).toEqual([]);
    expect(result.provenance).toBeNull();
    expect(result.reason).toContain("unavailable");
    expect(result.reason).toContain("ENOTFOUND");
  });

  it("answers unavailable when the source returns an HTTP error", async () => {
    const screening = service({ fetchImpl: erroringFetch(503) });
    const result = await screening.screen(CLEAN_ADDRESS);
    expect(result.status).toBe("unavailable");
    expect(result.reason).toContain("503");
  });

  it("answers unavailable when the source returns something that is not a sanctions list", async () => {
    // The nastiest failure: an error page served with a 200. It is valid text, it contains no
    // listed addresses, and treating it as a list would clear every address on earth.
    const screening = service({
      fetchImpl: (async () =>
        new Response("<html><body>maintenance</body></html>", { status: 200 })) as typeof fetch,
    });
    const result = await screening.screen(CLEAN_ADDRESS);
    expect(result.status).toBe("unavailable");
    expect(result.reason).toContain("not an OFAC sanctions list");
  });

  it("answers unavailable when only some of the sources answer", async () => {
    // A partial snapshot is a screening with a hole in it, and a hole is indistinguishable from a
    // pass. Better to have no answer than half of one.
    let call = 0;
    const flaky = (async () => {
      call += 1;
      if (call === 1) return new Response(xml, { status: 200 });
      throw new Error("connection reset");
    }) as unknown as typeof fetch;

    const screening = service({
      sources: ["https://ofac.test/sdn.xml", "https://ofac.test/consolidated.xml"],
      fetchImpl: flaky,
    });
    const result = await screening.screen(CLEAN_ADDRESS);
    expect(result.status).toBe("unavailable");
    expect(result.reason).toContain("consolidated.xml");
  });

  it("answers unavailable when the cached snapshot is older than the freshness limit", async () => {
    const cachePath = join(directory, "ofac.json");
    await service({ cachePath }).screen(CLEAN_ADDRESS);

    // Two days later, with the network down. The cache is there, and it is not good enough.
    const later = new Date(Date.now() + 2 * 86_400_000);
    const stale = service({
      cachePath,
      fetchImpl: failingFetch(),
      maxAgeSeconds: 86_400,
      now: () => later,
    });
    await stale.initialise();

    const result = await stale.screen(CLEAN_ADDRESS);
    expect(result.status).toBe("unavailable");
    expect(stale.status().stale).toBe(true);
    expect(stale.status().available).toBe(false);
  });

  it("recovers as soon as the source comes back", async () => {
    let broken = true;
    const flapping = (async () => {
      if (broken) throw new Error("connection refused");
      return new Response(xml, { status: 200 });
    }) as unknown as typeof fetch;

    const screening = service({ fetchImpl: flapping });
    expect((await screening.screen(CLEAN_ADDRESS)).status).toBe("unavailable");

    broken = false;
    const result = await screening.screen(CLEAN_ADDRESS);
    expect(result.status).toBe("clear");
    expect(screening.status().lastFailure).toBeNull();
  });

  it("reports what failed, so an operator can act on it", async () => {
    const screening = service({ fetchImpl: failingFetch("socket hang up") });
    await screening.initialise();
    const status = screening.status();

    expect(status.available).toBe(false);
    expect(status.fetchedAt).toBeNull();
    expect(status.lastFailure?.attempts[0]).toMatchObject({ url: "https://ofac.test/sdn.xml" });
    expect(status.lastFailure?.attempts[0]?.error).toContain("socket hang up");
  });

  it("starts even with no snapshot at all, rather than refusing to boot", async () => {
    const screening = service({ fetchImpl: failingFetch() });
    await expect(screening.initialise()).resolves.toBeUndefined();
    expect(screening.snapshot).toBeNull();
  });
});

describe("address comparison", () => {
  it("folds case on both sides", () => {
    expect(normalizeForComparison("  0xAbCd  ")).toBe("0xabcd");
  });

  it("covers padded, unpadded and prefixless spellings of a hex address", () => {
    const forms = comparisonForms("0x00ff");
    expect(forms).toContain("0xff");
    expect(forms).toContain(`0x${"ff".padStart(64, "0")}`);
    expect(forms).toContain("ff");
  });

  it("leaves a base58 address alone apart from case", () => {
    expect(comparisonForms("1ExampleBitcoinAddress")).toEqual(["1examplebitcoinaddress"]);
  });
});
