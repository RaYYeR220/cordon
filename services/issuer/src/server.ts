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
import { NOT_SANCTIONED, defaultCredentialId, issue, issuerIdentity, toJson } from "./issuer.js";

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

  const identity = issuerIdentity({
    issuerId: config.issuerId,
    issuerPrivateKey: config.issuerPrivateKey,
    metadataUri: config.issuerMetadataUri,
    operator: config.issuerOperator,
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
   * Request a credential: screen the address, then sign or refuse.
   *
   * The address is screened and recorded but never enters the credential. What the chain sees is
   * the pseudonym, which is why a Cordon credential can be presented on chain without linking the
   * subject to the wallet that was screened.
   */
  app.post("/credentials", async (request, reply) => {
    const body = (request.body ?? {}) as CredentialRequestBody;

    const subject = parseFelt(body.subjectPublicKey, "subjectPublicKey");
    if ("error" in subject) return badRequest(reply, subject.error);

    const address = typeof body.address === "string" ? body.address.trim() : "";
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(address)) {
      return badRequest(
        reply,
        "address must be a 0x-prefixed Starknet address; it is screened against the OFAC lists " +
          "and is never written into the credential",
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

    const result = await screening.screen(address);
    const outcome = issue(
      { subjectPublicKey: subject.value, address, credentialId, expiresAt: issuedAtSeconds + validity },
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
      credential: json,
      screenedAddress: address,
      screening: outcome.screening,
      issuedAt: new Date().toISOString(),
      revokedAt: null,
      revocationReason: null,
    });

    reply.code(201);
    return {
      issued: true,
      claim: NOT_SANCTIONED,
      credential: json,
      /** The compact form, for a URL or a QR code. */
      compact: encodeCredential(outcome.credential),
      screening: outcome.screening,
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
