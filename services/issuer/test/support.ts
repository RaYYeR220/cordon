/**
 * Test scaffolding: a fake OFAC source, a temporary working directory, and a fixed issuer key.
 *
 * Everything here exists so the tests can drive the real code paths — the real parser, the real
 * cache, the real HTTP surface — without a network. A test that stubs the screening service itself
 * would prove nothing about the behaviour that matters, which is what the service does when the
 * screening cannot run.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../src/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** A fixed key for the tests. Public repository, so it signs nothing anyone should trust. */
export const TEST_ISSUER_PRIVATE_KEY =
  "0x3c1e9550e66958296d11b60f8e8e7a7ad990d07fa65d5f7652c4a6c87d4e3cc";

/** The miniature list in OFAC's schema. */
export async function fixtureXml(): Promise<string> {
  return readFile(join(HERE, "fixtures", "sanctions-list.xml"), "utf8");
}

/** An address the fixture list carries, in the form the fixture prints it. */
export const LISTED_ETH = "0xAAAABBBBCCCCDDDDEEEEFFFF0000111122223333";
/** A listed Starknet-shaped address, zero-padded to 64 hex digits as the fixture prints it. */
export const LISTED_STARKNET =
  "0x04a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f";
/** The same address with its leading zero trimmed, as a wallet would print it. */
export const LISTED_STARKNET_UNPADDED =
  "0x4a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f";
/** An address no list carries. */
export const CLEAN_ADDRESS = "0x0511f0e5d0ce2b0b1e1a3d4c5b6a79887766554433221100ffeeddccbbaa9988";

/** The address the tests register as the issuer's operator. */
export const TEST_OPERATOR_ADDRESS =
  "0x0499b3f4c88a4b6d2e1a7c0f5e9d8a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7";

/** A subject pseudonym for request bodies. */
export const SUBJECT_PUBLIC_KEY =
  "0x1ce8adcb0d0e5e0d0a3e2b8b8f9e5c3b2a1908070605040302010f0e0d0c0b0";

/** A `fetch` that serves the fixture for every URL. */
export function fixtureFetch(body: string, url = "https://ofac.test/sdn.xml"): typeof fetch {
  return (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/xml" },
    })) as unknown as typeof fetch;
}

/** A `fetch` that always fails, the way an outage does. */
export function failingFetch(message = "getaddrinfo ENOTFOUND"): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

/** A `fetch` that answers with an HTTP error, the way a broken endpoint does. */
export function erroringFetch(status = 503): typeof fetch {
  return (async () =>
    new Response("<html>Service Unavailable</html>", {
      status,
      statusText: "Service Unavailable",
    })) as unknown as typeof fetch;
}

/** A temporary directory that cleans itself up. */
export async function temporaryDirectory(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "cordon-issuer-"));
  return { path, cleanup: async () => rm(path, { recursive: true, force: true }) };
}

/** A configuration pointing at a temporary directory, with everything else at its default. */
export function testConfig(directory: string, overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    issuerId: "0x434f52444f4e5f4f464143",
    issuerPrivateKey: TEST_ISSUER_PRIVATE_KEY,
    issuerMetadataUri: "https://cordon.test/issuer.json",
    issuerOperator: TEST_OPERATOR_ADDRESS,
    adminToken: "",
    ofacSources: ["https://ofac.test/sdn.xml"],
    ofacMaxAgeSeconds: 86_400,
    ofacFetchTimeoutMs: 5_000,
    ofacCachePath: join(directory, "ofac.json"),
    storePath: join(directory, "store.json"),
    credentialValiditySeconds: 2_592_000,
    logLevel: "silent",
    ...overrides,
  };
}
