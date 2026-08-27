/**
 * The prepare-twice flow.
 *
 * The properties that matter, and that these tests hold to account:
 *
 * - the authorisation that gets submitted is bound to the note the transaction will actually fill;
 * - the throwaway first pass never escapes;
 * - a note that moves between the two prepares fails closed rather than paying the wrong party;
 * - a wallet that cannot resolve calldata is reported, never silently downgraded to `NOTE_ANY`.
 */

import { describe, expect, it, vi } from "vitest";
import {
  NOTE_ANY,
  NoteDriftError,
  NotePreparationError,
  encodeGateCalldata,
  issueCredential,
  prepareClaim,
  prepareDirect,
  prepareFund,
  prepareRefund,
  readResolvedNoteId,
  subjectPublicKey,
  toFelt,
  verifyHash,
  type PreparedInvoke,
  type Settlement,
  type Strk20Action,
  type Strk20Prepare,
} from "../src/index.js";
import {
  CREDENTIAL_FIXTURE,
  FIXTURE_CONTEXT,
  FIXTURE_PAYEE_KEY,
  RESOLVED_NOTE_ID,
  STRK,
  TEST_ISSUER_PRIVATE_KEY,
  TEST_SETTLEMENT_ID,
  TEST_SUBJECT_PRIVATE_KEY,
} from "./fixtures.js";

const PAYEE_ADDRESS = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde";
const SUBJECT_KEY = subjectPublicKey(TEST_SUBJECT_PRIVATE_KEY);

/** Await a promise that must reject, and hand back the error typed. */
async function rejection<TError>(promise: Promise<unknown>): Promise<TError> {
  try {
    await promise;
  } catch (caught) {
    return caught as TError;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

const payerCredential = issueCredential(CREDENTIAL_FIXTURE, TEST_ISSUER_PRIVATE_KEY);
const payeeCredential = issueCredential(
  { ...CREDENTIAL_FIXTURE, credentialId: "CRED_0002", subjectPublicKey: SUBJECT_KEY },
  TEST_ISSUER_PRIVATE_KEY,
);

const settlement: Settlement = {
  token: toFelt(STRK),
  amount: 400n,
  payerSubjectKey: SUBJECT_KEY,
  payeeSubjectKey: SUBJECT_KEY,
  payerPolicyId: toFelt("PAY_ACCREDITED_V1"),
  payeeClaimPolicyId: toFelt("RECV_KYC_L2_V1"),
  expiresAt: 1_800_007_200,
  status: "Funded",
};

/**
 * A wallet that substitutes the open-note placeholder, the way a real one does.
 *
 * `noteIds` is consumed one per prepare, so a test can make the note move between passes.
 */
function walletPrepare(noteIds: string[] = [RESOLVED_NOTE_ID, RESOLVED_NOTE_ID]): {
  prepare: Strk20Prepare;
  calls: Strk20Action[][];
} {
  const calls: Strk20Action[][] = [];
  const remaining = [...noteIds];
  const prepare: Strk20Prepare = async (actions) => {
    calls.push(actions);
    const invoke = actions.find((action) => action.type === "invoke");
    if (invoke === undefined || invoke.type !== "invoke") throw new Error("no invoke action");
    const noteId = remaining.length > 1 ? (remaining.shift() as string) : (remaining[0] as string);
    return {
      call: {
        contractAddress: invoke.contract,
        entrypoint: "privacy_invoke",
        calldata: invoke.calldata.map((item) =>
          item === "${openNoteIds[0]}" ? toFelt(noteId) : item,
        ),
      },
      proof: { stub: true },
    };
  };
  return { prepare, calls };
}

const directParams = {
  context: FIXTURE_CONTEXT,
  token: STRK,
  policyId: "PAY_ACCREDITED_V1",
  credential: payerCredential,
  amount: 400n,
  payee: PAYEE_ADDRESS,
};

describe("prepareDirect", () => {
  it("prepares twice and binds the authorisation to the resolved note", async () => {
    const { prepare, calls } = walletPrepare();
    const result = await prepareDirect({ ...directParams, prepare }, TEST_SUBJECT_PRIVATE_KEY);

    expect(calls).toHaveLength(2);
    expect(result.noteId).toBe(toFelt(RESOLVED_NOTE_ID));
    expect(result.authorization.binding).toEqual({
      mode: "note",
      noteId: toFelt(RESOLVED_NOTE_ID),
      validUntil: 0,
    });
    expect(result.authorization.payer.noteBinding).toBe(toFelt(RESOLVED_NOTE_ID));
  });

  it("returns a signature that verifies over what it actually signed", async () => {
    const { prepare } = walletPrepare();
    const result = await prepareDirect({ ...directParams, prepare }, TEST_SUBJECT_PRIVATE_KEY);
    expect(
      verifyHash(result.authorization.actionHash, SUBJECT_KEY, result.authorization.payer.signature),
    ).toBe(true);
  });

  it("returns the second prepare's call and proof, not the probe's", async () => {
    const { prepare, calls } = walletPrepare();
    const result = await prepareDirect({ ...directParams, prepare }, TEST_SUBJECT_PRIVATE_KEY);

    expect(result.actions).toEqual(calls[1]);
    expect(result.actions).not.toEqual(calls[0]);
    expect(result.call.calldata.at(-1)).toBe(toFelt(RESOLVED_NOTE_ID));
    expect(result.proof).toEqual({ stub: true });
  });

  it("never lets the probe authorisation escape", async () => {
    const { prepare, calls } = walletPrepare();
    const result = await prepareDirect({ ...directParams, prepare }, TEST_SUBJECT_PRIVATE_KEY);

    // The probe is bound to a placeholder note and dated to the epoch, so even if it leaked it is
    // refused with CORDON_NOTE_MISMATCH or CORDON_AUTH_EXPIRED.
    const probeInvoke = calls[0]?.find((action) => action.type === "invoke");
    const probeCalldata = (probeInvoke as { calldata: string[] }).calldata;
    const realCalldata = encodeGateCalldata(result.authorization);
    expect(probeCalldata).not.toEqual(realCalldata);
    expect(probeCalldata).toContain("0x1");
  });

  it("submits calldata that still carries the placeholder for the wallet to substitute", async () => {
    const { prepare } = walletPrepare();
    const result = await prepareDirect({ ...directParams, prepare }, TEST_SUBJECT_PRIVATE_KEY);
    const invoke = result.actions.find((action) => action.type === "invoke");
    expect((invoke as { calldata: string[] }).calldata.at(-1)).toBe("${openNoteIds[0]}");
  });

  it("passes a deadline through when one is asked for", async () => {
    const { prepare } = walletPrepare();
    const result = await prepareDirect(
      { ...directParams, prepare, validUntil: 1_900_000_000 },
      TEST_SUBJECT_PRIVATE_KEY,
    );
    expect(result.authorization.binding.validUntil).toBe(1_900_000_000);
  });
});

describe("when the note moves between prepares", () => {
  it("fails closed rather than paying the wrong party", async () => {
    // Another transaction landed on the same channel and advanced the note index. The signed note
    // and the note this transaction would fill no longer agree.
    const other = "0x0aa1122334455667788990aabbccddeeff00112233445566778899aabbccdde";
    const { prepare } = walletPrepare([RESOLVED_NOTE_ID, other]);

    await expect(
      prepareDirect({ ...directParams, prepare }, TEST_SUBJECT_PRIVATE_KEY),
    ).rejects.toThrow(NoteDriftError);
  });

  it("reports both note ids so a caller can retry", async () => {
    const other = "0x0aa1122334455667788990aabbccddeeff00112233445566778899aabbccdde";
    const { prepare } = walletPrepare([RESOLVED_NOTE_ID, other]);

    const error = await rejection<NoteDriftError>(
      prepareDirect({ ...directParams, prepare }, TEST_SUBJECT_PRIVATE_KEY),
    );

    expect(error.signedNoteId).toBe(toFelt(RESOLVED_NOTE_ID));
    expect(error.preparedNoteId).toBe(toFelt(other));
    expect(error.message).toContain("CORDON_NOTE_MISMATCH");
  });
});

describe("when the wallet cannot resolve calldata", () => {
  const unresolving: Strk20Prepare = async (actions) => {
    const invoke = actions.find((action) => action.type === "invoke");
    return {
      call: {
        contractAddress: (invoke as { contract: string }).contract,
        calldata: (invoke as { calldata: string[] }).calldata,
      },
    };
  };

  it("reports it instead of quietly signing an unbound authorisation", async () => {
    await expect(
      prepareDirect({ ...directParams, prepare: unresolving }, TEST_SUBJECT_PRIVATE_KEY),
    ).rejects.toThrow(NotePreparationError);
  });

  it("names the placeholder and points at the explicit opt-in", async () => {
    const error = await rejection<NotePreparationError>(
      prepareDirect({ ...directParams, prepare: unresolving }, TEST_SUBJECT_PRIVATE_KEY),
    );

    expect(error.message).toContain("${openNoteIds[0]}");
    expect(error.message).toContain("does not resolve calldata");
  });

  it("does not fall back to NOTE_ANY", async () => {
    const attempted: string[] = [];
    const watching: Strk20Prepare = async (actions) => {
      const invoke = actions.find((action) => action.type === "invoke");
      attempted.push(...(invoke as { calldata: string[] }).calldata);
      return { call: { contractAddress: "0x1", calldata: [] } };
    };

    await expect(
      prepareDirect({ ...directParams, prepare: watching }, TEST_SUBJECT_PRIVATE_KEY),
    ).rejects.toThrow(NotePreparationError);
    expect(attempted).not.toContain(NOTE_ANY);
  });

  it("surfaces a prepare that throws, rather than degrading", async () => {
    const failing: Strk20Prepare = () => Promise.reject(new Error("wallet said no"));
    await expect(
      prepareDirect({ ...directParams, prepare: failing }, TEST_SUBJECT_PRIVATE_KEY),
    ).rejects.toThrow("wallet said no");
  });
});

describe("readResolvedNoteId", () => {
  const call = (calldata: unknown): PreparedInvoke =>
    ({ call: { contractAddress: "0x1", calldata } }) as PreparedInvoke;

  it("reads the last felt, which is where privacy_invoke puts the note id", () => {
    expect(readResolvedNoteId(call(["0x1", "0x2", toFelt(RESOLVED_NOTE_ID)]))).toBe(
      toFelt(RESOLVED_NOTE_ID),
    );
  });

  it("refuses an empty or missing calldata", () => {
    expect(() => readResolvedNoteId(call([]))).toThrow(/no calldata/);
    expect(() => readResolvedNoteId(call(undefined))).toThrow(NotePreparationError);
  });

  it("refuses an unsubstituted placeholder", () => {
    expect(() => readResolvedNoteId(call(["0x1", "${openNoteIds[0]}"]))).toThrow(
      /does not resolve calldata/,
    );
  });

  it("refuses the sentinel and zero, which are never resolved note ids", () => {
    expect(() => readResolvedNoteId(call(["0x1", NOTE_ANY]))).toThrow(/CORDON_NOTE_IS_SENTINEL/);
    expect(() => readResolvedNoteId(call(["0x1", "0x0"]))).toThrow(/zero/);
  });

  it("refuses a non-felt", () => {
    expect(() => readResolvedNoteId(call(["0x1", "banana"]))).toThrow(/not a field element/);
    expect(() => readResolvedNoteId(call(["0x1", 7]))).toThrow(/not a felt/);
  });
});

describe("prepareFund", () => {
  it("prepares once, because a funding leg fills no note", async () => {
    const { prepare, calls } = walletPrepare();
    const result = await prepareFund(
      {
        prepare,
        context: FIXTURE_CONTEXT,
        token: STRK,
        policyId: "PAY_ACCREDITED_V1",
        credential: payerCredential,
        amount: 400n,
        payeeSubjectKey: FIXTURE_PAYEE_KEY,
        payeeClaimPolicyId: "RECV_KYC_L2_V1",
        expiresAt: 1_800_007_200,
        settlementId: TEST_SETTLEMENT_ID,
      },
      TEST_SUBJECT_PRIVATE_KEY,
    );

    expect(calls).toHaveLength(1);
    expect(result.noteId).toBe("0x0");
    expect(result.authorization.payer.noteBinding).toBe("0x0");
    expect(result.actions.map((action) => action.type)).toEqual(["withdraw", "invoke"]);
  });
});

describe("prepareClaim and prepareRefund", () => {
  it("bind a claim to the payee's own resolved note", async () => {
    const { prepare, calls } = walletPrepare();
    const result = await prepareClaim(
      {
        prepare,
        context: FIXTURE_CONTEXT,
        settlement,
        settlementId: TEST_SETTLEMENT_ID,
        credential: payeeCredential,
        recipient: PAYEE_ADDRESS,
      },
      TEST_SUBJECT_PRIVATE_KEY,
    );

    expect(calls).toHaveLength(2);
    expect(result.authorization.leg).toBe("Claim");
    expect(result.authorization.binding).toEqual({
      mode: "note",
      noteId: toFelt(RESOLVED_NOTE_ID),
      validUntil: 0,
    });
    expect(result.actions.map((action) => action.type)).toEqual(["transfer", "invoke"]);
  });

  it("bind a refund to the payer's own resolved note", async () => {
    const { prepare } = walletPrepare();
    const result = await prepareRefund(
      {
        prepare,
        context: FIXTURE_CONTEXT,
        settlement,
        settlementId: TEST_SETTLEMENT_ID,
        recipient: PAYEE_ADDRESS,
      },
      TEST_SUBJECT_PRIVATE_KEY,
    );

    expect(result.authorization.leg).toBe("Refund");
    expect(result.noteId).toBe(toFelt(RESOLVED_NOTE_ID));
  });

  it("still refuses a claimant who is not the named payee, before any prepare", async () => {
    const prepare = vi.fn();
    await expect(
      prepareClaim(
        {
          prepare: prepare as unknown as Strk20Prepare,
          context: FIXTURE_CONTEXT,
          settlement: { ...settlement, payeeSubjectKey: FIXTURE_PAYEE_KEY },
          settlementId: TEST_SETTLEMENT_ID,
          credential: payeeCredential,
          recipient: PAYEE_ADDRESS,
        },
        TEST_SUBJECT_PRIVATE_KEY,
      ),
    ).rejects.toThrow(/CORDON_NOT_THE_PAYEE/);
    expect(prepare).not.toHaveBeenCalled();
  });
});
