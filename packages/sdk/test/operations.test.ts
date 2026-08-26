/**
 * Calldata and action arrays.
 *
 * Two things go wrong here in practice and both are silent. A placeholder that gets hex-encoded
 * becomes an address nobody owns, and the gate refuses with `CORDON_BAD_POOL`. A field in the
 * wrong position shifts everything after it, and the gate refuses with something that looks like a
 * signature problem. So these tests assert exact positions and exact literals, against the
 * argument order `contracts/src/interfaces.cairo` and the struct order `types.cairo` declare.
 */

import { describe, expect, it } from "vitest";
import {
  FUND_NOTE_ID,
  GATE_OPERATION_VARIANT,
  OPEN_NOTE,
  POOL_ADDRESS_PLACEHOLDER,
  assertValidActions,
  authorizeAction,
  buildClaimActions,
  buildDirectActions,
  buildFundActions,
  buildRefundActions,
  credentialCalldata,
  encodeClaimCalldata,
  encodeDirectCalldata,
  encodeFundCalldata,
  encodeGateOperation,
  encodeRefundCalldata,
  encodeSubjectAuthorization,
  isPlaceholder,
  issueCredential,
  openNoteIdPlaceholder,
  signAction,
  subjectPublicKey,
  validateActions,
  verifySubjectAction,
  type Strk20Action,
} from "../src/index.js";
import {
  CREDENTIAL_FIXTURE,
  FIXTURE_GATE,
  STRK,
  TEST_ISSUER_PRIVATE_KEY,
  TEST_SUBJECT_PRIVATE_KEY,
} from "./fixtures.js";

const PAYEE = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde";
const SETTLEMENT_ID = "SETTLE_1";
const SETTLEMENT_ID_FELT = "0x534554544c455f31";
const RESOLVED_NOTE_ID = "note_0";

const credential = issueCredential(CREDENTIAL_FIXTURE, TEST_ISSUER_PRIVATE_KEY);

const signingContext = {
  chainId: "SN_MAIN",
  gate: FIXTURE_GATE,
  token: STRK,
  amount: 400n,
} as const;

const payer = authorizeAction(
  {
    ...signingContext,
    policyId: "PAY_ACCREDITED_V1",
    noteId: RESOLVED_NOTE_ID,
    nonce: "nonce_0",
    credential,
  },
  TEST_SUBJECT_PRIVATE_KEY,
);

const fundPayer = authorizeAction(
  {
    ...signingContext,
    policyId: "PAY_ACCREDITED_V1",
    noteId: FUND_NOTE_ID,
    nonce: "nonce_1",
    credential,
  },
  TEST_SUBJECT_PRIVATE_KEY,
);

const payeeSignature = signAction(
  {
    ...signingContext,
    policyId: "PAY_KYC_L2_V1",
    noteId: RESOLVED_NOTE_ID,
    nonce: "nonce_2",
  },
  TEST_SUBJECT_PRIVATE_KEY,
);

const base = { gate: FIXTURE_GATE, token: STRK } as const;
const direct = { ...base, amount: 400n, payee: PAYEE, payer };
const fund = {
  ...base,
  amount: 400n,
  payer: fundPayer,
  settlementId: SETTLEMENT_ID,
  payeeClaimPolicyId: "PAY_KYC_L2_V1",
  expiresAt: 1_800_086_400,
};
const claim = {
  ...base,
  settlementId: SETTLEMENT_ID,
  credential,
  signature: payeeSignature,
  nonce: "nonce_2",
  recipient: PAYEE,
};
const refund = {
  ...base,
  settlementId: SETTLEMENT_ID,
  signature: payeeSignature,
  nonce: "nonce_3",
  recipient: PAYEE,
};

describe("signing an authorisation", () => {
  it("produces a signature the gate's own check would accept", () => {
    expect(
      verifySubjectAction(
        {
          chainId: "SN_MAIN",
          gateAddress: FIXTURE_GATE,
          policyId: "PAY_ACCREDITED_V1",
          noteId: RESOLVED_NOTE_ID,
          token: STRK,
          amount: 400n,
          nonce: "nonce_0",
        },
        subjectPublicKey(TEST_SUBJECT_PRIVATE_KEY),
        payer.signature,
      ),
    ).toBe(true);
  });

  it("packages the policy, credential, signature and nonce the contract expects", () => {
    expect(payer.policyId).toBe("0x5041595f414343524544495445445f5631");
    expect(payer.nonce).toBe("0x6e6f6e63655f30");
    expect(payer.credential).toEqual(credential);
  });

  it("signs zero as the note id on a Fund, which reserves no note", () => {
    expect(FUND_NOTE_ID).toBe("0x0");
    expect(fundPayer.signature).not.toEqual(payer.signature);
  });
});

describe("operation encoding", () => {
  it("numbers the variants in the order the Cairo enum declares them", () => {
    expect(GATE_OPERATION_VARIANT).toEqual({ Direct: 0, Fund: 1, Claim: 2, Refund: 3 });
  });

  it("encodes a subject authorisation as eleven felts in struct order", () => {
    expect(encodeSubjectAuthorization(payer)).toEqual([
      payer.policyId,
      ...credentialCalldata(credential),
      payer.signature.r,
      payer.signature.s,
      payer.nonce,
    ]);
    expect(encodeSubjectAuthorization(payer)).toHaveLength(11);
  });

  it("encodes Direct as its index and the payer's authorisation", () => {
    const felts = encodeGateOperation({ kind: "Direct", payer });
    expect(felts[0]).toBe("0x0");
    expect(felts.slice(1)).toEqual(encodeSubjectAuthorization(payer));
    expect(felts).toHaveLength(12);
  });

  it("encodes Fund as index, the payer's authorisation, then the escrow terms", () => {
    const felts = encodeGateOperation({
      kind: "Fund",
      payer: fundPayer,
      settlementId: SETTLEMENT_ID,
      payeeClaimPolicyId: "PAY_KYC_L2_V1",
      expiresAt: 1_800_086_400,
    });
    expect(felts[0]).toBe("0x1");
    expect(felts.slice(1, 12)).toEqual(encodeSubjectAuthorization(fundPayer));
    expect(felts.slice(12)).toEqual([
      SETTLEMENT_ID_FELT,
      "0x5041595f4b59435f4c325f5631",
      "0x6b4b2380",
    ]);
    expect(felts).toHaveLength(15);
  });

  it("encodes Claim with the payee's credential inline and no policy id", () => {
    const felts = encodeGateOperation({
      kind: "Claim",
      settlementId: SETTLEMENT_ID,
      credential,
      signature: payeeSignature,
      nonce: "nonce_2",
    });
    expect(felts[0]).toBe("0x2");
    expect(felts[1]).toBe(SETTLEMENT_ID_FELT);
    expect(felts.slice(2, 9)).toEqual(credentialCalldata(credential));
    expect(felts.slice(9)).toEqual([payeeSignature.r, payeeSignature.s, "0x6e6f6e63655f32"]);
    expect(felts).toHaveLength(12);
  });

  it("encodes Refund as index, settlement, signature and nonce, with no credential", () => {
    const felts = encodeGateOperation({
      kind: "Refund",
      settlementId: SETTLEMENT_ID,
      signature: payeeSignature,
      nonce: "nonce_3",
    });
    expect(felts).toEqual([
      "0x3",
      SETTLEMENT_ID_FELT,
      payeeSignature.r,
      payeeSignature.s,
      "0x6e6f6e63655f33",
    ]);
  });
});

describe("privacy_invoke calldata", () => {
  const calldata = encodeDirectCalldata(direct);

  it("lays the arguments out as (operation, token, pool_address, note_id)", () => {
    expect(calldata).toEqual([
      ...encodeGateOperation({ kind: "Direct", payer }),
      "0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
      POOL_ADDRESS_PLACEHOLDER,
      openNoteIdPlaceholder(0),
    ]);
  });

  it("passes the wallet placeholders through as literal strings", () => {
    expect(calldata.at(-2)).toBe("${poolAddress}");
    expect(calldata.at(-1)).toBe("${openNoteIds[0]}");
  });

  it("never hex-encodes a placeholder, whatever else it normalises", () => {
    for (const item of calldata) {
      if (isPlaceholder(item)) continue;
      expect(item).toMatch(/^0x[0-9a-f]+$/);
    }
  });

  it("sends zero as the note id on a Fund, matching what the payer signed", () => {
    expect(encodeFundCalldata(fund).at(-1)).toBe(FUND_NOTE_ID);
  });

  it("sends the open-note placeholder on a Claim and a Refund", () => {
    expect(encodeClaimCalldata(claim).at(-1)).toBe("${openNoteIds[0]}");
    expect(encodeRefundCalldata(refund).at(-1)).toBe("${openNoteIds[0]}");
  });

  it("can point at another open note when a transaction reserves several", () => {
    expect(encodeDirectCalldata({ ...direct, openNoteIndex: 2 }).at(-1)).toBe("${openNoteIds[2]}");
  });

  it("lets a test override the placeholders for a direct call against a mock pool", () => {
    const withPool = encodeDirectCalldata({ ...direct, poolAddress: "0xbeef", noteId: "0x7" });
    expect(withPool.at(-2)).toBe("0xbeef");
    expect(withPool.at(-1)).toBe("0x7");
  });
});

describe("action arrays", () => {
  it("builds Direct as withdraw, an open note, then invoke", () => {
    const actions = buildDirectActions(direct);
    expect(actions.map((action) => action.type)).toEqual(["withdraw", "transfer", "invoke"]);
    expect(actions[0]).toMatchObject({ amount: "0x190", recipient: normalize(FIXTURE_GATE) });
    expect(actions[1]).toMatchObject({ amount: OPEN_NOTE, recipient: normalize(PAYEE) });
    expect(actions[2]).toMatchObject({ contract: normalize(FIXTURE_GATE) });
    expect(calldataOf(actions[2])).toEqual(encodeDirectCalldata(direct));
  });

  it("builds Fund as withdraw then invoke, with no note to fill", () => {
    const actions = buildFundActions(fund);
    expect(actions.map((action) => action.type)).toEqual(["withdraw", "invoke"]);
    expect(calldataOf(actions[1])).toEqual(encodeFundCalldata(fund));
  });

  it("builds Claim as an open note then invoke, with no withdraw", () => {
    const actions = buildClaimActions(claim);
    expect(actions.map((action) => action.type)).toEqual(["transfer", "invoke"]);
    expect(actions[0]).toMatchObject({ amount: OPEN_NOTE, recipient: normalize(PAYEE) });
    expect(calldataOf(actions[1])).toEqual(encodeClaimCalldata(claim));
  });

  it("builds Refund the same shape as Claim, back to the payer", () => {
    const actions = buildRefundActions(refund);
    expect(actions.map((action) => action.type)).toEqual(["transfer", "invoke"]);
    expect(calldataOf(actions[1])).toEqual(encodeRefundCalldata(refund));
  });

  it("accepts all four arrays as valid STRK20 transactions", () => {
    for (const actions of [
      buildDirectActions(direct),
      buildFundActions(fund),
      buildClaimActions(claim),
      buildRefundActions(refund),
    ]) {
      expect(validateActions(actions)).toEqual([]);
      expect(() => assertValidActions(actions)).not.toThrow();
    }
  });
});

describe("action validation", () => {
  const invoke: Strk20Action = { type: "invoke", contract: "0x1", calldata: [] };

  it("rejects an empty array", () => {
    expect(validateActions([]).map((problem) => problem.code)).toEqual(["EMPTY"]);
  });

  it("rejects an invoke-only array, which the wallet answers with INVALID_REQUEST_PAYLOAD", () => {
    expect(validateActions([invoke]).map((problem) => problem.code)).toContain("INVOKE_ONLY");
  });

  it("rejects a second invoke", () => {
    const actions: Strk20Action[] = [
      { type: "withdraw", token: "0x1", amount: "0x1", recipient: "0x2" },
      invoke,
      invoke,
    ];
    expect(validateActions(actions).map((problem) => problem.code)).toContain("MULTIPLE_INVOKES");
  });

  it("rejects actions out of phase order", () => {
    const actions: Strk20Action[] = [
      { type: "transfer", token: "0x1", amount: "0x1", recipient: "0x2" },
      { type: "withdraw", token: "0x1", amount: "0x1", recipient: "0x2" },
      invoke,
    ];
    expect(validateActions(actions).map((problem) => problem.code)).toContain("PHASE_ORDER");
  });

  it("rejects an open note nothing fills", () => {
    const actions: Strk20Action[] = [
      { type: "transfer", token: "0x1", amount: OPEN_NOTE, recipient: "0x2" },
    ];
    expect(validateActions(actions).map((problem) => problem.code)).toContain(
      "OPEN_NOTE_WITHOUT_INVOKE",
    );
  });

  it("throws with every problem listed", () => {
    expect(() => assertValidActions([invoke])).toThrow(/INVOKE_ONLY/);
  });
});

function normalize(address: string): string {
  return `0x${BigInt(address).toString(16)}`;
}

function calldataOf(action: Strk20Action | undefined): unknown[] {
  return (action as { calldata: unknown[] }).calldata;
}
