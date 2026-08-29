/**
 * The HTTP surface, driven end to end against a fake OFAC source.
 *
 * Nothing here stubs the screening. The real parser reads the real schema and the real store writes
 * a real file, so what these tests exercise is what a caller would actually get.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  credentialFromJson,
  decodeCredential,
  subjectPublicKey,
  verifyCredentialSignature,
} from "@cordon/sdk";
import { buildServer } from "../src/server.js";
import { ScreeningService } from "../src/ofac/screening.js";
import { Store } from "../src/store.js";
import type { Config } from "../src/config.js";
import {
  CLEAN_ADDRESS,
  LISTED_ETH,
  SUBJECT_PUBLIC_KEY,
  TEST_ISSUER_PRIVATE_KEY,
  TEST_OPERATOR_ADDRESS,
  failingFetch,
  fixtureFetch,
  fixtureXml,
  temporaryDirectory,
  testConfig,
} from "./support.js";

const xml = await fixtureXml();
const servers: FastifyInstance[] = [];

let directory: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ path: directory, cleanup } = await temporaryDirectory());
});

afterEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function start(options: {
  fetchImpl?: typeof fetch;
  config?: Partial<Config>;
} = {}): Promise<{ app: FastifyInstance; config: Config; store: Store }> {
  const config = testConfig(directory, options.config ?? {});
  const screening = new ScreeningService({
    sources: config.ofacSources,
    maxAgeSeconds: config.ofacMaxAgeSeconds,
    fetchTimeoutMs: config.ofacFetchTimeoutMs,
    cachePath: config.ofacCachePath,
    fetchImpl: options.fetchImpl ?? fixtureFetch(xml),
  });
  const store = new Store(config.storePath);
  await store.load();
  await screening.initialise();

  const app = buildServer({ config, screening, store });
  servers.push(app);
  return { app, config, store };
}

describe("GET /issuer", () => {
  it("publishes the key a registry operator needs and nothing more", async () => {
    const { app, config } = await start();
    const response = await app.inject({ method: "GET", url: "/issuer" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.publicKey).toBe(subjectPublicKey(TEST_ISSUER_PRIVATE_KEY));
    expect(body.issuerName).toBe("CORDON_OFAC");
    expect(body.claim).toBe("NOT_SANCTIONED");
    expect(JSON.stringify(body)).not.toContain(config.issuerPrivateKey);
  });

  it("gives register_issuer its four arguments, operator included", () => {
    // IssuerRegistry::register_issuer(issuer_id, public_key, operator, metadata_uri). The operator
    // is the only address that can ever revoke this issuer's credentials, so omitting it would
    // register an issuer nobody can withdraw an attestation from.
    return start().then(async ({ app }) => {
      const body = (await app.inject({ method: "GET", url: "/issuer" })).json();
      expect(body.registerIssuer).toEqual({
        issuerId: "0x434f52444f4e5f4f464143",
        publicKey: subjectPublicKey(TEST_ISSUER_PRIVATE_KEY),
        operator: TEST_OPERATOR_ADDRESS,
        metadataUri: "https://cordon.test/issuer.json",
      });
      expect(body.warning).toBeUndefined();
    });
  });

  it("warns when no operator is configured, rather than registering an unrevokable issuer", async () => {
    const { app } = await start({ config: { issuerOperator: "" } });
    const body = (await app.inject({ method: "GET", url: "/issuer" })).json();
    expect(body.registerIssuer.operator).toBe("");
    expect(body.warning).toContain("revoke");
  });
});

describe("GET /health", () => {
  it("reports the snapshot age and answers 200 when it can screen", async () => {
    const { app } = await start();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.ofac.addressCount).toBe(4);
    expect(body.ofac.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(body.ofac.sources[0].publishDate).toBe("01/15/2026");
  });

  it("answers 503 when there is no usable snapshot", async () => {
    const { app } = await start({ fetchImpl: failingFetch() });
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(503);
    expect(response.json().ok).toBe(false);
    expect(response.json().ofac.lastFailure.attempts).toHaveLength(1);
  });
});

describe("POST /credentials", () => {
  it("issues a credential whose signature verifies against the issuer key", async () => {
    const { app } = await start();
    const response = await app.inject({
      method: "POST",
      url: "/credentials",
      payload: { subjectPublicKey: SUBJECT_PUBLIC_KEY, address: CLEAN_ADDRESS },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.issued).toBe(true);
    expect(body.screening.status).toBe("clear");

    const credential = credentialFromJson(body.credential);
    expect(
      verifyCredentialSignature(
        credential,
        subjectPublicKey(TEST_ISSUER_PRIVATE_KEY),
        credential.signature,
      ),
    ).toBe(true);
    expect(credential.claim).toBe("0x4e4f545f53414e4354494f4e4544"); // 'NOT_SANCTIONED'
    expect(credential.subjectPublicKey).toBe(SUBJECT_PUBLIC_KEY);
  });

  it("returns a compact form that decodes back to the same credential", async () => {
    const { app } = await start();
    const body = (
      await app.inject({
        method: "POST",
        url: "/credentials",
        payload: { subjectPublicKey: SUBJECT_PUBLIC_KEY, address: CLEAN_ADDRESS },
      })
    ).json();

    expect(decodeCredential(body.compact)).toEqual(credentialFromJson(body.credential));
  });

  it("never writes the screened address into the credential", async () => {
    const { app } = await start();
    const body = (
      await app.inject({
        method: "POST",
        url: "/credentials",
        payload: { subjectPublicKey: SUBJECT_PUBLIC_KEY, address: CLEAN_ADDRESS },
      })
    ).json();

    expect(JSON.stringify(body.credential)).not.toContain(CLEAN_ADDRESS.slice(2, 20));
  });

  it("refuses a listed address with 403 and names the listing", async () => {
    const { app, store } = await start();
    const response = await app.inject({
      method: "POST",
      url: "/credentials",
      payload: { subjectPublicKey: SUBJECT_PUBLIC_KEY, address: LISTED_ETH },
    });

    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.issued).toBe(false);
    expect(body.error).toBe("sanctioned");
    expect(body.screening.matches[0].name).toBe("Pat EXAMPLE-PERSON");
    expect(store.refusals()).toHaveLength(1);
    expect(store.list()).toHaveLength(0);
  });

  it("refuses with 503 when screening is unavailable, and issues nothing", async () => {
    const { app, store } = await start({ fetchImpl: failingFetch() });
    const response = await app.inject({
      method: "POST",
      url: "/credentials",
      payload: { subjectPublicKey: SUBJECT_PUBLIC_KEY, address: CLEAN_ADDRESS },
    });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.issued).toBe(false);
    expect(body.error).toBe("unavailable");
    expect(body.credential).toBeUndefined();
    expect(body.screening.status).toBe("unavailable");
    expect(store.list()).toHaveLength(0);
    // The refusal is recorded either way. "We could not check" is a fact worth keeping.
    expect(store.refusals()).toHaveLength(1);
    expect(store.refusals()[0]?.screening.status).toBe("unavailable");
  });

  it("rejects a malformed subject key or address before screening anything", async () => {
    const { app } = await start();

    const noSubject = await app.inject({
      method: "POST",
      url: "/credentials",
      payload: { address: CLEAN_ADDRESS },
    });
    expect(noSubject.statusCode).toBe(400);

    const badAddress = await app.inject({
      method: "POST",
      url: "/credentials",
      payload: { subjectPublicKey: SUBJECT_PUBLIC_KEY, address: "not-an-address" },
    });
    expect(badAddress.statusCode).toBe(400);

    const badValidity = await app.inject({
      method: "POST",
      url: "/credentials",
      payload: { subjectPublicKey: SUBJECT_PUBLIC_KEY, address: CLEAN_ADDRESS, validitySeconds: -1 },
    });
    expect(badValidity.statusCode).toBe(400);
  });

  it("refuses to reissue the same credential id", async () => {
    const { app } = await start();
    const payload = {
      subjectPublicKey: SUBJECT_PUBLIC_KEY,
      address: CLEAN_ADDRESS,
      credentialId: "0x435245445f30303031",
    };
    expect((await app.inject({ method: "POST", url: "/credentials", payload })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/credentials", payload })).statusCode).toBe(409);
  });

  it("honours a requested validity window", async () => {
    const { app } = await start();
    const before = Math.floor(Date.now() / 1000);
    const body = (
      await app.inject({
        method: "POST",
        url: "/credentials",
        payload: { subjectPublicKey: SUBJECT_PUBLIC_KEY, address: CLEAN_ADDRESS, validitySeconds: 3_600 },
      })
    ).json();

    expect(body.credential.expiresAt).toBeGreaterThanOrEqual(before + 3_600);
    expect(body.credential.expiresAt).toBeLessThanOrEqual(before + 3_610);
  });
});

describe("the record", () => {
  it("lists what was issued, with the screening that justified it", async () => {
    const { app } = await start();
    await app.inject({
      method: "POST",
      url: "/credentials",
      payload: { subjectPublicKey: SUBJECT_PUBLIC_KEY, address: CLEAN_ADDRESS },
    });

    const listed = (await app.inject({ method: "GET", url: "/credentials" })).json();
    expect(listed.count).toBe(1);
    expect(listed.credentials[0].screening.status).toBe("clear");
    expect(listed.credentials[0].screenedAddress).toBe(CLEAN_ADDRESS);
    expect(listed.credentials[0].screening.provenance.sources[0].url).toBe(
      "https://ofac.test/sdn.xml",
    );
  });

  it("survives a restart, because it is on disk", async () => {
    const { app } = await start();
    await app.inject({
      method: "POST",
      url: "/credentials",
      payload: { subjectPublicKey: SUBJECT_PUBLIC_KEY, address: CLEAN_ADDRESS },
    });

    const { app: restarted } = await start();
    expect((await restarted.inject({ method: "GET", url: "/credentials" })).json().count).toBe(1);
  });

  it("serves one credential by id and 404s an unknown one", async () => {
    const { app } = await start();
    const issued = (
      await app.inject({
        method: "POST",
        url: "/credentials",
        payload: { subjectPublicKey: SUBJECT_PUBLIC_KEY, address: CLEAN_ADDRESS },
      })
    ).json();

    const id = issued.credential.credentialId;
    expect((await app.inject({ method: "GET", url: `/credentials/${id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/credentials/0xdead" })).statusCode).toBe(404);
  });
});

describe("revocation", () => {
  it("records a revocation and says it is not yet on chain", async () => {
    const { app } = await start();
    const issued = (
      await app.inject({
        method: "POST",
        url: "/credentials",
        payload: { subjectPublicKey: SUBJECT_PUBLIC_KEY, address: CLEAN_ADDRESS },
      })
    ).json();
    const id = issued.credential.credentialId;

    const response = await app.inject({
      method: "POST",
      url: `/credentials/${id}/revoke`,
      payload: { reason: "subject appeared on a later list" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.revoked).toBe(true);
    expect(body.credential.revocationReason).toBe("subject appeared on a later list");
    expect(body.onChain.pending).toBe(true);
    expect(body.onChain.message).toContain("RevocationRegistry");
    expect(body.onChain.message).toContain(TEST_OPERATOR_ADDRESS);
  });

  it("requires a reason, so the record is auditable", async () => {
    const { app } = await start();
    const issued = (
      await app.inject({
        method: "POST",
        url: "/credentials",
        payload: { subjectPublicKey: SUBJECT_PUBLIC_KEY, address: CLEAN_ADDRESS },
      })
    ).json();

    const response = await app.inject({
      method: "POST",
      url: `/credentials/${issued.credential.credentialId}/revoke`,
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses to revoke twice", async () => {
    const { app } = await start();
    const issued = (
      await app.inject({
        method: "POST",
        url: "/credentials",
        payload: { subjectPublicKey: SUBJECT_PUBLIC_KEY, address: CLEAN_ADDRESS },
      })
    ).json();
    const url = `/credentials/${issued.credential.credentialId}/revoke`;
    const payload = { reason: "first" };

    expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(404);
  });

  it("needs the admin token when one is configured", async () => {
    const { app } = await start({ config: { adminToken: "s3cret" } });
    const issued = (
      await app.inject({
        method: "POST",
        url: "/credentials",
        payload: { subjectPublicKey: SUBJECT_PUBLIC_KEY, address: CLEAN_ADDRESS },
      })
    ).json();
    const url = `/credentials/${issued.credential.credentialId}/revoke`;

    expect((await app.inject({ method: "POST", url, payload: { reason: "x" } })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          payload: { reason: "x" },
          headers: { authorization: "Bearer wrong" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          payload: { reason: "x" },
          headers: { authorization: "Bearer s3cret" },
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe("POST /ofac/refresh", () => {
  it("refreshes on demand and reports the new snapshot", async () => {
    const { app } = await start();
    const response = await app.inject({ method: "POST", url: "/ofac/refresh" });
    expect(response.statusCode).toBe(200);
    expect(response.json().ofac.addressCount).toBe(4);
  });

  it("answers 503 rather than pretending when the source is down", async () => {
    const { app } = await start({ fetchImpl: failingFetch() });
    const response = await app.inject({ method: "POST", url: "/ofac/refresh" });
    expect(response.statusCode).toBe(503);
    expect(response.json().refreshed).toBe(false);
  });

  it("needs the admin token when one is configured", async () => {
    const { app } = await start({ config: { adminToken: "s3cret" } });
    expect((await app.inject({ method: "POST", url: "/ofac/refresh" })).statusCode).toBe(401);
  });
});

describe("attested claims", () => {
  const attested = { attestedClaims: ["ACCREDITED", "KYC_L2"], adminToken: "s3cret" };

  it("refuses a claim this deployment was not configured to attest", async () => {
    const { app } = await start();
    const response = await app.inject({
      method: "POST",
      url: "/credentials",
      payload: { subjectPublicKey: SUBJECT_PUBLIC_KEY, claim: "ACCREDITED", basis: "anything" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("does not attest");
  });

  it("names its whole catalogue, and what stands behind each entry", async () => {
    const { app } = await start({ config: attested });
    const body = (await app.inject({ method: "GET", url: "/issuer" })).json();

    expect(body.claims.map((entry: { claim: string }) => entry.claim)).toEqual([
      "NOT_SANCTIONED",
      "ACCREDITED",
      "KYC_L2",
    ]);
    expect(body.claims[0].evidence).toBe("ofac-screen");
    expect(body.claims[0].requiresAdmin).toBe(false);
    expect(body.claims[1].evidence).toBe("operator-attestation");
    expect(body.claims[1].requiresAdmin).toBe(true);
  });

  it("will not attest without the admin token", async () => {
    const { app } = await start({ config: attested });
    const response = await app.inject({
      method: "POST",
      url: "/credentials",
      payload: { subjectPublicKey: SUBJECT_PUBLIC_KEY, claim: "ACCREDITED", basis: "on file" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("will not attest without a basis, because the record would be unauditable", async () => {
    const { app } = await start({ config: attested });
    const response = await app.inject({
      method: "POST",
      url: "/credentials",
      headers: { authorization: "Bearer s3cret" },
      payload: { subjectPublicKey: SUBJECT_PUBLIC_KEY, claim: "ACCREDITED" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("basis is required");
  });

  it("signs a verifiable credential and records it as an operator's word, not a screen", async () => {
    const { app, config, store } = await start({ config: attested });
    const response = await app.inject({
      method: "POST",
      url: "/credentials",
      headers: { authorization: "Bearer s3cret" },
      payload: {
        subjectPublicKey: SUBJECT_PUBLIC_KEY,
        claim: "ACCREDITED",
        basis: "Reg D questionnaire, reviewed 2026-08-29",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.claim).toBe("ACCREDITED");
    expect(body.evidence).toBe("operator-attestation");
    expect(body.screening).toBeNull();
    expect(body.attestation.basis).toBe("Reg D questionnaire, reviewed 2026-08-29");

    // The signature is the only thing the gate will look at, so it has to verify against the
    // registered key exactly as a screened credential's does.
    const credential = credentialFromJson(body.credential);
    expect(
      verifyCredentialSignature(
        credential,
        subjectPublicKey(config.issuerPrivateKey),
        credential.signature,
      ),
    ).toBe(true);
    expect(credential.claim).toBe("0x41434352454449544544"); // 'ACCREDITED'
    expect(decodeCredential(body.compact)).toEqual(credential);

    const record = store.find(body.credential.credentialId);
    expect(record?.screening).toBeNull();
    expect(record?.screenedAddress).toBeNull();
    expect(record?.attestation?.evidence).toBe("operator-attestation");
  });

  it("screens nothing for an attested claim, and takes no address to pretend it did", async () => {
    // The fetch would throw if the screening ran at all, which is the assertion: an attested
    // claim must not be able to reach the OFAC path even when a caller sends an address.
    const { app } = await start({ fetchImpl: failingFetch(), config: attested });
    const response = await app.inject({
      method: "POST",
      url: "/credentials",
      headers: { authorization: "Bearer s3cret" },
      payload: {
        subjectPublicKey: SUBJECT_PUBLIC_KEY,
        claim: "KYC_L2",
        basis: "documents checked in person",
        address: LISTED_ETH,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().screening).toBeNull();
    expect(JSON.stringify(response.json())).not.toContain(LISTED_ETH);
  });

  it("still screens the claim it has a source for, even alongside attested ones", async () => {
    const { app } = await start({ config: attested });
    const response = await app.inject({
      method: "POST",
      url: "/credentials",
      payload: { subjectPublicKey: SUBJECT_PUBLIC_KEY, address: CLEAN_ADDRESS },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().claim).toBe("NOT_SANCTIONED");
    expect(response.json().evidence).toBe("ofac-screen");
    expect(response.json().screening.status).toBe("clear");
  });
});

describe("cross-origin access", () => {
  it("allows only the origins the deployment named", async () => {
    const { app } = await start({ config: { allowedOrigins: ["http://localhost:3000"] } });

    const allowed = await app.inject({
      method: "GET",
      url: "/issuer",
      headers: { origin: "http://localhost:3000" },
    });
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:3000");

    const other = await app.inject({
      method: "GET",
      url: "/issuer",
      headers: { origin: "https://not-ours.example" },
    });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows nothing at all by default", async () => {
    const { app } = await start();
    const response = await app.inject({
      method: "GET",
      url: "/issuer",
      headers: { origin: "http://localhost:3000" },
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
