/**
 * Random field elements, from the platform CSPRNG.
 *
 * `crypto.getRandomValues` exists in browsers and in Node, which keeps this module — and so the
 * whole package — free of Node built-ins.
 */

import { toFelt, type Felt } from "./felt.js";

/**
 * A random felt with `byteLength` bytes of entropy.
 *
 * Never more than 31 bytes, so the result always fits the field without a modular reduction that
 * would skew the distribution.
 */
export function randomFelt(byteLength = 16): Felt {
  if (!Number.isInteger(byteLength) || byteLength < 8 || byteLength > 31) {
    throw new RangeError(`byteLength must be an integer between 8 and 31, got ${byteLength}`);
  }
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return toFelt(`0x${out}`);
}
