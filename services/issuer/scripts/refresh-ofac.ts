/**
 * Fetch the OFAC lists once and report what came back.
 *
 * Useful before a demo — it warms the cache and prints the provenance, so there is no doubt about
 * which files were read, when, and what they contained.
 *
 *     npm run refresh
 */

import { DEFAULT_OFAC_SOURCES } from "../src/config.js";
import { fetchSnapshot, writeCachedSnapshot } from "../src/ofac/snapshot.js";
import { listedAssets } from "../src/ofac/screening.js";

const cachePath = process.env["OFAC_CACHE_PATH"] ?? ".cache/ofac-snapshot.json";
const sources = (process.env["OFAC_SOURCES"] ?? DEFAULT_OFAC_SOURCES.join(","))
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

const snapshot = await fetchSnapshot({ sources, timeoutMs: 180_000 });
await writeCachedSnapshot(cachePath, snapshot);

const lines: string[] = [`fetched ${snapshot.fetchedAt}`, ""];
for (const source of snapshot.sources) {
  lines.push(
    `  ${source.url}`,
    `    resolved to   ${source.resolvedUrl}`,
    `    published     ${source.publishDate ?? "(none stated)"}`,
    `    records       ${source.recordCount ?? "(none stated)"}`,
    `    entries       ${source.entryCount}`,
    `    addresses     ${source.addressCount}`,
    `    bytes         ${source.bytes}`,
    "",
  );
}
lines.push(
  `  ${snapshot.addresses.length} digital-currency addresses across ${listedAssets(snapshot).length} assets:`,
  `    ${listedAssets(snapshot).join(" ")}`,
  "",
  `  cached to ${cachePath}`,
);

process.stdout.write(`${lines.join("\n")}\n`);
