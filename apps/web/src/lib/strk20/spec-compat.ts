/**
 * Compile-time proof that the action types declared in `types.ts` are exactly
 * the shapes the wallet API accepts.
 *
 * `types.ts` declares them by hand so the layer stays readable and portable, but
 * a divergence from the spec would only show up as a rejected transaction in a
 * user's wallet. These assertions turn that into a build failure instead.
 */

import type { STRK20_ACTION } from "starknet";

import type { Strk20Action } from "./types";

type Assert<T extends true> = T;
type Assignable<From, To> = [From] extends [To] ? true : false;

/** Every action we build is a valid wallet-API action. */
export type ActionsMatchSpec = Assert<Assignable<Strk20Action, STRK20_ACTION>>;

/**
 * Every non-shadow-account wallet-API action has a local counterpart, so the
 * builders cover the whole surface this app uses. Shadow accounts are excluded
 * deliberately: they are not usable on mainnet.
 */
export type SpecCoveredByLocal = Assert<
  Assignable<Exclude<STRK20_ACTION, { type: "shadow_account_invoke" }>, Strk20Action>
>;
