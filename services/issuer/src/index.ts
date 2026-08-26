/**
 * Entry point: read the configuration, load the sanctions snapshot, serve.
 *
 * The service starts even when OFAC is unreachable. It will refuse every issuance while that is
 * true and say so on `/health`, which is more useful to an operator than a process that will not
 * boot — the refusals are the signal, and they are visible.
 */

import { ConfigError, loadConfig, redactConfig } from "./config.js";
import { ScreeningService } from "./ofac/screening.js";
import { buildServer } from "./server.js";
import { Store } from "./store.js";

async function main(): Promise<void> {
  const config = loadConfig();

  const screening = new ScreeningService({
    sources: config.ofacSources,
    maxAgeSeconds: config.ofacMaxAgeSeconds,
    fetchTimeoutMs: config.ofacFetchTimeoutMs,
    cachePath: config.ofacCachePath,
  });
  const store = new Store(config.storePath);

  const app = buildServer({ config, screening, store });
  app.log.info(redactConfig(config), "cordon issuer starting");

  await store.load();
  await screening.initialise();

  const status = screening.status();
  if (status.available) {
    app.log.info(
      { fetchedAt: status.fetchedAt, addressCount: status.addressCount, assets: status.assets },
      "OFAC snapshot loaded",
    );
  } else {
    app.log.error(
      { lastFailure: status.lastFailure, stale: status.stale },
      "no usable OFAC snapshot: every issuance will be refused until one is fetched",
    );
  }

  await app.listen({ host: config.host, port: config.port });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, "shutting down");
      void app.close().then(() => process.exit(0));
    });
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    // Configuration errors are for a human, not a stack trace. Never echo the value that failed:
    // the one most likely to be wrong is the signing key.
    process.stderr.write(`configuration error: ${error.message}\n`);
    process.exit(78); // EX_CONFIG
  }
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
