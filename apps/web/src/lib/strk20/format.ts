/** Display helpers shared by the app. Pure functions, no side effects. */

import { STRK_DECIMALS } from "./config";

/** Format a raw amount as a decimal string, trimming trailing zeros. */
export function formatUnits(amount: bigint, decimals: number = STRK_DECIMALS): string {
  const negative = amount < 0n;
  const value = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  const text = fraction ? `${whole}.${fraction}` : `${whole}`;
  return negative ? `-${text}` : text;
}

/** Parse a decimal string into a raw amount. Throws on anything malformed. */
export function parseUnits(text: string, decimals: number = STRK_DECIMALS): bigint {
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new TypeError(`"${text}" is not a positive decimal amount`);
  }
  const [whole = "0", fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) {
    throw new RangeError(`at most ${decimals} decimal places are representable`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** Shorten a hex string for display: 0x1dc5a1c…1927a. */
export function shortHex(value: string, lead = 6, tail = 4): string {
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}
