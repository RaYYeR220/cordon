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
  createGateContext,
  encodeGateCalldata,
  feltEquals,
  findGateInvokeCalldata,
  gateInvokeShape,
  issueCredential,
  prepareClaim,
  prepareDirect,
  prepareFund,
  prepareRefund,
  readResolvedNoteId,
  subjectPublicKey,
  toFelt,
  verifySubjectAction,
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
import {
  MAINNET_APPLY_ACTIONS_CALLDATA,
  MAINNET_GATE,
  MAINNET_GATE_INDEX,
  MAINNET_INVOKE_LENGTH,
  MAINNET_NOTE_ID,
  MAINNET_POOL,
  MAINNET_TOKEN,
} from "./fixtures/mainnet-calldata.js";

/** Stands in for the privacy pool's own contract address in the prepared-call envelope. */
const POOL_CONTRACT = "0x0777888999aaabbbcccdddeee000111222333444555666777888999aaabbbc";

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
 * A wallet that behaves like the real one: it substitutes the open-note placeholder and returns the
 * **pool's** transaction, with our invoke nested inside it.
 *
 * The envelope is what makes these tests meaningful. A stub that returned the bare invoke calldata
 * would pass against a reader that just takes the last felt, which is exactly the bug that shipped.
 * So this mirrors the mainnet shape: pool actions first, the gate address appearing twice as a
 * withdraw recipient before the real invoke, and a trailing felt after it.
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
    // A real wallet substitutes both placeholders; the mainnet fixture has the pool resolved at
    // index 103. A stub that left ${poolAddress} in place would not exercise the shape check.
    const resolved = invoke.calldata.map((item) => {
      if (item === "${openNoteIds[0]}") return toFelt(noteId);
      if (item === "${poolAddress}") return FIXTURE_CONTEXT.pool;
      return item;
    });
    return {
      call: {
        contractAddress: POOL_CONTRACT,
        entrypoint: "apply_actions",
        calldata: [
          // Pool actions, including the gate as a withdraw recipient — twice, as on mainnet.
          "0x2",
          toFelt(STRK),
          FIXTURE_CONTEXT.gate,
          toFelt(STRK),
          FIXTURE_CONTEXT.gate,
          toFelt(STRK),
          // The invoke: gate, length, then the calldata.
          FIXTURE_CONTEXT.gate,
          toFelt(resolved.length),
          ...resolved,
          // A trailing felt. Reading the end of the array lands here.
          "0x1",
        ],
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
    expect(result.proof).toEqual({ stub: true });

    // The note id is inside the nested invoke, not at the end of the prepared call.
    const found = findGateInvokeCalldata(
      { call: result.call },
      gateInvokeShape(result.authorization),
    );
    expect(found.calldata.at(-1)).toBe(toFelt(RESOLVED_NOTE_ID));
    expect(result.call.calldata.at(-1)).toBe("0x1");
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

  it("reports it as a preparation failure rather than a signature problem", async () => {
    const error = await rejection<NotePreparationError>(
      prepareDirect({ ...directParams, prepare: unresolving }, TEST_SUBJECT_PRIVATE_KEY),
    );

    expect(error.name).toBe("NotePreparationError");
    expect(error.prepared).toBeDefined();
    // An unresolving wallet leaves every placeholder in place, so the shape check catches it
    // before the note id is even reached. Either way the caller learns the prepared call is not
    // the transaction the SDK built.
    expect(error.message).toMatch(/could not find|does not resolve calldata/);
  });

  it("names the placeholder when only the note is left unsubstituted", async () => {
    const noteOnly: Strk20Prepare = async (actions) => {
      const invoke = actions.find((action) => action.type === "invoke");
      const calldata = (invoke as { calldata: string[] }).calldata.map((item) =>
        item === "${poolAddress}" ? FIXTURE_CONTEXT.pool : item,
      );
      return {
        call: {
          contractAddress: POOL_CONTRACT,
          calldata: [FIXTURE_CONTEXT.gate, toFelt(calldata.length), ...calldata, "0x1"],
        },
      };
    };

    const error = await rejection<NotePreparationError>(
      prepareDirect({ ...directParams, prepare: noteOnly }, TEST_SUBJECT_PRIVATE_KEY),
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

describe("readResolvedNoteId against real mainnet calldata", () => {
  // Ground truth: transaction 0x1c62fa64…f902db, a payment that reached a diagnostic gate and
  // succeeded. 111 felts, the invoke nested at index 85, the note id at 104, a stray 0x1 at 110.
  const prepared: PreparedInvoke = {
    call: {
      contractAddress: MAINNET_POOL,
      entrypoint: "apply_actions",
      calldata: [...MAINNET_APPLY_ACTIONS_CALLDATA],
    },
  };
  const shape = {
    gate: MAINNET_GATE,
    token: MAINNET_TOKEN,
    pool: MAINNET_POOL,
    calldataLength: MAINNET_INVOKE_LENGTH,
  };

  it("returns the note id the transaction actually filled", () => {
    expect(readResolvedNoteId(prepared, shape)).toBe(toFelt(MAINNET_NOTE_ID));
  });

  it("does not read from the end of the array, which is what the old reader did", () => {
    // The bug: the old reader took calldata[length - 1]. In this transaction the invoke ends at
    // index 104 and eleven more felts follow it, so the old reader picked up an unrelated one and
    // every payment was signed with a nonsense binding. The gate then refused it with
    // CORDON_NOTE_MISMATCH — the binding check working exactly as designed, on garbage input.
    const noteId = readResolvedNoteId(prepared, shape);
    const last = MAINNET_APPLY_ACTIONS_CALLDATA.at(-1) as string;

    expect(noteId).toBe(toFelt(MAINNET_NOTE_ID));
    expect(noteId).not.toBe(toFelt(last));
    // And the felt immediately after the invoke segment is the 0x1 that made the failure so
    // confusing to read in a calldata dump.
    expect(MAINNET_APPLY_ACTIONS_CALLDATA[105]).toBe("0x1");
  });

  it("locates the invoke by shape, not by the gate address alone", () => {
    // The gate appears three times in this transaction: twice as a withdraw recipient, once as the
    // invoked contract. Only the third is followed by a length of 18 with the token and pool in
    // the right places.
    const occurrences = MAINNET_APPLY_ACTIONS_CALLDATA.filter((felt) =>
      feltEquals(felt, MAINNET_GATE),
    );
    expect(occurrences).toHaveLength(3);

    const found = findGateInvokeCalldata(prepared, shape);
    expect(found.gateIndex).toBe(MAINNET_GATE_INDEX);
    expect(found.noteIdIndex).toBe(104);
    expect(found.calldata).toHaveLength(MAINNET_INVOKE_LENGTH);
    expect(found.calldata[0]).toBe("0x0");
    expect(found.calldata.at(-1)).toBe(MAINNET_NOTE_ID);
  });

  it("checks the token and the pool sit where privacy_invoke puts them", () => {
    expect(
      MAINNET_APPLY_ACTIONS_CALLDATA[102] === MAINNET_TOKEN &&
        MAINNET_APPLY_ACTIONS_CALLDATA[103] === MAINNET_POOL,
    ).toBe(true);

    for (const wrong of [
      { ...shape, token: "0xdead" },
      { ...shape, pool: "0xdead" },
      { ...shape, gate: "0xdead" },
      { ...shape, calldataLength: 17 },
    ]) {
      expect(() => readResolvedNoteId(prepared, wrong)).toThrow(NotePreparationError);
    }
  });

  it("refuses rather than guessing when the invoke is not there at all", () => {
    const truncated: PreparedInvoke = {
      call: {
        contractAddress: MAINNET_POOL,
        calldata: MAINNET_APPLY_ACTIONS_CALLDATA.slice(0, 80),
      },
    };
    expect(() => readResolvedNoteId(truncated, shape)).toThrow(/could not find/);
  });

  it("refuses when two segments match, rather than binding to one of them", () => {
    const doubled: PreparedInvoke = {
      call: {
        contractAddress: MAINNET_POOL,
        calldata: [
          ...MAINNET_APPLY_ACTIONS_CALLDATA,
          ...MAINNET_APPLY_ACTIONS_CALLDATA.slice(MAINNET_GATE_INDEX),
        ],
      },
    };
    expect(() => readResolvedNoteId(doubled, shape)).toThrow(/2 calldata segments/);
  });
});

describe("readResolvedNoteId", () => {
  const shape = {
    gate: FIXTURE_CONTEXT.gate,
    token: toFelt(STRK),
    pool: FIXTURE_CONTEXT.pool,
    calldataLength: 3,
  };
  const wrap = (invoke: unknown[]): PreparedInvoke =>
    ({
      call: {
        contractAddress: POOL_CONTRACT,
        calldata: ["0x9", FIXTURE_CONTEXT.gate, toFelt(3), ...invoke, "0x1"],
      },
    }) as PreparedInvoke;

  const good = [toFelt(STRK), FIXTURE_CONTEXT.pool, toFelt(RESOLVED_NOTE_ID)];

  it("reads the last felt of the invoke segment", () => {
    expect(readResolvedNoteId(wrap(good), shape)).toBe(toFelt(RESOLVED_NOTE_ID));
  });

  it("refuses an empty or missing calldata", () => {
    expect(() =>
      readResolvedNoteId({ call: { contractAddress: "0x1", calldata: [] } }, shape),
    ).toThrow(/no calldata/);
    expect(() =>
      readResolvedNoteId({ call: { contractAddress: "0x1" } } as PreparedInvoke, shape),
    ).toThrow(NotePreparationError);
  });

  it("refuses an unsubstituted placeholder", () => {
    const unresolved = [toFelt(STRK), FIXTURE_CONTEXT.pool, "${openNoteIds[0]}"];
    expect(() => readResolvedNoteId(wrap(unresolved), shape)).toThrow(/does not resolve calldata/);
  });

  it("refuses the sentinel and zero, which are never resolved note ids", () => {
    expect(() =>
      readResolvedNoteId(wrap([toFelt(STRK), FIXTURE_CONTEXT.pool, NOTE_ANY]), shape),
    ).toThrow(/CORDON_NOTE_IS_SENTINEL/);
    expect(() =>
      readResolvedNoteId(wrap([toFelt(STRK), FIXTURE_CONTEXT.pool, "0x0"]), shape),
    ).toThrow(/zero/);
  });

  it("refuses a non-felt", () => {
    expect(() =>
      readResolvedNoteId(wrap([toFelt(STRK), FIXTURE_CONTEXT.pool, "banana"]), shape),
    ).toThrow(NotePreparationError);
  });
});

describe("prepareDirect against the real mainnet envelope", () => {
  // The regression test for the bug that blocked every payment. The wallet stub splices this
  // SDK's own invoke calldata into the exact 111-felt transaction mainnet produced, so the whole
  // flow runs against the real surrounding actions, the real decoy gate addresses and the real
  // trailing felts. A Direct invoke is 18 felts, which is what index 86 of that transaction
  // declares, so it slots in where the original one sat.
  const context = createGateContext({
    chainId: "SN_MAIN",
    gate: MAINNET_GATE,
    pool: MAINNET_POOL,
  });

  function mainnetPrepare(): { prepare: Strk20Prepare; envelopes: string[][] } {
    const envelopes: string[][] = [];
    const prepare: Strk20Prepare = async (actions) => {
      const invoke = actions.find((action) => action.type === "invoke");
      const resolved = (invoke as { calldata: string[] }).calldata.map((item) => {
        if (item === "${openNoteIds[0]}") return MAINNET_NOTE_ID;
        if (item === "${poolAddress}") return MAINNET_POOL;
        return item;
      });
      expect(resolved).toHaveLength(MAINNET_INVOKE_LENGTH);

      const calldata = [
        ...MAINNET_APPLY_ACTIONS_CALLDATA.slice(0, MAINNET_GATE_INDEX + 2),
        ...resolved,
        ...MAINNET_APPLY_ACTIONS_CALLDATA.slice(
          MAINNET_GATE_INDEX + 2 + MAINNET_INVOKE_LENGTH,
        ),
      ];
      envelopes.push(calldata);
      return { call: { contractAddress: MAINNET_POOL, calldata }, proof: { stub: true } };
    };
    return { prepare, envelopes };
  }

  it("binds the signature to the note the transaction actually fills", async () => {
    const { prepare, envelopes } = mainnetPrepare();
    const result = await prepareDirect(
      {
        prepare,
        context,
        token: MAINNET_TOKEN,
        policyId: "PAY_ACCREDITED_V1",
        credential: payerCredential,
        amount: 400n,
        payee: PAYEE_ADDRESS,
      },
      TEST_SUBJECT_PRIVATE_KEY,
    );

    expect(result.noteId).toBe(toFelt(MAINNET_NOTE_ID));
    expect(result.authorization.payer.noteBinding).toBe(toFelt(MAINNET_NOTE_ID));
    expect(result.authorization.binding).toEqual({
      mode: "note",
      noteId: toFelt(MAINNET_NOTE_ID),
      validUntil: 0,
    });

    // Both prepares saw the full 111-felt envelope, so this ran against the real shape.
    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]).toHaveLength(MAINNET_APPLY_ACTIONS_CALLDATA.length);
  });

  it("does not bind the probe note, which is what shipped", async () => {
    const { prepare } = mainnetPrepare();
    const result = await prepareDirect(
      {
        prepare,
        context,
        token: MAINNET_TOKEN,
        policyId: "PAY_ACCREDITED_V1",
        credential: payerCredential,
        amount: 400n,
        payee: PAYEE_ADDRESS,
      },
      TEST_SUBJECT_PRIVATE_KEY,
    );

    // 0x1 is both the probe's placeholder note and the felt the old reader picked out of this very
    // transaction. Seeing it in a binding again means the reader has regressed.
    expect(result.authorization.payer.noteBinding).not.toBe("0x1");
    expect(result.authorization.payer.validUntil).toBe(0);
  });

  it("signs over the bound note, so the gate's own check would pass", async () => {
    const { prepare } = mainnetPrepare();
    const result = await prepareDirect(
      {
        prepare,
        context,
        token: MAINNET_TOKEN,
        policyId: "PAY_ACCREDITED_V1",
        credential: payerCredential,
        amount: 400n,
        payee: PAYEE_ADDRESS,
      },
      TEST_SUBJECT_PRIVATE_KEY,
    );

    expect(
      verifySubjectAction(
        {
          chainId: "SN_MAIN",
          gateAddress: MAINNET_GATE,
          poolAddress: MAINNET_POOL,
          leg: "Direct",
          policyId: "PAY_ACCREDITED_V1",
          noteBinding: MAINNET_NOTE_ID,
          validUntil: 0,
          token: MAINNET_TOKEN,
          amount: 400n,
          nonce: result.authorization.payer.nonce,
          termsHash: "0x0",
        },
        SUBJECT_KEY,
        result.authorization.payer.signature,
      ),
    ).toBe(true);
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

  it("still checks the prepared call is the invoke it built", () => {
    // A Fund needs no second prepare, so without this check it would be the one leg where a
    // mangled prepared call went unnoticed: its binding is zero whatever comes back.
    const mangled: Strk20Prepare = async () => ({
      call: { contractAddress: POOL_CONTRACT, calldata: ["0x1", "0x2", "0x3"] },
    });

    return expect(
      prepareFund(
        {
          prepare: mangled,
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
      ),
    ).rejects.toThrow(NotePreparationError);
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
