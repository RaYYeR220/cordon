/**
 * Calldata, action arrays, and the invariants that make them safe.
 *
 * Three things go wrong here in practice and all three are silent. A placeholder that gets
 * hex-encoded becomes an address nobody owns, and the gate refuses with `CORDON_BAD_POOL`. A field
 * in the wrong position shifts everything after it, and the gate refuses with something that looks
 * like a signature problem. And an action array whose withdraw disagrees with the signed amount
 * either strands value as dust or reverts with `CORDON_UNDERFUNDED`.
 *
 * The first two are covered by asserting exact positions against `interfaces.cairo` and
 * `types.cairo`. The third is covered by the API shape — there is only one place to write an
 * amount — and the tests here hold that shape to account.
 */

import { describe, expect, it } from "vitest";
import {
  FUND_NOTE_ID,
  GATE_OPERATION_VARIANT,
  LEG_TAGS,
  OPEN_NOTE,
  OperationError,
  POOL_ADDRESS_PLACEHOLDER,
  SettlementError,
  assertValidActions,
  authorizeClaim,
  authorizeDirect,
  authorizeFund,
  authorizeRefund,
  buildActions,
  buildClaimActions,
  buildDirectActions,
  buildFundActions,
  buildRefundActions,
  credentialCalldata,
  encodeGateCalldata,
  encodeGateOperation,
  encodeSubjectAuthorization,
  bindToNote,
  isPlaceholder,
  issueCredential,
  openNoteIdPlaceholder,
  quotedSettlementHash,
  randomSettlementId,
  settlementTermsHash,
  subjectPublicKey,
  toFelt,
  validateActions,
  verifyHash,
  type Settlement,
  type Strk20Action,
} from "../src/index.js";
import {
  CREDENTIAL_FIXTURE,
  FIXTURE_CONTEXT,
  FIXTURE_GATE,
  FIXTURE_PAYEE_KEY,
  FIXTURE_POOL,
  STRK,
  TEST_ISSUER_PRIVATE_KEY,
  RESOLVED_NOTE_ID,
  TEST_SETTLEMENT_ID,
  TEST_SUBJECT_PRIVATE_KEY,
} from "./fixtures.js";

const PAYEE_ADDRESS = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde";
const SUBJECT_KEY = subjectPublicKey(TEST_SUBJECT_PRIVATE_KEY);

const payerCredential = issueCredential(CREDENTIAL_FIXTURE, TEST_ISSUER_PRIVATE_KEY);
const payeeCredential = issueCredential(
  { ...CREDENTIAL_FIXTURE, credentialId: "CRED_0002", subjectPublicKey: SUBJECT_KEY },
  TEST_ISSUER_PRIVATE_KEY,
);

const direct = authorizeDirect(
  {
    context: FIXTURE_CONTEXT,
    token: STRK,
    policyId: "PAY_ACCREDITED_V1",
    credential: payerCredential,
    amount: 400n,
    binding: bindToNote(RESOLVED_NOTE_ID),
    nonce: "nonce_0",
  },
  TEST_SUBJECT_PRIVATE_KEY,
);

const fund = authorizeFund(
  {
    context: FIXTURE_CONTEXT,
    token: STRK,
    policyId: "PAY_ACCREDITED_V1",
    credential: payerCredential,
    amount: 400n,
    payeeSubjectKey: FIXTURE_PAYEE_KEY,
    payeeClaimPolicyId: "RECV_KYC_L2_V1",
    expiresAt: 1_800_007_200,
    settlementId: TEST_SETTLEMENT_ID,
    nonce: "nonce_1",
  },
  TEST_SUBJECT_PRIVATE_KEY,
);

const settlement: Settlement = {
  token: toFelt(STRK),
  amount: 400n,
  payerSubjectKey: "0x1ce8adcb0d0e5e0d0a3e2b8b8f9e5c3b2a1908070605040302010f0e0d0c0b0",
  payeeSubjectKey: SUBJECT_KEY,
  payerPolicyId: toFelt("PAY_ACCREDITED_V1"),
  payeeClaimPolicyId: toFelt("RECV_KYC_L2_V1"),
  expiresAt: 1_800_007_200,
  status: "Funded",
};

const claim = authorizeClaim(
  {
    context: FIXTURE_CONTEXT,
    settlement,
    settlementId: TEST_SETTLEMENT_ID,
    credential: payeeCredential,
    binding: bindToNote(RESOLVED_NOTE_ID),
    nonce: "nonce_2",
  },
  TEST_SUBJECT_PRIVATE_KEY,
);

const refund = authorizeRefund(
  {
    context: FIXTURE_CONTEXT,
    settlement,
    settlementId: TEST_SETTLEMENT_ID,
    binding: bindToNote(RESOLVED_NOTE_ID),
    nonce: "nonce_3",
  },
  TEST_SUBJECT_PRIVATE_KEY,
);

describe("signing a leg", () => {
  it("produces a signature the gate's own check would accept", () => {
    expect(verifyHash(direct.actionHash, SUBJECT_KEY, direct.payer.signature)).toBe(true);
    expect(verifyHash(fund.actionHash, SUBJECT_KEY, fund.payer.signature)).toBe(true);
    expect(verifyHash(claim.actionHash, SUBJECT_KEY, claim.signature)).toBe(true);
    expect(verifyHash(refund.actionHash, SUBJECT_KEY, refund.signature)).toBe(true);
  });

  it("signs a different hash for every leg, so one cannot be replayed as another", () => {
    const hashes = new Set([
      direct.actionHash,
      fund.actionHash,
      claim.actionHash,
      refund.actionHash,
    ]);
    expect(hashes.size).toBe(4);
  });

  it("uses a literal zero terms hash on Direct and a real one everywhere else", () => {
    expect(direct.termsHash).toBe("0x0");
    expect(fund.termsHash).toBe(
      settlementTermsHash({
        settlementId: TEST_SETTLEMENT_ID,
        payeeSubjectKey: FIXTURE_PAYEE_KEY,
        payeeClaimPolicyId: "RECV_KYC_L2_V1",
        expiresAt: 1_800_007_200,
      }),
    );
    expect(claim.termsHash).toBe(quotedSettlementHash(TEST_SETTLEMENT_ID));
    expect(refund.termsHash).toBe(quotedSettlementHash(TEST_SETTLEMENT_ID));
    expect(claim.termsHash).not.toBe(fund.termsHash);
  });

  it("signs zero as the note binding on a Fund, which reserves no note", () => {
    expect(FUND_NOTE_ID).toBe("0x0");
    expect(fund.payer.noteBinding).toBe("0x0");
    expect(fund.binding).toEqual({ mode: "note", noteId: "0x0", validUntil: 0 });
  });

  it("binds Direct, Claim and Refund to the note they will fill", () => {
    for (const authorization of [direct, claim, refund]) {
      expect(authorization.binding).toEqual({
        mode: "note",
        noteId: toFelt(RESOLVED_NOTE_ID),
        validUntil: 0,
      });
    }
  });

  it("takes the claim's amount and policy from the stored settlement, not from the caller", () => {
    expect(claim.amount).toBe(settlement.amount);
    expect(refund.amount).toBe(settlement.amount);
  });

  it("refuses to sign a claim for someone who is not the named payee", () => {
    expect(() =>
      authorizeClaim(
        {
          context: FIXTURE_CONTEXT,
          settlement,
          settlementId: TEST_SETTLEMENT_ID,
          credential: payerCredential,
          binding: bindToNote(RESOLVED_NOTE_ID),
        },
        TEST_SUBJECT_PRIVATE_KEY,
      ),
    ).toThrow(OperationError);
  });

  it("refuses to fund without a named payee", () => {
    expect(() =>
      authorizeFund(
        {
          context: FIXTURE_CONTEXT,
          token: STRK,
          policyId: "PAY_ACCREDITED_V1",
          credential: payerCredential,
          amount: 400n,
          payeeSubjectKey: 0,
          payeeClaimPolicyId: "RECV_KYC_L2_V1",
          expiresAt: 1_800_007_200,
        },
        TEST_SUBJECT_PRIVATE_KEY,
      ),
    ).toThrow(/payee/);
  });

  it("refuses to sign a leg for zero", () => {
    expect(() =>
      authorizeDirect(
        {
          context: FIXTURE_CONTEXT,
          token: STRK,
          policyId: "PAY_ACCREDITED_V1",
          credential: payerCredential,
          amount: 0n,
          binding: bindToNote(RESOLVED_NOTE_ID),
        },
        TEST_SUBJECT_PRIVATE_KEY,
      ),
    ).toThrow(OperationError);
  });

  it("draws a fresh nonce when none is given", () => {
    const sign = (): string =>
      authorizeDirect(
        {
          context: FIXTURE_CONTEXT,
          token: STRK,
          policyId: "PAY_ACCREDITED_V1",
          credential: payerCredential,
          amount: 400n,
          binding: bindToNote(RESOLVED_NOTE_ID),
        },
        TEST_SUBJECT_PRIVATE_KEY,
      ).payer.nonce;
    expect(sign()).not.toBe(sign());
  });
});

describe("settlement ids", () => {
  it("generates one at random when the caller does not supply one", () => {
    const ids = new Set(
      Array.from({ length: 8 }, () =>
        authorizeFund(
          {
            context: FIXTURE_CONTEXT,
            token: STRK,
            policyId: "PAY_ACCREDITED_V1",
            credential: payerCredential,
            amount: 400n,
            payeeSubjectKey: FIXTURE_PAYEE_KEY,
            payeeClaimPolicyId: "RECV_KYC_L2_V1",
            expiresAt: 1_800_007_200,
          },
          TEST_SUBJECT_PRIVATE_KEY,
        ).settlementId,
      ),
    );
    expect(ids.size).toBe(8);
  });

  it("refuses a guessable id rather than documenting the risk", () => {
    // Funding is permissionless and ids are single-use forever, so an invoice number or a counter
    // can be burned ahead of the payer for the price of one unit — and it is the only handle in
    // the event log, so it is a correlation key too.
    const base = {
      context: FIXTURE_CONTEXT,
      token: STRK,
      policyId: "PAY_ACCREDITED_V1",
      credential: payerCredential,
      amount: 400n,
      payeeSubjectKey: FIXTURE_PAYEE_KEY,
      payeeClaimPolicyId: "RECV_KYC_L2_V1",
      expiresAt: 1_800_007_200,
    };
    for (const settlementId of ["INVOICE_42", 1, 0, "0xdeadbeef"]) {
      expect(() =>
        authorizeFund({ ...base, settlementId }, TEST_SUBJECT_PRIVATE_KEY),
      ).toThrow(SettlementError);
    }
  });

  it("draws 128 bits from the CSPRNG", () => {
    const id = randomSettlementId();
    expect(BigInt(id)).toBeGreaterThan(1n << 64n);
    expect(BigInt(id)).toBeLessThan(1n << 128n);
  });
});

describe("operation encoding", () => {
  it("numbers the variants in the order the Cairo enum declares them", () => {
    expect(GATE_OPERATION_VARIANT).toEqual({ Direct: 0, Fund: 1, Claim: 2, Refund: 3 });
  });

  it("encodes a subject authorisation as fourteen felts in struct order", () => {
    const felts = encodeSubjectAuthorization(direct.payer);
    expect(felts).toEqual([
      direct.payer.policyId,
      ...credentialCalldata(payerCredential),
      toFelt(RESOLVED_NOTE_ID),
      "0x0",
      "0x190",
      direct.payer.signature.r,
      direct.payer.signature.s,
      direct.payer.nonce,
    ]);
    expect(felts).toHaveLength(14);
    expect(felts[8]).toBe(toFelt(RESOLVED_NOTE_ID));
    expect(felts[9]).toBe("0x0");
    expect(felts[10]).toBe("0x190");
  });

  it("encodes Direct as its index and the payer's authorisation", () => {
    const felts = encodeGateOperation(direct);
    expect(felts[0]).toBe("0x0");
    expect(felts.slice(1)).toEqual(encodeSubjectAuthorization(direct.payer));
    expect(felts).toHaveLength(15);
  });

  it("encodes Fund as index, the payer's authorisation, then the escrow terms", () => {
    const felts = encodeGateOperation(fund);
    expect(felts[0]).toBe("0x1");
    expect(felts.slice(1, 15)).toEqual(encodeSubjectAuthorization(fund.payer));
    expect(felts.slice(15)).toEqual([
      toFelt(TEST_SETTLEMENT_ID),
      toFelt(FIXTURE_PAYEE_KEY),
      "0x524543565f4b59435f4c325f5631",
      "0x6b49ee20",
    ]);
    expect(felts).toHaveLength(19);
  });

  it("encodes Claim with the payee's credential inline and no policy id", () => {
    const felts = encodeGateOperation(claim);
    expect(felts[0]).toBe("0x2");
    expect(felts[1]).toBe(toFelt(TEST_SETTLEMENT_ID));
    expect(felts.slice(2, 9)).toEqual(credentialCalldata(payeeCredential));
    expect(felts.slice(9)).toEqual([
      toFelt(RESOLVED_NOTE_ID),
      "0x0",
      claim.signature.r,
      claim.signature.s,
      claim.nonce,
    ]);
    expect(felts).toHaveLength(14);
  });

  it("encodes Refund as index, settlement, signature and nonce, with no credential", () => {
    expect(encodeGateOperation(refund)).toEqual([
      "0x3",
      toFelt(TEST_SETTLEMENT_ID),
      toFelt(RESOLVED_NOTE_ID),
      "0x0",
      refund.signature.r,
      refund.signature.s,
      refund.nonce,
    ]);
  });
});

describe("privacy_invoke calldata", () => {
  const calldata = encodeGateCalldata(direct);

  it("lays the arguments out as (operation, token, pool_address, note_id)", () => {
    expect(calldata).toEqual([
      ...encodeGateOperation(direct),
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
    expect(encodeGateCalldata(fund).at(-1)).toBe(FUND_NOTE_ID);
  });

  it("sends the open-note placeholder on a Claim and a Refund", () => {
    expect(encodeGateCalldata(claim).at(-1)).toBe("${openNoteIds[0]}");
    expect(encodeGateCalldata(refund).at(-1)).toBe("${openNoteIds[0]}");
  });

  it("refuses a note id override that disagrees with what was signed", () => {
    // Sending a different note than the authorisation is bound to is CORDON_NOTE_MISMATCH on
    // chain. Catch it before the user pays for the transaction.
    expect(() => encodeGateCalldata(direct, { noteId: "0x9" })).toThrow(OperationError);
    expect(() => encodeGateCalldata(fund, { noteId: "0x1" })).toThrow(/note id must be zero/);
  });

  it("accepts a note id override that matches, for a call against a mock pool", () => {
    const withPool = encodeGateCalldata(direct, {
      poolAddress: "0xbeef",
      noteId: toFelt(RESOLVED_NOTE_ID),
    });
    expect(withPool.at(-2)).toBe("0xbeef");
    expect(withPool.at(-1)).toBe(toFelt(RESOLVED_NOTE_ID));
  });

  it("can point at another open note when a transaction reserves several", () => {
    expect(encodeGateCalldata(direct, { openNoteIndex: 2 }).at(-1)).toBe("${openNoteIds[2]}");
  });
});

describe("action arrays", () => {
  it("builds Direct as withdraw, an open note, then invoke", () => {
    const actions = buildDirectActions({ authorization: direct, payee: PAYEE_ADDRESS });
    expect(actions.map((action) => action.type)).toEqual(["withdraw", "transfer", "invoke"]);
    expect(actions[0]).toMatchObject({ amount: "0x190", recipient: normalize(FIXTURE_GATE) });
    expect(actions[1]).toMatchObject({ amount: OPEN_NOTE, recipient: normalize(PAYEE_ADDRESS) });
    expect(actions[2]).toMatchObject({ contract: normalize(FIXTURE_GATE) });
    expect(calldataOf(actions[2])).toEqual(encodeGateCalldata(direct));
  });

  it("builds Fund as withdraw then invoke, with no note to fill", () => {
    const actions = buildFundActions({ authorization: fund });
    expect(actions.map((action) => action.type)).toEqual(["withdraw", "invoke"]);
    expect(calldataOf(actions[1])).toEqual(encodeGateCalldata(fund));
  });

  it("builds Claim as an open note then invoke, with no withdraw", () => {
    const actions = buildClaimActions({ authorization: claim, recipient: PAYEE_ADDRESS });
    expect(actions.map((action) => action.type)).toEqual(["transfer", "invoke"]);
    expect(actions[0]).toMatchObject({ amount: OPEN_NOTE, recipient: normalize(PAYEE_ADDRESS) });
    expect(calldataOf(actions[1])).toEqual(encodeGateCalldata(claim));
  });

  it("builds Refund the same shape as Claim, back to the payer", () => {
    const actions = buildRefundActions({ authorization: refund, recipient: PAYEE_ADDRESS });
    expect(actions.map((action) => action.type)).toEqual(["transfer", "invoke"]);
    expect(calldataOf(actions[1])).toEqual(encodeGateCalldata(refund));
  });

  it("dispatches on the leg through one entry point", () => {
    expect(buildActions({ authorization: direct, payee: PAYEE_ADDRESS })).toEqual(
      buildDirectActions({ authorization: direct, payee: PAYEE_ADDRESS }),
    );
    expect(buildActions({ authorization: fund })).toEqual(buildFundActions({ authorization: fund }));
  });

  it("accepts all four arrays as valid STRK20 transactions", () => {
    for (const actions of [
      buildDirectActions({ authorization: direct, payee: PAYEE_ADDRESS }),
      buildFundActions({ authorization: fund }),
      buildClaimActions({ authorization: claim, recipient: PAYEE_ADDRESS }),
      buildRefundActions({ authorization: refund, recipient: PAYEE_ADDRESS }),
    ]) {
      expect(validateActions(actions)).toEqual([]);
      expect(() => assertValidActions(actions)).not.toThrow();
    }
  });
});

describe("the withdraw amount cannot disagree with the signed amount", () => {
  it("takes the withdraw amount from the authorisation, not from a second parameter", () => {
    // This is the structural guarantee, not a convention: there is no `amount` on any builder, so
    // there is nowhere for a second, different number to be written. Signing for less than is
    // withdrawn strands the difference as dust the payer cannot recover; signing for more reverts
    // with CORDON_UNDERFUNDED.
    const actions = buildDirectActions({ authorization: direct, payee: PAYEE_ADDRESS });
    const withdrawn = BigInt((actions[0] as { amount: string }).amount);
    const signed = direct.payer.amount;
    const encoded = BigInt(encodeSubjectAuthorization(direct.payer)[10] as string);

    expect(withdrawn).toBe(signed);
    expect(encoded).toBe(signed);
  });

  it("holds for a Fund too", () => {
    const actions = buildFundActions({ authorization: fund });
    expect(BigInt((actions[0] as { amount: string }).amount)).toBe(fund.payer.amount);
  });

  it("puts no withdraw in a Claim or a Refund, so no value can be stranded there", () => {
    for (const actions of [
      buildClaimActions({ authorization: claim, recipient: PAYEE_ADDRESS }),
      buildRefundActions({ authorization: refund, recipient: PAYEE_ADDRESS }),
    ]) {
      expect(actions.some((action) => action.type === "withdraw")).toBe(false);
    }
  });

  it("keeps the gate, the token and the pool in one place as well", () => {
    const actions = buildDirectActions({ authorization: direct, payee: PAYEE_ADDRESS });
    expect((actions[0] as { recipient: string }).recipient).toBe(normalize(FIXTURE_GATE));
    expect((actions[2] as { contract: string }).contract).toBe(normalize(FIXTURE_GATE));
    expect(direct.context.pool).toBe(normalize(FIXTURE_POOL));
    for (const action of actions) {
      expect((action as { token?: string }).token ?? normalize(STRK)).toBe(normalize(STRK));
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

describe("leg tags", () => {
  it("are short strings, so adding a variant cannot renumber them", () => {
    expect(LEG_TAGS.Direct).toBe("0x434f52444f4e5f4c45475f444952454354");
    expect(LEG_TAGS.Fund).toBe("0x434f52444f4e5f4c45475f46554e44");
    expect(LEG_TAGS.Claim).toBe("0x434f52444f4e5f4c45475f434c41494d");
    expect(LEG_TAGS.Refund).toBe("0x434f52444f4e5f4c45475f524546554e44");
  });
});

function normalize(address: string): string {
  return `0x${BigInt(address).toString(16)}`;
}

function calldataOf(action: Strk20Action | undefined): unknown[] {
  return (action as { calldata: unknown[] }).calldata;
}
