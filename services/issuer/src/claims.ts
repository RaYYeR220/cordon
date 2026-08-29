/**
 * What this issuer will sign, and what stands behind each one.
 *
 * A credential is a signature over an assertion, and the only thing that makes it worth anything
 * is the evidence the issuer had when it signed. So the claim is not a free-text field: every
 * claim this service will attest is declared here together with the kind of evidence it rests on,
 * and the route that issues it behaves differently depending on which kind that is.
 *
 * Two kinds exist, and the difference is the whole point:
 *
 * - **`ofac-screen`** — the service has a live source it can check for itself. It fetches the
 *   OFAC lists, screens the address, and refuses when it cannot. Nobody has to be trusted beyond
 *   the U.S. Treasury and this code.
 * - **`operator-attestation`** — there is no automated source. `ACCREDITED` and `KYC_L2` are
 *   statements about a person that a human established somewhere else, and this service has no
 *   way to verify them. Pretending otherwise would be the exact failure the OFAC path is written
 *   to avoid, so an attested claim is admin-gated, records who asked for it and on what basis, and
 *   is stored with `evidence: "operator-attestation"` so the register never implies a screen that
 *   did not happen.
 *
 * Which attested claims a deployment may sign is configuration, not code: `ISSUER_ATTESTED_CLAIMS`
 * is empty by default, so a service brought up with only a signing key can still do nothing but
 * screen.
 */

/** Where the evidence behind a claim comes from. */
export type ClaimEvidence =
  /** The service checked a live public source itself. */
  | "ofac-screen"
  /** A human operator asserted it, and the record says so. */
  | "operator-attestation";

/** One claim this issuer will sign, and what backs it. */
export interface ClaimSpec {
  claim: string;
  evidence: ClaimEvidence;
  /** Whether the issuing route demands the admin bearer token. */
  requiresAdmin: boolean;
  /** One line for `GET /issuer`, so an integrator can see what a credential is worth. */
  description: string;
}

/** The one claim this service has a source of its own for. */
export const NOT_SANCTIONED = "NOT_SANCTIONED";

const SCREENED: ClaimSpec = {
  claim: NOT_SANCTIONED,
  evidence: "ofac-screen",
  requiresAdmin: false,
  description:
    "The address supplied was screened against the live U.S. Treasury OFAC lists and was not " +
    "listed. The screening, with its provenance, is stored against the credential.",
};

function attested(claim: string): ClaimSpec {
  return {
    claim,
    evidence: "operator-attestation",
    requiresAdmin: true,
    description:
      `Asserted by this issuer's operator. This service holds no source it can check for ` +
      `'${claim}', so nothing was screened: the credential is worth exactly what the operator's ` +
      `word is worth, and the basis they gave is stored against it.`,
  };
}

/**
 * The claims one deployment will sign.
 *
 * `NOT_SANCTIONED` is always present because the evidence for it is built in. Everything else has
 * to be named in the configuration, which is what stops a service quietly growing the authority to
 * assert things nobody checked.
 */
export function claimCatalogue(attestedClaims: readonly string[]): ClaimSpec[] {
  const specs: ClaimSpec[] = [SCREENED];
  for (const claim of attestedClaims) {
    if (claim === NOT_SANCTIONED) continue; // The screened path wins; it is strictly stronger.
    if (specs.some((spec) => spec.claim === claim)) continue;
    specs.push(attested(claim));
  }
  return specs;
}

/** The spec for one claim, or `undefined` when this deployment will not sign it. */
export function findClaim(catalogue: readonly ClaimSpec[], claim: string): ClaimSpec | undefined {
  return catalogue.find((spec) => spec.claim === claim);
}
