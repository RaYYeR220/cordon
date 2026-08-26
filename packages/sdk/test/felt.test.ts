import { describe, expect, it } from "vitest";
import {
  FIELD_PRIME,
  FeltError,
  feltEquals,
  feltToShortString,
  isFelt,
  padFelt,
  shortStringToFelt,
  toAddress,
  toBigInt,
  toFelt,
  toU128Felt,
  toU64Felt,
} from "../src/index.js";

describe("toFelt", () => {
  it("reads hex, decimal and short strings the way the docs say", () => {
    expect(toFelt("0x190")).toBe("0x190");
    expect(toFelt("400")).toBe("0x190");
    expect(toFelt(400)).toBe("0x190");
    expect(toFelt(400n)).toBe("0x190");
    expect(toFelt("ACCREDITED")).toBe("0x41434352454449544544");
  });

  it("normalises case and leading zeros so the same value has one form", () => {
    expect(toFelt("0x0000ABC")).toBe(toFelt("0xabc"));
  });

  it("refuses values outside the field", () => {
    expect(() => toFelt(-1n)).toThrow(FeltError);
    expect(() => toFelt(FIELD_PRIME)).toThrow(FeltError);
    expect(() => toFelt("")).toThrow(FeltError);
  });

  it("refuses a number that has already lost precision", () => {
    expect(() => toFelt(Number.MAX_SAFE_INTEGER + 2)).toThrow(FeltError);
  });
});

describe("short strings", () => {
  it("round-trips", () => {
    for (const text of ["ACCREDITED", "CORDON_KYC", "PAY_ACCREDITED_V1", "nonce_0", "SN_MAIN"]) {
      expect(feltToShortString(shortStringToFelt(text))).toBe(text);
    }
  });

  it("caps at the 31 characters a felt holds", () => {
    expect(() => shortStringToFelt("x".repeat(32))).toThrow(FeltError);
    expect(shortStringToFelt("x".repeat(31))).toBeTruthy();
  });

  it("refuses non-ASCII rather than encoding something the contract cannot read back", () => {
    expect(() => shortStringToFelt("café")).toThrow(FeltError);
  });

  it("answers null for a felt that was never a string", () => {
    expect(feltToShortString("0x1ce8adcb0d0e5e0d0a3e2b8b8f9e5c3b2a1908070605040302010f0e0d0c0b0"))
      .toBeNull();
  });

  it("treats zero as the empty string", () => {
    expect(feltToShortString(0)).toBe("");
  });
});

describe("range checks", () => {
  it("rejects a u128 overflow in an amount", () => {
    expect(() => toU128Felt(1n << 128n)).toThrow(FeltError);
    expect(toU128Felt((1n << 128n) - 1n)).toBeTruthy();
  });

  it("rejects a u64 overflow in a timestamp", () => {
    expect(() => toU64Felt(1n << 64n)).toThrow(FeltError);
  });
});

describe("addresses", () => {
  it("requires hex, so a typo cannot become a short string", () => {
    expect(() => toAddress("STRK")).toThrow(FeltError);
    expect(toAddress("0x04718f5a")).toBe("0x4718f5a");
  });
});

describe("helpers", () => {
  it("pads to 32 bytes", () => {
    expect(padFelt("0x1")).toHaveLength(64);
    expect(padFelt("0x1").endsWith("1")).toBe(true);
  });

  it("compares across representations", () => {
    expect(feltEquals("400", 400n)).toBe(true);
    expect(feltEquals("ACCREDITED", "0x41434352454449544544")).toBe(true);
    expect(feltEquals("ACCREDITED", "KYC_L2")).toBe(false);
  });

  it("recognises well-formed felts", () => {
    expect(isFelt("0x190")).toBe(true);
    expect(isFelt("190")).toBe(false);
    expect(isFelt(`0x${FIELD_PRIME.toString(16)}`)).toBe(false);
  });

  it("converts to bigint", () => {
    expect(toBigInt("ACCREDITED")).toBe(0x41434352454449544544n);
  });
});
