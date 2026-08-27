/**
 * The STRK20 layer this app uses.
 *
 * Almost all of it now lives in `@cordon/react/strk20` — wallet discovery, the capability probe,
 * balance reads, contract reads, gate-event decoding, error normalisation and submission. It was
 * written here first and was always meant to be the package Cordon publishes, so it moved rather
 * than being forked; this app is now the package's first consumer, which is the only way to find
 * out whether the published surface is actually pleasant to use.
 *
 * What stays local is what cannot be published: reading this app's environment, and the four
 * demo action builders the debug console exercises.
 */

export * from "@cordon/react/strk20";
export * from "./actions";
export * from "./config";
