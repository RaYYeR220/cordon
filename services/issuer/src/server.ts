/**
 * The HTTP surface.
 *
 * Six things a caller can do: ask for a credential, read the issuer's public key, list what has
 * been issued, read one credential, revoke one, and check whether the sanctions data is fresh
 * enough for any of it to mean anything.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { encodeCredential, isFelt, toFelt, type Felt } from "@cordon/sdk";
import type { Config } from "./config.js";
import { ScreeningService } from "./ofac/screening.js";
import { Store } from "./store.js";
import { findClaim, NOT_SANCTIONED } from "./claims.js";
import { attest, defaultCredentialId, issue, issuerIdentity, toJson } from "./issuer.js";

export interface Dependencies {
  config: Config;
  screening: ScreeningService;
  store: Store;
}

interface CredentialRequestBody {
  subjectPublicKey?: unknown;
  address?: unknown;
  credentialId?: unknown;
  validitySeconds?: unknown;
  /** Which claim to attest. Defaults to the one this service has a source for. */
  claim?: unknown;
  /** What the operator is relying on, for a claim nothing can be screened for. */
  basis?: unknown;
}

interface RevokeBody {
  reason?: unknown;
}

/**
 * Build the server.
 *
 * Takes its dependencies rather than constructing them, so a test can drive the whole HTTP surface
 * against an injected OFAC source without a network.
 */
export function buildServer(dependencies: Dependencies): FastifyInstance {
  const { config, screening, store } = dependencies;
  const app = Fastify({
    logger: { level: config.logLevel },
    // The SDN list is large but requests to this service are small; a tight body cap costs nothing
    // and closes an easy way to tie the process up.
    bodyLimit: 64 * 1024,
  });

  /**
   * Cross-origin access, for the browser console.
   *
   * An allowlist and nothing else. No wildcard, no reflection of whatever `Origin` arrives, and no
   * credentials: this process holds an attesting key, and the one thing worse than a console that
   * cannot reach it is a page on any origin that can. `ISSUER_ALLOWED_ORIGINS` is empty by
   * default, so the browser path is opt-in per deployment.
   */
  const allowed = new Set(config.allowedOrigins.map((origin) => origin.replace(/\/$/, "")));
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin === "string" && allowed.has(origin.replace(/\/$/, ""))) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "origin");
      reply.header("access-control-allow-headers", "content-type, authorization");
      reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
      reply.header("access-control-max-age", "600");
    }
    if (request.method === "OPTIONS") {
      // Answered whether or not the origin was allowed. A pre-flight that is simply missing the
      // allow header is a clearer signal to a developer than one that never returns.
      reply.code(204).send();
    }
  });

  const identity = issuerIdentity({
    issuerId: config.issuerId,
    issuerPrivateKey: config.issuerPrivateKey,
    metadataUri: config.issuerMetadataUri,
    operator: config.issuerOperator,
    attestedClaims: config.attestedClaims,
  });

  /**
   * Who this issuer is, in the form the `IssuerRegistry` wants.
   *
   * The public key is here because it has to be: a gate cannot verify a credential without it. The
   * private key is not reachable from any route.
   */
  app.get("/issuer", async () => ({
    ...identity,
    credentialValiditySeconds: config.credentialValiditySeconds,
    sources: config.ofacSources,
    ...(identity.operator === ""
      ? {
          warning:
            "ISSUER_OPERATOR_ADDRESS is not set, so register_issuer has no operator to record. " +
            "Without one, nobody can revoke this issuer's credentials on chain.",
        }
      : {}),
  }));

  /**
   * Is the sanctions data fresh enough to issue against?
   *
   * `ok` is false whenever it is not, which is the signal a monitor should page on — an issuer
   * that cannot screen is an issuer that will refuse every request.
   */
  app.get("/health", async (_request, reply) => {
    const status = screening.status();
    const ok = status.available;
    reply.code(ok ? 200 : 503);
    return {
      ok,
      issuedCount: store.list().length,
      refusalCount: store.refusals().length,
      ofac: status,
    };
  });

  /**
   * Request a credential.
   *
   * Two paths, chosen by what stands behind the claim rather than by a flag the caller sets. A
   * screened claim is screened: the address goes to the OFAC lists, and the credential follows a
   * completed check or nothing follows at all. An attested claim is attested: there is no source
   * to check, so the route demands the admin token and a written basis, and records the result as
   * an operator's word rather than as a screen.
   *
   * The address is screened and recorded but never enters the credential. What the chain sees is
   * the pseudonym, which is why a Cordon credential can be presented on chain without linking the
   * subject to the wallet that was screened.
   */
  app.post("/credentials", async (request, reply) => {
    const body = (request.body ?? {}) as CredentialRequestBody;

    const subject = parseFelt(body.subjectPublicKey, "subjectPublicKey");
    if ("error" in subject) return badRequest(reply, subject.error);

    const requestedClaim =
      body.claim === undefined ? NOT_SANCTIONED : typeof body.claim === "string" ? body.claim.trim() : "";
    const spec = findClaim(identity.claims, requestedClaim);
    if (!spec) {
      return badRequest(
        reply,
        `this issuer does not attest ${JSON.stringify(requestedClaim)}. It signs ` +
          `${identity.claims.map((entry) => entry.claim).join(", ")}. Add a claim to ` +
          "ISSUER_ATTESTED_CLAIMS to have it signed on the operator's word.",
      );
    }

    const validity = body.validitySeconds ?? config.credentialValiditySeconds;
    if (typeof validity !== "number" || !Number.isSafeInteger(validity) || validity <= 0) {
      return badRequest(reply, "validitySeconds must be a positive integer");
    }

    const issuedAtSeconds = Math.floor(Date.now() / 1000);
    let credentialId: Felt;
    if (body.credentialId === undefined) {
      credentialId = defaultCredentialId(subject.value, issuedAtSeconds);
    } else {
      const parsed = parseFelt(body.credentialId, "credentialId");
      if ("error" in parsed) return badRequest(reply, parsed.error);
      credentialId = parsed.value;
      if (store.find(credentialId)) {
        reply.code(409);
        return { error: "conflict", message: `credential ${credentialId} has already been issued` };
      }
    }

    const expiresAt = issuedAtSeconds + validity;

    if (spec.evidence === "operator-attestation") {
      if (spec.requiresAdmin && !authorised(request, config)) {
        reply.code(401);
        return {
          error: "unauthorized",
          message:
            `a bearer admin token is required to attest '${spec.claim}': nothing about it can be ` +
            "screened, so the only thing standing behind it is the operator",
        };
      }
      const basis = typeof body.basis === "string" ? body.basis.trim() : "";
      if (basis === "") {
        return badRequest(
          reply,
          `basis is required for '${spec.claim}': this service checked no source, so the record ` +
            "has to say what the operator relied on or the credential is unauditable",
        );
      }

      const credential = attest(
        { subjectPublicKey: subject.value, credentialId, expiresAt, claim: spec.claim, basis },
        config.issuerId,
        config.issuerPrivateKey,
      );
      const attestedJson = toJson(credential);
      const at = new Date().toISOString();
      await store.add({
        credentialId,
        claim: spec.claim,
        credential: attestedJson,
        screenedAddress: null,
        screening: null,
        attestation: { evidence: "operator-attestation", basis, at },
        issuedAt: at,
        revokedAt: null,
        revocationReason: null,
      });

      reply.code(201);
      return {
        issued: true,
        claim: spec.claim,
        evidence: spec.evidence,
        credential: attestedJson,
        compact: encodeCredential(credential),
        screening: null,
        attestation: { evidence: "operator-attestation", basis, at },
        note: spec.description,
      };
    }

    const address = typeof body.address === "string" ? body.address.trim() : "";
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(address)) {
      return badRequest(
        reply,
        "address must be a 0x-prefixed Starknet address; it is screened against the OFAC lists " +
          "and is never written into the credential",
      );
    }

    const result = await screening.screen(address);
    const outcome = issue(
      { subjectPublicKey: subject.value, address, credentialId, expiresAt },
      result,
      config.issuerId,
      config.issuerPrivateKey,
    );

    if (!outcome.issued) {
      // A refusal is a record. Both kinds are kept: a listed address, and a screening that could
      // not run at all.
      await store.addRefusal({
        at: new Date().toISOString(),
        address,
        subjectPublicKey: subject.value,
        screening: outcome.screening,
      });
      reply.code(outcome.status);
      return {
        issued: false,
        error: outcome.status === 403 ? "sanctioned" : "unavailable",
        message: outcome.reason,
        screening: outcome.screening,
      };
    }

    const json = toJson(outcome.credential);
    await store.add({
      credentialId,
      claim: NOT_SANCTIONED,
      credential: json,
      screenedAddress: address,
      screening: outcome.screening,
      attestation: null,
      issuedAt: new Date().toISOString(),
      revokedAt: null,
      revocationReason: null,
    });

    reply.code(201);
    return {
      issued: true,
      claim: NOT_SANCTIONED,
      evidence: spec.evidence,
      credential: json,
      /** The compact form, for a URL or a QR code. */
      compact: encodeCredential(outcome.credential),
      screening: outcome.screening,
      attestation: null,
    };
  });

  /** Everything this issuer has attested, newest first. */
  app.get("/credentials", async () => ({
    issuer: identity.issuerId,
    count: store.list().length,
    credentials: store.list(),
  }));

  /** Every screening that ended in a refusal, newest first. */
  app.get("/refusals", async () => ({
    count: store.refusals().length,
    refusals: store.refusals(),
  }));

  /** One credential by id. */
  app.get<{ Params: { id: string } }>("/credentials/:id", async (request, reply) => {
    const parsed = parseFelt(request.params.id, "id");
    if ("error" in parsed) return badRequest(reply, parsed.error);
    const record = store.find(parsed.value);
    if (!record) {
      reply.code(404);
      return { error: "not_found", message: `no credential ${parsed.value}` };
    }
    return record;
  });

  /**
   * Withdraw a credential.
   *
   * This records the issuer's decision. It does not, on its own, stop the credential settling: the
   * gate reads the on-chain `RevocationRegistry`, so the operator still has to call `revoke` there.
   * The response says so rather than implying the credential is already dead everywhere.
   */
  app.post<{ Params: { id: string } }>("/credentials/:id/revoke", async (request, reply) => {
    if (!authorised(request, config)) {
      reply.code(401);
      return { error: "unauthorized", message: "a bearer admin token is required to revoke" };
    }
    const parsed = parseFelt(request.params.id, "id");
    if ("error" in parsed) return badRequest(reply, parsed.error);

    const body = (request.body ?? {}) as RevokeBody;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason === "") return badRequest(reply, "reason is required: a revocation without one is unauditable");

    const record = await store.revoke(parsed.value, reason, new Date().toISOString());
    if (!record) {
      reply.code(404);
      return {
        error: "not_found",
        message: `no unrevoked credential ${parsed.value}`,
      };
    }
    return {
      revoked: true,
      credential: record,
      onChain: {
        pending: true,
        message:
          "Recorded here. The gate reads the on-chain RevocationRegistry, so call " +
          `revoke(${identity.issuerId}, ${parsed.value}) there to make this bite` +
          (identity.operator === ""
            ? ", from the address registered as this issuer's operator."
            : `, from the operator address ${identity.operator}.`),
      },
    };
  });

  /** Force a refresh of the sanctions snapshot. */
  app.post("/ofac/refresh", async (request, reply) => {
    if (!authorised(request, config)) {
      reply.code(401);
      return { error: "unauthorized", message: "a bearer admin token is required to refresh" };
    }
    try {
      await screening.refresh();
      return { refreshed: true, ofac: screening.status() };
    } catch (error) {
      reply.code(503);
      return {
        refreshed: false,
        error: "unavailable",
        message: error instanceof Error ? error.message : String(error),
        ofac: screening.status(),
      };
    }
  });

  return app;
}

function parseFelt(value: unknown, field: string): { value: Felt } | { error: string } {
  if (typeof value !== "string" || value.trim() === "") {
    return { error: `${field} is required and must be a 0x-prefixed field element` };
  }
  const text = value.trim();
  if (!isFelt(text)) {
    return { error: `${field} must be a 0x-prefixed field element, got ${JSON.stringify(value)}` };
  }
  return { value: toFelt(text) };
}

function badRequest(reply: FastifyReply, message: string): { error: string; message: string } {
  reply.code(400);
  return { error: "bad_request", message };
}

function authorised(request: FastifyRequest, config: Config): boolean {
  if (config.adminToken === "") return true;
  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  return token !== "" && timingSafeEquals(token, config.adminToken);
}

/** Constant-time string comparison, so a token cannot be guessed a character at a time. */
function timingSafeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}
