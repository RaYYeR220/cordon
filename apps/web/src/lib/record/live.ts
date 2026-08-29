/**
 * What live mode needs beyond the gate address.
 *
 * Next inlines `NEXT_PUBLIC_*` at build time, so these have to be literal
 * property reads rather than dynamic lookups. Anything unset stays null and the
 * screen that needs it says which precondition is missing — never a default
 * that would quietly settle against the wrong policy.
 */

function read(value: string | undefined): string | null {
  return value && value.trim() ? value.trim() : null;
}

/** The published policy the Pay screen settles under in live mode. */
export const LIVE_POLICY_ID = read(process.env.NEXT_PUBLIC_CORDON_POLICY_ID);

/** The policy a funded settlement's payee is judged against when they claim. */
export const LIVE_SETTLE_POLICY_ID = read(process.env.NEXT_PUBLIC_CORDON_SETTLE_POLICY_ID);

/** The policy the payee satisfies to take a funded settlement. */
export const LIVE_CLAIM_POLICY_ID = read(process.env.NEXT_PUBLIC_CORDON_CLAIM_POLICY_ID);

/** The pool user a live demo payment credits. */
export const LIVE_PAYEE = read(process.env.NEXT_PUBLIC_CORDON_PAYEE);

/**
 * Where the issuer service answers.
 *
 * Unset in the published build on purpose. The issuer holds a signing key and belongs on a host
 * its operator controls, not on a static page — so the console reads this, and says plainly that
 * issuance is unavailable when it is not set rather than pretending to a service that is not
 * there.
 */
export const LIVE_ISSUER_URL = read(process.env.NEXT_PUBLIC_CORDON_ISSUER_URL);
