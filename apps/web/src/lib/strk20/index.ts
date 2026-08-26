/**
 * The STRK20 wallet layer.
 *
 * UI-free and framework-free: everything here is plain TypeScript over
 * Starknet.js and the get-starknet wallet-standard registry. It is the seed of
 * the package Cordon publishes, so nothing in it may import React or reach for
 * app state.
 */

export * from "./types";
export type * from "./spec-compat";
export * from "./config";
export * from "./errors";
export * from "./actions";
export * from "./balances";
export * from "./wallet";
export * from "./capability";
export * from "./client";
export * from "./format";
