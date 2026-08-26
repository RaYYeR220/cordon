/** Display helpers. Pure functions, no side effects, no locale surprises. */

import { STRK_DECIMALS } from "./config.js";

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

/** Shorten a hex string for display: `0x1dc5a1c…1927a`. */
export function shortHex(value: string, lead = 6, tail = 4): string {
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

/** A duration in words, coarse on purpose: "in 3 days", "12 minutes ago". */
export function relativeTime(seconds: number): string {
  const abs = Math.abs(seconds);
  const scale: readonly [number, string] =
    abs >= 86400 ? [86400, "day"] : abs >= 3600 ? [3600, "hour"] : abs >= 60 ? [60, "minute"] : [1, "second"];
  const rounded = Math.max(1, Math.round(abs / scale[0]));
  const plural = rounded === 1 ? scale[1] : `${scale[1]}s`;
  return seconds >= 0 ? `in ${rounded} ${plural}` : `${rounded} ${plural} ago`;
}
