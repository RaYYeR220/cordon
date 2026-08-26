/**
 * The real thing, against the real Treasury endpoints.
 *
 * Skipped by default: a unit suite that fails when a government web server is slow tells you
 * nothing about your code. Run it deliberately, before a deployment or a demo, to confirm the
 * sources still answer and still have the shape this service parses:
 *
 *     OFAC_LIVE=1 npm test
 *
 * It asserts nothing about *which* addresses are listed. That changes whenever OFAC publishes, and
 * a test that pinned today's list would be a test that fails for being right.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_OFAC_SOURCES } from "../src/config.js";
import { ScreeningService, listedAssets } from "../src/ofac/screening.js";
import { fetchSnapshot } from "../src/ofac/snapshot.js";

const live = process.env["OFAC_LIVE"] === "1";

describe.skipIf(!live)("the live OFAC lists", () => {
  it(
    "fetches and parses every configured source",
    async () => {
      const snapshot = await fetchSnapshot({
        sources: DEFAULT_OFAC_SOURCES,
        timeoutMs: 180_000,
      });

      expect(snapshot.sources).toHaveLength(DEFAULT_OFAC_SOURCES.length);
      for (const source of snapshot.sources) {
        expect(source.bytes).toBeGreaterThan(1_000);
        expect(source.entryCount).toBeGreaterThan(0);
        expect(source.publishDate).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
      }

      // The SDN list has carried hundreds of digital-currency addresses since 2018. Zero would
      // mean the schema moved and the parser is silently finding nothing.
      expect(snapshot.addresses.length).toBeGreaterThan(100);
      expect(listedAssets(snapshot)).toContain("XBT");
      expect(listedAssets(snapshot)).toContain("ETH");
    },
    300_000,
  );

  it(
    "screens an address end to end",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "cordon-live-"));
      try {
        const screening = new ScreeningService({
          sources: DEFAULT_OFAC_SOURCES,
          maxAgeSeconds: 86_400,
          fetchTimeoutMs: 180_000,
          cachePath: join(directory, "ofac.json"),
        });
        await screening.initialise();

        const snapshot = screening.snapshot;
        expect(snapshot).not.toBeNull();

        // A listed address, taken from the snapshot itself rather than hard-coded, must match.
        const listed = snapshot?.addresses[0];
        expect(listed).toBeDefined();
        expect((await screening.screen(listed?.address ?? "")).status).toBe("match");

        // And an address that is not on the list must come back clear, with provenance attached.
        const clear = await screening.screen(
          "0x0511f0e5d0ce2b0b1e1a3d4c5b6a79887766554433221100ffeeddccbbaa9988",
        );
        expect(clear.status).toBe("clear");
        expect(clear.provenance?.sources[0]?.resolvedUrl).toContain("http");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
