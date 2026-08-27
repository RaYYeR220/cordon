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

/** The pool user a live demo payment credits. */
export const LIVE_PAYEE = read(process.env.NEXT_PUBLIC_CORDON_PAYEE);
