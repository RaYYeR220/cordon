import { describe, expect, it } from "vitest";
import {
  deriveSubjectKeypair,
  generateSubjectKeypair,
  randomNonce,
  signCredential,
  signHash,
  signSubjectAction,
  subjectKeyTypedData,
  subjectPublicKey,
  verifyCredentialSignature,
  verifyHash,
  verifySubjectAction,
} from "../src/index.js";
import {
  CREDENTIAL_FIXTURE,
  SUBJECT_ACTION_FIXTURE,
  TEST_ISSUER_PRIVATE_KEY,
  TEST_SUBJECT_PRIVATE_KEY,
} from "./fixtures.js";

describe("subject keypairs", () => {
  it("generates a distinct pseudonym each time", () => {
    const a = generateSubjectKeypair();
    const b = generateSubjectKeypair();
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(subjectPublicKey(a.privateKey)).toBe(a.publicKey);
  });

  it("derives the same key from the same wallet signature", () => {
    const signature = ["0x1a2b3c", "0x4d5e6f"];
    const first = deriveSubjectKeypair({ signature });
    const second = deriveSubjectKeypair({ signature });
    expect(first).toEqual(second);
    expect(subjectPublicKey(first.privateKey)).toBe(first.publicKey);
  });

  it("derives different keys for different contexts, so one wallet can hold several", () => {
    const signature = ["0x1a2b3c", "0x4d5e6f"];
    expect(deriveSubjectKeypair({ signature }).publicKey).not.toBe(
      deriveSubjectKeypair({ signature, context: "treasury" }).publicKey,
    );
  });

  it("derives different keys from different signatures", () => {
    expect(deriveSubjectKeypair({ signature: ["0x1", "0x2"] }).publicKey).not.toBe(
      deriveSubjectKeypair({ signature: ["0x1", "0x3"] }).publicKey,
    );
  });

  it("refuses to derive from nothing", () => {
    expect(() => deriveSubjectKeypair({ signature: [] })).toThrow();
  });

  it("offers a SNIP-12 message naming what it is for", () => {
    const data = subjectKeyTypedData({ chainId: "SN_MAIN" });
    expect(data.primaryType).toBe("CordonSubjectKey");
    expect(data.domain).toMatchObject({ name: "Cordon", chainId: "SN_MAIN", revision: "1" });
  });
});

describe("signing", () => {
  it("verifies a credential signature against the issuer key", () => {
    const signature = signCredential(CREDENTIAL_FIXTURE, TEST_ISSUER_PRIVATE_KEY);
    const issuerPublicKey = subjectPublicKey(TEST_ISSUER_PRIVATE_KEY);
    expect(verifyCredentialSignature(CREDENTIAL_FIXTURE, issuerPublicKey, signature)).toBe(true);
  });

  it("refuses a credential whose claim was swapped after signing", () => {
    const signature = signCredential(CREDENTIAL_FIXTURE, TEST_ISSUER_PRIVATE_KEY);
    const issuerPublicKey = subjectPublicKey(TEST_ISSUER_PRIVATE_KEY);
    expect(
      verifyCredentialSignature(
        { ...CREDENTIAL_FIXTURE, claim: "KYC_L2" },
        issuerPublicKey,
        signature,
      ),
    ).toBe(false);
  });

  it("refuses a credential signature from the wrong issuer", () => {
    const signature = signCredential(CREDENTIAL_FIXTURE, TEST_ISSUER_PRIVATE_KEY);
    expect(
      verifyCredentialSignature(
        CREDENTIAL_FIXTURE,
        subjectPublicKey(TEST_SUBJECT_PRIVATE_KEY),
        signature,
      ),
    ).toBe(false);
  });

  it("verifies a subject authorisation against the pseudonym", () => {
    const signature = signSubjectAction(SUBJECT_ACTION_FIXTURE, TEST_SUBJECT_PRIVATE_KEY);
    expect(
      verifySubjectAction(
        SUBJECT_ACTION_FIXTURE,
        subjectPublicKey(TEST_SUBJECT_PRIVATE_KEY),
        signature,
      ),
    ).toBe(true);
  });

  it("refuses an authorisation for a larger amount than was signed", () => {
    const signature = signSubjectAction(SUBJECT_ACTION_FIXTURE, TEST_SUBJECT_PRIVATE_KEY);
    expect(
      verifySubjectAction(
        { ...SUBJECT_ACTION_FIXTURE, amount: 4_000 },
        subjectPublicKey(TEST_SUBJECT_PRIVATE_KEY),
        signature,
      ),
    ).toBe(false);
  });

  it("refuses an authorisation replayed at another gate", () => {
    const signature = signSubjectAction(SUBJECT_ACTION_FIXTURE, TEST_SUBJECT_PRIVATE_KEY);
    expect(
      verifySubjectAction(
        { ...SUBJECT_ACTION_FIXTURE, gateAddress: "0x1234" },
        subjectPublicKey(TEST_SUBJECT_PRIVATE_KEY),
        signature,
      ),
    ).toBe(false);
  });

  it("is deterministic, so the same authorisation signed twice is the same bytes", () => {
    expect(signSubjectAction(SUBJECT_ACTION_FIXTURE, TEST_SUBJECT_PRIVATE_KEY)).toEqual(
      signSubjectAction(SUBJECT_ACTION_FIXTURE, TEST_SUBJECT_PRIVATE_KEY),
    );
  });

  it("verifies against the public key x-coordinate, which is all the gate stores", () => {
    // A stark key is an x-coordinate, and check_ecdsa_signature accepts a signature valid under
    // either y for it. Verification here has to match that, or it would reject signatures the
    // chain would settle.
    for (let index = 0; index < 16; index += 1) {
      const { privateKey, publicKey } = generateSubjectKeypair();
      const signature = signHash("0xdeadbeef", privateKey);
      expect(verifyHash("0xdeadbeef", publicKey, signature)).toBe(true);
    }
  });

  it("answers false rather than throwing on a malformed signature", () => {
    const { publicKey } = generateSubjectKeypair();
    expect(verifyHash("0xdeadbeef", publicKey, { r: "0x0", s: "0x0" })).toBe(false);
    expect(verifyHash("0xdeadbeef", "0x1", { r: "0x1", s: "0x2" })).toBe(false);
  });
});

describe("nonces", () => {
  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 64 }, () => randomNonce()));
    expect(seen.size).toBe(64);
  });
});
