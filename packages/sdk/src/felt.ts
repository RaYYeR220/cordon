/**
 * Field elements, and the one place that decides how a JavaScript value becomes one.
 *
 * Everything Cordon hashes, signs and sends on chain is a `felt252`. The conversion rules live
 * here rather than being re-derived at each call site, because a value that converts differently
 * in two places produces a hash that differs from the contract's, and the only symptom on chain is
 * an unexplained `CORDON_BAD_CRED`.
 */

import { num, shortString } from "starknet";

/** A field element as a 0x-prefixed, lower-case hex string with no leading zeros. */
export type Felt = string;

/** A contract address, in the same normalised hex form as {@link Felt}. */
export type Address = string;

/**
 * Anything this SDK accepts where a `felt252` is required.
 *
 * Strings are interpreted by {@link toFelt}: `0x…` is hex, all-digits is decimal, and anything
 * else is a Cairo short string. See that function for the exact rules.
 */
export type FeltLike = string | number | bigint;

/** The Starknet prime, `2^251 + 17 * 2^192 + 1`. Every felt is taken modulo nothing — it must fit. */
export const FIELD_PRIME = 0x800000000000011000000000000000000000000000000000000000000000001n;

/** The largest value a `u128` can hold, used to range-check amounts before they are widened. */
export const U128_MAX = (1n << 128n) - 1n;

/** The largest value a `u64` can hold, used to range-check timestamps and epoch lengths. */
export const U64_MAX = (1n << 64n) - 1n;

const HEX = /^0x[0-9a-fA-F]+$/;
const DECIMAL = /^[0-9]+$/;

/** Thrown when a value cannot be represented as a field element. */
export class FeltError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "FeltError";
  }
}

/**
 * Convert a value to its canonical felt form.
 *
 * The rules, in order:
 *
 * | Input | Read as |
 * | --- | --- |
 * | `bigint`, `number` | the integer itself |
 * | `"0x…"` | hexadecimal |
 * | `"12345"` (digits only) | decimal |
 * | `"ACCREDITED"` | a Cairo short string, ASCII big-endian |
 *
 * The short-string fallback is what lets a caller write `claim: "ACCREDITED"` and get the same
 * felt the Cairo source writes as `'ACCREDITED'`. Its cost is that a decimal-looking label such as
 * `"2024"` is read as the number 2024; pass {@link shortStringToFelt} explicitly when the
 * distinction matters.
 */
export function toFelt(value: FeltLike): Felt {
  if (typeof value === "bigint") return fromBigInt(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new FeltError(`felt must be a safe integer, got ${value}`);
    }
    return fromBigInt(BigInt(value));
  }
  if (typeof value !== "string") {
    throw new FeltError(`felt must be a string, number or bigint, got ${typeof value}`);
  }
  const text = value.trim();
  if (text.length === 0) throw new FeltError("felt must not be an empty string");
  if (HEX.test(text)) return fromBigInt(BigInt(text));
  if (DECIMAL.test(text)) return fromBigInt(BigInt(text));
  return shortStringToFelt(text);
}

/** Convert a felt-like value to a `bigint`. */
export function toBigInt(value: FeltLike): bigint {
  return BigInt(toFelt(value));
}

function fromBigInt(value: bigint): Felt {
  if (value < 0n) throw new FeltError(`felt must not be negative, got ${value}`);
  if (value >= FIELD_PRIME) {
    throw new FeltError(`felt must be below the Starknet prime, got ${value}`);
  }
  return num.toHex(value);
}

/**
 * Encode a Cairo short string: up to 31 ASCII characters, read big-endian as an integer.
 *
 * This is what `'ACCREDITED'` means in a Cairo source file. Claims, issuer ids, policy ids and
 * nonces are all short strings by convention, which is what makes a Cordon event log readable.
 */
export function shortStringToFelt(text: string): Felt {
  if (text.length > 31) {
    throw new FeltError(
      `a Cairo short string holds at most 31 characters, got ${text.length}: ${JSON.stringify(text)}`,
    );
  }
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code > 0x7f) {
      throw new FeltError(
        `a Cairo short string is ASCII only; ${JSON.stringify(character)} is not encodable`,
      );
    }
  }
  return num.toHex(BigInt(shortString.encodeShortString(text)));
}

/**
 * Decode a felt back to a short string, or return `null` when the bytes are not printable ASCII.
 *
 * Used for display: a policy id reads better as `PAY_ACCREDITED_V1` than as a 34-digit number, but
 * a subject public key must never be rendered as mojibake, so this refuses rather than guesses.
 */
export function feltToShortString(value: FeltLike): string | null {
  const asBigInt = toBigInt(value);
  if (asBigInt === 0n) return "";
  let hex = asBigInt.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  if (hex.length > 62) return null;
  let text = "";
  for (let index = 0; index < hex.length; index += 2) {
    const code = Number.parseInt(hex.slice(index, index + 2), 16);
    // Printable ASCII only. Control characters mean this felt was never a string.
    if (code < 0x20 || code > 0x7e) return null;
    text += String.fromCharCode(code);
  }
  return text;
}

/** Whether a string is already a well-formed hex felt. */
export function isFelt(value: unknown): value is Felt {
  if (typeof value !== "string" || !HEX.test(value)) return false;
  return BigInt(value) < FIELD_PRIME;
}

/**
 * Normalise a contract address.
 *
 * Stricter than {@link toFelt}: an address must be hex, so a typo cannot be silently reinterpreted
 * as a short string and hashed into a signature nobody can explain.
 */
export function toAddress(value: string, label = "address"): Address {
  const text = value.trim();
  if (!HEX.test(text)) {
    throw new FeltError(`${label} must be 0x-prefixed hex, got ${JSON.stringify(value)}`);
  }
  return fromBigInt(BigInt(text));
}

/** Range-check a `u128` (a token amount) and return it as a felt. */
export function toU128Felt(value: FeltLike, label = "amount"): Felt {
  const asBigInt = toBigInt(value);
  if (asBigInt > U128_MAX) throw new FeltError(`${label} does not fit in a u128: ${asBigInt}`);
  return num.toHex(asBigInt);
}

/** Range-check a `u64` (a unix timestamp or an epoch length) and return it as a felt. */
export function toU64Felt(value: FeltLike, label = "value"): Felt {
  const asBigInt = toBigInt(value);
  if (asBigInt > U64_MAX) throw new FeltError(`${label} does not fit in a u64: ${asBigInt}`);
  return num.toHex(asBigInt);
}

/** Left-pad a felt to the 64 hex characters a 32-byte wire encoding needs. */
export function padFelt(value: FeltLike): string {
  return toBigInt(value).toString(16).padStart(64, "0");
}

/** Whether two felt-like values denote the same field element, whatever form they arrived in. */
export function feltEquals(a: FeltLike, b: FeltLike): boolean {
  return toBigInt(a) === toBigInt(b);
}
