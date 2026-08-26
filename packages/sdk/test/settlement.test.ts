import { describe, expect, it } from "vitest";
import {
  SETTLEMENT_STATUS_VARIANT,
  SettlementError,
  settlementCalldata,
  settlementFromCalldata,
  settlementOptions,
  settlementStatusFromFelt,
  type Settlement,
} from "../src/index.js";
import { STRK } from "./fixtures.js";

const EXPIRES_AT = 1_800_086_400;

const funded: Settlement = {
  token: STRK,
  amount: 400n,
  payerSubjectKey: "0x1ce8adcb0d0e5e0d0a3e2b8b8f9e5c3b2a1908070605040302010f0e0d0c0b0",
  payerPolicyId: "0x5041595f414343524544495445445f5631",
  payeeClaimPolicyId: "0x5041595f4b59435f4c325f5631",
  expiresAt: EXPIRES_AT,
  status: "Funded",
};

describe("the settlement record", () => {
  it("keeps the four states the Cairo enum declares, in order", () => {
    expect(SETTLEMENT_STATUS_VARIANT).toEqual({ None: 0, Funded: 1, Claimed: 2, Refunded: 3 });
    expect(settlementStatusFromFelt(0)).toBe("None");
    expect(settlementStatusFromFelt(3)).toBe("Refunded");
  });

  it("refuses a status index the contract cannot produce", () => {
    expect(() => settlementStatusFromFelt(4)).toThrow(SettlementError);
  });

  it("round-trips through the seven felts get_settlement returns", () => {
    expect(settlementFromCalldata(settlementCalldata(funded))).toEqual({
      ...funded,
      token: `0x${BigInt(STRK).toString(16)}`,
    });
  });

  it("rejects a record of the wrong length instead of guessing", () => {
    expect(() => settlementFromCalldata(["0x1"])).toThrow(SettlementError);
  });
});

describe("what a settlement allows right now", () => {
  it("lets the payee claim while the window is open, and not the payer refund", () => {
    const options = settlementOptions(funded, EXPIRES_AT - 1);
    expect(options.claimable).toBe(true);
    expect(options.claimRefusal).toBeNull();
    expect(options.refundable).toBe(false);
    expect(options.refundRefusal?.code).toBe("CORDON_REFUND_TOO_EARLY");
    expect(options.secondsUntilExpiry).toBe(1);
  });

  it("swaps them once the window closes", () => {
    const options = settlementOptions(funded, EXPIRES_AT);
    expect(options.claimRefusal?.code).toBe("CORDON_CLAIM_EXPIRED");
    expect(options.refundable).toBe(true);
  });

  it("refuses both once it is claimed", () => {
    const options = settlementOptions({ ...funded, status: "Claimed" }, EXPIRES_AT - 1);
    expect(options.claimRefusal?.code).toBe("CORDON_ALREADY_CLAIMED");
    expect(options.refundRefusal?.code).toBe("CORDON_ALREADY_CLAIMED");
  });

  it("refuses both once it is refunded", () => {
    const options = settlementOptions({ ...funded, status: "Refunded" }, EXPIRES_AT + 1);
    expect(options.claimRefusal?.code).toBe("CORDON_ALREADY_REFUNDED");
    expect(options.refundRefusal?.code).toBe("CORDON_ALREADY_REFUNDED");
  });

  it("says nothing was ever funded under an unused id", () => {
    const options = settlementOptions({ ...funded, status: "None" }, EXPIRES_AT - 1);
    expect(options.claimRefusal?.code).toBe("CORDON_NO_SETTLEMENT");
    expect(options.refundRefusal?.code).toBe("CORDON_NO_SETTLEMENT");
  });
});
