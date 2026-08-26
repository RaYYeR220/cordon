/**
 * Configuration, read from the environment once at startup.
 *
 * Two rules govern this file. The issuer's private key comes from the environment and nowhere
 * else — never a file in the repository, never a request, never a default. And nothing here ever
 * ends up in a log line: {@link redactConfig} is what the service logs, and it does not carry the
 * key.
 */

import { isFelt, toFelt, type Felt } from "@cordon/sdk";

/** The lists this service screens against, in the order it fetches them. */
export const DEFAULT_OFAC_SOURCES = [
  // The Specially Designated Nationals list. Redirects to the OFAC sanctions list service.
  "https://www.treasury.gov/ofac/downloads/sdn.xml",
  // The Consolidated (non-SDN) sanctions list, same schema.
  "https://www.treasury.gov/ofac/downloads/consolidated/consolidated.xml",
] as const;

export interface Config {
  host: string;
  port: number;
  /** The issuer id this service attests under, as registered in the `IssuerRegistry`. */
  issuerId: Felt;
  /** The signing key. Never logged, never returned by any endpoint. */
  issuerPrivateKey: Felt;
  /** Off-chain metadata about the issuer: who runs it, what it screens, how to reach it. */
  issuerMetadataUri: string;
  /** Bearer token guarding revocation and forced refreshes. Empty means those routes are open. */
  adminToken: string;
  /** Where the OFAC lists are fetched from. */
  ofacSources: string[];
  /**
   * How old a snapshot may be and still be trusted for an issuance decision.
   *
   * Past this, the service refuses to issue rather than screening against stale data. It is the
   * difference between "we checked" and "we checked, some time last month".
   */
  ofacMaxAgeSeconds: number;
  /** Timeout for one source fetch. The SDN list is around 30 MB, so this is generous. */
  ofacFetchTimeoutMs: number;
  /** Where the snapshot is cached between restarts. */
  ofacCachePath: string;
  /** Where issued credentials and revocations are kept. */
  storePath: string;
  /** How long an issued credential is valid for, in seconds. */
  credentialValiditySeconds: number;
  /** Log level passed to Fastify. */
  logLevel: string;
}

/** Thrown when the environment cannot produce a usable configuration. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Build the configuration, or fail loudly.
 *
 * A service that starts with a missing signing key and only discovers it on the first request is a
 * service that fails in front of a user instead of in front of an operator.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const issuerPrivateKey = required(env, "ISSUER_PRIVATE_KEY");
  if (!isFelt(issuerPrivateKey.trim())) {
    throw new ConfigError(
      "ISSUER_PRIVATE_KEY must be a 0x-prefixed hex field element. Generate one with " +
        "`node -e \"import('@cordon/sdk').then(s => console.log(s.generateSubjectKeypair()))\"`.",
    );
  }

  return {
    host: env["HOST"] ?? "127.0.0.1",
    port: integer(env, "PORT", 8787),
    issuerId: toFelt(env["ISSUER_ID"] ?? "CORDON_OFAC"),
    issuerPrivateKey: toFelt(issuerPrivateKey.trim()),
    issuerMetadataUri: env["ISSUER_METADATA_URI"] ?? "",
    adminToken: env["ISSUER_ADMIN_TOKEN"] ?? "",
    ofacSources: list(env["OFAC_SOURCES"]) ?? [...DEFAULT_OFAC_SOURCES],
    ofacMaxAgeSeconds: integer(env, "OFAC_MAX_AGE_SECONDS", 86_400),
    ofacFetchTimeoutMs: integer(env, "OFAC_FETCH_TIMEOUT_MS", 120_000),
    ofacCachePath: env["OFAC_CACHE_PATH"] ?? ".cache/ofac-snapshot.json",
    storePath: env["STORE_PATH"] ?? ".data/credentials.json",
    credentialValiditySeconds: integer(env, "CREDENTIAL_VALIDITY_SECONDS", 30 * 86_400),
    logLevel: env["LOG_LEVEL"] ?? "info",
  };
}

/**
 * The configuration as it is safe to log or serve.
 *
 * The private key is not merely masked here — it is absent. A masked field is one refactor away
 * from an unmasked one.
 */
export function redactConfig(config: Config): Record<string, unknown> {
  return {
    host: config.host,
    port: config.port,
    issuerId: config.issuerId,
    issuerMetadataUri: config.issuerMetadataUri,
    adminTokenSet: config.adminToken.length > 0,
    ofacSources: config.ofacSources,
    ofacMaxAgeSeconds: config.ofacMaxAgeSeconds,
    ofacFetchTimeoutMs: config.ofacFetchTimeoutMs,
    ofacCachePath: config.ofacCachePath,
    storePath: config.storePath,
    credentialValiditySeconds: config.credentialValiditySeconds,
    logLevel: config.logLevel,
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new ConfigError(`${name} is required. See .env.example.`);
  }
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function list(raw: string | undefined): string[] | null {
  if (raw === undefined || raw.trim() === "") return null;
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries : null;
}
