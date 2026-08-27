/**
 * Formatting for a public record.
 *
 * Two rules run through all of it. Numbers are grouped and always carry two
 * decimal places, so a column of them shares one decimal axis and tabular
 * figures can hold the alignment. And nothing here invents a value: a null
 * amount formats as the literal string `unavailable`, never as `0.00`.
 */

export const STRK_DECIMALS = 18;

const ONE_STRK = 10n ** BigInt(STRK_DECIMALS);

/** The string every unreadable value renders as. There is exactly one. */
export const UNAVAILABLE = "unavailable";

export function strk(amount: bigint): bigint {
  return amount * ONE_STRK;
}

/**
 * Base units to a grouped decimal string.
 *
 * Truncates rather than rounds: a cap of 5,000.00 must not display an amount of
 * 5,000.004 as being at the cap when the gate would refuse it.
 */
export function formatUnits(amount: bigint, decimals = STRK_DECIMALS, places = 2): string {
  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = magnitude / base;
  const scaled = (magnitude % base) / 10n ** BigInt(Math.max(0, decimals - places));

  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = places > 0 ? `.${scaled.toString().padStart(places, "0")}` : "";
  return `${negative ? "-" : ""}${grouped}${fraction}`;
}

/** The same, but an unreadable value says so instead of becoming a zero. */
export function formatUnitsOrUnavailable(amount: bigint | null | undefined): string {
  return amount === null || amount === undefined ? UNAVAILABLE : formatUnits(amount);
}

/** A plain integer with thousands separators. */
export function formatCount(value: number | bigint): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A percentage to one decimal place. */
export function formatPercent(numerator: bigint, denominator: bigint): string {
  if (denominator === 0n) return UNAVAILABLE;
  const tenths = (numerator * 1000n) / denominator;
  return `${(Number(tenths) / 10).toFixed(1)}`;
}

/** `0x06b3d9f1…a6c9e2b` — enough to recognise, too little to retype from memory. */
export function shorten(hex: string, lead = 8, tail = 7): string {
  if (hex.length <= lead + tail + 1) return hex;
  return `${hex.slice(0, lead)}…${hex.slice(-tail)}`;
}

/** `2026-08-26 14:42:07 UTC`, always UTC, always the same width. */
export function formatInstant(unixSeconds: number): string {
  const iso = new Date(unixSeconds * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

/** `14:42:07` */
export function formatClock(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(11, 19);
}

/** `2026-08-26` */
export function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/** `09h 17m 53s` — a duration a reader can check against a wall clock. */
export function formatDuration(seconds: number): string {
  if (seconds < 0) return "closed";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
}

/** Whole days, for a credential's remaining life. */
export function daysBetween(from: number, to: number): number {
  return Math.floor((to - from) / 86400);
}

/**
 * A percentage of a track, clamped so a bar can never escape its own figure.
 *
 * The clamp is at 100 and not beyond: a cordon line's job is to show the amount
 * crossing the boundary, and a track scaled to hold the overshoot always has
 * room for it.
 */
export function ratio(value: bigint, full: bigint): number {
  if (full <= 0n) return 0;
  const permille = Number((value * 10000n) / full) / 100;
  return Math.max(0, Math.min(100, permille));
}

export function percent(value: number): string {
  return `${value.toFixed(3)}%`;
}
