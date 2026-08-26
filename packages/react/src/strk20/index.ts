/**
 * The STRK20 chain layer: wallets, capability, balances, contract reads, gate events, submission.
 *
 * UI-free and framework-free. Everything here is plain TypeScript over `@cordon/sdk`, Starknet.js
 * and the get-starknet wallet-standard registry — nothing in this directory may import React or
 * reach for component state. It is published as `@cordon/react/strk20` so an app that wants the
 * plumbing without the hooks, or a non-React app entirely, can take just this half.
 */

export * from "./types.js";
export type * from "./spec-compat.js";
export * from "./config.js";
export * from "./errors.js";
export * from "./balances.js";
export * from "./wallet.js";
export * from "./capability.js";
export * from "./client.js";
export * from "./registries.js";
export * from "./events.js";
export * from "./format.js";
