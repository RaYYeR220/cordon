/**
 * The issuer service, as this console talks to it.
 *
 * A thin client and nothing more: it does not sign, it does not decide, and it holds no key. The
 * signing key belongs to the service — a browser is the wrong place for one — so the console's
 * whole job is to carry a pseudonym over and carry a credential back.
 *
 * Every failure is reported as itself. A service that is not configured, a service that is not
 * running, a service that refused, and a service that could not screen are four different
 * conditions with four different answers, and flattening them into "issuance failed" would leave
 * an operator guessing at exactly the moment they need to know.
 */

import type { CredentialJson } from "@cordon/sdk";

/** What one claim is worth, as the service describes it. */
export interface IssuerClaimSpec {
  claim: string;
  evidence: "ofac-screen" | "operator-attestation";
  requiresAdmin: boolean;
  description: string;
}

/** The issuer's public identity, from `GET /issuer`. */
export interface IssuerIdentity {
  issuerId: string;
  issuerName: string | null;
  publicKey: string;
  claims: IssuerClaimSpec[];
  metadataUri: string;
  operator: string;
  credentialValiditySeconds: number;
  sources: string[];
}

/** Whether the service can issue anything at all right now, from `GET /health`. */
export interface IssuerHealth {
  ok: boolean;
  issuedCount: number;
  refusalCount: number;
  ofac: {
    available: boolean;
    stale: boolean;
    ageSeconds: number | null;
    fetchedAt: string | null;
    addressCount: number | null;
    assets: string[];
    sources: { url: string; publishDate?: string | null; addressCount?: number }[];
  };
}

/** A credential the service signed, with whatever justified it. */
export interface IssuedCredential {
  issued: true;
  claim: string;
  evidence: IssuerClaimSpec["evidence"];
  credential: CredentialJson;
  /** The compact form: 268 characters, safe in a URL or a QR code. */
  compact: string;
  screening: { status: string; provenance?: { fetchedAt: string; addressCount: number } | null } | null;
  attestation: { evidence: string; basis: string; at: string } | null;
}

/**
 * Why an issuance did not happen.
 *
 * `kind` is what a UI should branch on, because the answers differ: an unconfigured console needs
 * an environment variable, an unreachable one needs the service started, a refusal needs a
 * different subject, and `unavailable` needs nothing but patience.
 */
export interface IssuerFailure {
  kind: "not-configured" | "unreachable" | "refused" | "unavailable" | "unauthorized" | "invalid";
  message: string;
  /** The HTTP status, when there was a response at all. */
  status: number | null;
  /** The service's own body, for anything a UI wants to show verbatim. */
  body: unknown;
}

export type IssuerResult<T> = { ok: true; value: T } | { ok: false; error: IssuerFailure };

const NOT_CONFIGURED: IssuerFailure = {
  kind: "not-configured",
  message:
    "No issuer service is configured for this build. Set NEXT_PUBLIC_CORDON_ISSUER_URL and run " +
    "services/issuer to issue from this console.",
  status: null,
  body: null,
};

async function request<T>(
  baseUrl: string | null,
  path: string,
  init?: RequestInit,
): Promise<IssuerResult<T>> {
  if (!baseUrl) return { ok: false, error: NOT_CONFIGURED };

  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: { accept: "application/json", ...(init?.headers ?? {}) },
    });
  } catch (cause) {
    return {
      ok: false,
      error: {
        kind: "unreachable",
        message:
          `${baseUrl} did not answer. Start the issuer service, and check that its ` +
          "ISSUER_ALLOWED_ORIGINS names this page's origin — a browser reports a blocked " +
          `cross-origin request and a stopped server identically. (${(cause as Error).message})`,
        status: null,
        body: null,
      },
    };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A non-JSON body is not fatal; the status still carries the answer.
  }

  if (response.ok) return { ok: true, value: body as T };

  const message =
    typeof body === "object" && body !== null && "message" in body
      ? String((body as { message: unknown }).message)
      : `${response.status} ${response.statusText}`;

  const kind: IssuerFailure["kind"] =
    response.status === 401
      ? "unauthorized"
      : response.status === 403
        ? "refused"
        : response.status === 503
          ? "unavailable"
          : "invalid";

  return { ok: false, error: { kind, message, status: response.status, body } };
}

/** Who the issuer is and what it will sign. */
export function fetchIssuerIdentity(baseUrl: string | null): Promise<IssuerResult<IssuerIdentity>> {
  return request<IssuerIdentity>(baseUrl, "/issuer");
}

/**
 * Whether the service can issue right now.
 *
 * `/health` answers 503 when the sanctions snapshot is too old to screen against, which is a
 * successful read of a bad state rather than a failed request — so the body is returned either
 * way and `ok` inside it is the thing to look at.
 */
export async function fetchIssuerHealth(
  baseUrl: string | null,
): Promise<IssuerResult<IssuerHealth>> {
  const result = await request<IssuerHealth>(baseUrl, "/health");
  if (result.ok) return result;
  if (result.error.status === 503 && result.error.body) {
    return { ok: true, value: result.error.body as IssuerHealth };
  }
  return result;
}

export interface IssueParams {
  subjectPublicKey: string;
  claim: string;
  /** The address to screen. Only used by a claim the service has a live source for. */
  address?: string;
  /** What the operator is relying on. Required for a claim nothing can be screened for. */
  basis?: string;
  /** Bearer token, when the service demands one. */
  adminToken?: string;
  validitySeconds?: number;
}

/** Ask the service to attest a pseudonym. */
export function issueCredentialRequest(
  baseUrl: string | null,
  params: IssueParams,
): Promise<IssuerResult<IssuedCredential>> {
  const { adminToken, ...body } = params;
  return request<IssuedCredential>(baseUrl, "/credentials", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
}
