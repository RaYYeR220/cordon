/**
 * Compile-time proof that the action types this package passes to a wallet are exactly the shapes
 * the wallet API accepts.
 *
 * `@cordon/sdk` declares them by hand so it stays pure and portable, but a divergence from the
 * spec would only show up as a rejected transaction in a user's wallet. These assertions turn that
 * into a build failure instead.
 */

import type { STRK20_ACTION } from "starknet";

import type { Strk20Action } from "./types.js";

type Assert<T extends true> = T;
type Assignable<From, To> = [From] extends [To] ? true : false;

/** Every action built here is a valid wallet-API action. */
export type ActionsMatchSpec = Assert<Assignable<Strk20Action, STRK20_ACTION>>;

/**
 * Every non-shadow-account wallet-API action has a local counterpart, so the builders cover the
 * whole surface a gated payment uses. Shadow accounts are excluded deliberately: they are not
 * usable on mainnet.
 */
export type SpecCoveredByLocal = Assert<
  Assignable<Exclude<STRK20_ACTION, { type: "shadow_account_invoke" }>, Strk20Action>
>;
