/**
 * Refusal coverage.
 *
 * The point of the registry is that it is exhaustive: a UI that meets an undecoded panic code
 * shows a user "reverted" and nothing else, which is exactly the failure Cordon exists to fix. So
 * the first test here reads `contracts/src/errors.cairo` and insists every code declared there has
 * an entry.
 */

import { describe, expect, it } from "vitest";
import {
  allRefusals,
  decodeRefusal,
  decodeRefusalFromError,
  decodeRefusals,
  refusalCodes,
  refusalForCode,
  shortStringToFelt,
} from "../src/index.js";
import { readPanicCodes } from "./cairo-source.js";

const cairoCodes = readPanicCodes();

describe("coverage of contracts/src/errors.cairo", () => {
  it("finds panic codes to check against", () => {
    expect(cairoCodes.length).toBeGreaterThan(20);
  });

  it.each(cairoCodes)("decodes %s", (code) => {
    const refusal = refusalForCode(code);
    expect(refusal, `${code} is declared in errors.cairo but has no entry in refusals.ts`).toBeDefined();
    expect(refusal?.title.length).toBeGreaterThan(0);
    expect(refusal?.explanation.length).toBeGreaterThan(40);
  });

  it("has no entry for a code the contracts no longer raise", () => {
    const stale = refusalCodes().filter((code) => !cairoCodes.includes(code));
    expect(stale, `refusals.ts decodes codes errors.cairo does not declare: ${stale.join(", ")}`)
      .toEqual([]);
  });

  it("assigns every gate refusal a place in the enforcement order", () => {
    const gate = allRefusals().filter((refusal) => refusal.source === "gate");
    expect(gate.length).toBeGreaterThan(10);
    for (const refusal of gate) expect(refusal.step).toBeGreaterThan(0);
  });

  it("gives each refusal a remedy, so a UI can say who can fix it", () => {
    for (const refusal of allRefusals()) {
      expect(["payer", "issuer", "operator", "integrator"]).toContain(refusal.remedy);
    }
  });
});

describe("decoding a revert", () => {
  it("reads the short string a node printed", () => {
    expect(decodeRefusal("Transaction execution has failed: CORDON_OVER_CAP").code).toBe(
      "CORDON_OVER_CAP",
    );
  });

  it("reads the felt a node printed instead of the string", () => {
    const felt = shortStringToFelt("CORDON_OVER_VELOCITY");
    expect(decodeRefusal(`Failure reason: ${felt}`).code).toBe("CORDON_OVER_VELOCITY");
  });

  it("reads a felt with the leading zeros a node pads to 64 characters", () => {
    const padded = `0x${shortStringToFelt("CORDON_REVOKED").slice(2).padStart(64, "0")}`;
    expect(decodeRefusal(`Error at pc=0:81: ${padded}`).code).toBe("CORDON_REVOKED");
  });

  it("returns the first refusal when a trace carries several frames", () => {
    const trace = `outer ${shortStringToFelt("CORDON_BAD_CRED")} inner CORDON_EXPIRED`;
    expect(decodeRefusals(trace).map((refusal) => refusal.code)).toEqual([
      "CORDON_EXPIRED",
      "CORDON_BAD_CRED",
    ]);
  });

  it("does not repeat a code that appears in both forms", () => {
    const both = `CORDON_OVER_CAP ${shortStringToFelt("CORDON_OVER_CAP")}`;
    expect(decodeRefusals(both)).toHaveLength(1);
  });

  it("says plainly that a revert was not ours", () => {
    const refusal = decodeRefusal("ERC20: insufficient allowance");
    expect(refusal.code).toBe("UNKNOWN");
    expect(refusal.explanation).toContain("ERC20: insufficient allowance");
  });

  it("digs a reason out of a thrown wallet error", () => {
    const error = Object.assign(new Error("RPC error"), {
      data: {
        execution_error: `Error in contract: ${shortStringToFelt("CORDON_NONCE_USED")}`,
      },
    });
    expect(decodeRefusalFromError(error).code).toBe("CORDON_NONCE_USED");
  });

  it("digs a reason out of a nested cause", () => {
    const inner = new Error("reverted: CORDON_CLAIM_MISMATCH");
    const outer = new Error("transaction failed", { cause: inner });
    expect(decodeRefusalFromError(outer).code).toBe("CORDON_CLAIM_MISMATCH");
  });

  it("survives a cyclic error object", () => {
    const cyclic: Record<string, unknown> = { message: "CORDON_EXPIRED" };
    cyclic["self"] = cyclic;
    expect(decodeRefusalFromError(cyclic).code).toBe("CORDON_EXPIRED");
  });

  it("returns an unknown refusal for junk rather than throwing", () => {
    expect(decodeRefusalFromError(undefined).code).toBe("UNKNOWN");
    expect(decodeRefusalFromError(12345).code).toBe("UNKNOWN");
  });
});
