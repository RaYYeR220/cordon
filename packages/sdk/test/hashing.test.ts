/**
 * Properties of the two preimages, over and above the pinned vectors.
 *
 * A conformance vector proves one input hashes correctly. These prove the shape is right: that
 * every asserted field is inside the preimage, that the tags keep the two message kinds apart, and
 * that nothing outside the preimage can move the hash.
 */

import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_TAG,
  SUBJECT_ACTION_TAG,
  credentialHash,
  poseidon,
  subjectActionHash,
  subjectActionPreimage,
} from "../src/index.js";
import { CREDENTIAL_FIXTURE, SUBJECT_ACTION_FIXTURE } from "./fixtures.js";

describe("domain separation", () => {
  it("keeps the credential and action tags distinct", () => {
    expect(CREDENTIAL_TAG).not.toBe(SUBJECT_ACTION_TAG);
  });

  it("puts the tag first, so no other field can be shifted into its place", () => {
    expect(subjectActionPreimage(SUBJECT_ACTION_FIXTURE)[0]).toBe(SUBJECT_ACTION_TAG);
  });

  it("makes a credential preimage unhashable as an action preimage", () => {
    // Same six trailing felts under each tag must land somewhere different, which is the whole
    // point of tagging: a subject holding one key in both roles cannot have a credential
    // signature replayed as an authorisation to move money.
    const fields = ["0x1", "0x2", "0x3", "0x4", "0x5"];
    expect(poseidon([CREDENTIAL_TAG, ...fields])).not.toBe(
      poseidon([SUBJECT_ACTION_TAG, ...fields]),
    );
  });
});

describe("credential preimage coverage", () => {
  const base = credentialHash(CREDENTIAL_FIXTURE);

  it("moves when any asserted field moves", () => {
    expect(credentialHash({ ...CREDENTIAL_FIXTURE, issuerId: "OTHER_KYC" })).not.toBe(base);
    expect(credentialHash({ ...CREDENTIAL_FIXTURE, credentialId: "CRED_0002" })).not.toBe(base);
    expect(credentialHash({ ...CREDENTIAL_FIXTURE, subjectPublicKey: "0x1" })).not.toBe(base);
    expect(credentialHash({ ...CREDENTIAL_FIXTURE, claim: "KYC_L2" })).not.toBe(base);
    expect(credentialHash({ ...CREDENTIAL_FIXTURE, expiresAt: 1_800_086_401 })).not.toBe(base);
  });
});

describe("action preimage coverage", () => {
  const base = subjectActionHash(SUBJECT_ACTION_FIXTURE);

  it("moves when any authorised fact moves", () => {
    expect(subjectActionHash({ ...SUBJECT_ACTION_FIXTURE, chainId: "SN_SEPOLIA" })).not.toBe(base);
    expect(subjectActionHash({ ...SUBJECT_ACTION_FIXTURE, gateAddress: "0x1234" })).not.toBe(base);
    expect(subjectActionHash({ ...SUBJECT_ACTION_FIXTURE, policyId: "PAY_KYC_L2_V1" })).not.toBe(
      base,
    );
    expect(subjectActionHash({ ...SUBJECT_ACTION_FIXTURE, noteId: "note_1" })).not.toBe(base);
    expect(subjectActionHash({ ...SUBJECT_ACTION_FIXTURE, token: "0x1234" })).not.toBe(base);
    expect(subjectActionHash({ ...SUBJECT_ACTION_FIXTURE, amount: 401 })).not.toBe(base);
    expect(subjectActionHash({ ...SUBJECT_ACTION_FIXTURE, nonce: "nonce_1" })).not.toBe(base);
  });

  it("binds the chain and the gate, which is what :V2 exists for", () => {
    const preimage = subjectActionPreimage(SUBJECT_ACTION_FIXTURE);
    expect(preimage).toHaveLength(8);
    expect(preimage[1]).toBe("0x534e5f4d41494e");
    expect(preimage[2]).toBe("0x2c0de00c0de00c0de00c0de00c0de00c0de00c0de00c0de00c0de00c0de001");
  });

  it("accepts an amount in any representation and hashes it identically", () => {
    expect(subjectActionHash({ ...SUBJECT_ACTION_FIXTURE, amount: "0x190" })).toBe(base);
    expect(subjectActionHash({ ...SUBJECT_ACTION_FIXTURE, amount: 400n })).toBe(base);
    expect(subjectActionHash({ ...SUBJECT_ACTION_FIXTURE, amount: "400" })).toBe(base);
  });
});
