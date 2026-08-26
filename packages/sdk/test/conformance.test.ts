/**
 * Conformance: TypeScript and Cairo must compute the same two hashes.
 *
 * This is the most important file in the package. Cordon verifies two STARK-curve signatures on
 * every settlement, both against a Poseidon hash the signer computed off chain. If this
 * implementation differs from `contracts/src/hashing.cairo` by a single field, a single byte of a
 * domain tag, or a single element of ordering, then every signature this SDK produces is refused
 * on chain as `CORDON_BAD_CRED` or `CORDON_BAD_SUBJECT_SIG` — and the revert carries nothing that
 * would tell anyone why.
 *
 * There are three layers here, and they catch different things:
 *
 * 1. **Pinned literals**, copied from `contracts/src/tests/test_hashing.cairo`. They never change
 *    without a deliberate edit, so they catch a regression in this package.
 * 2. **The Cairo source itself**, read from `contracts/` and recomputed here, so the two sides
 *    cannot drift apart without a failure — including if the Cairo fixture is edited.
 * 3. **The domain tags**, read from `contracts/src/hashing.cairo`, because a tag version bump is
 *    exactly the change that produces silently unverifiable signatures.
 */

import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_TAG,
  DOMAIN_TAGS,
  SUBJECT_ACTION_TAG,
  credentialHash,
  credentialPreimage,
  poseidon,
  subjectActionHash,
  subjectActionPreimage,
  toFelt,
} from "../src/index.js";
import { CREDENTIAL_FIXTURE, SUBJECT_ACTION_FIXTURE } from "./fixtures.js";
import { readDomainTags, readPinnedVectors } from "./cairo-source.js";

/**
 * `credential_hash`, spelled out exactly as `contracts/HASHING.md` and the Cairo fixture do.
 *
 * | Field | Value |
 * | --- | --- |
 * | tag | `CORDON_CREDENTIAL:V1` |
 * | `issuer_id` | `CORDON_KYC` |
 * | `credential_id` | `CRED_0001` |
 * | `subject_public_key` | `0x1ce8ad…0c0b0` |
 * | `claim` | `ACCREDITED` |
 * | `expires_at` | `1800086400` |
 */
const CREDENTIAL_VECTOR = {
  preimage: [
    "0x434f52444f4e5f43524544454e5449414c3a5631",
    "0x434f52444f4e5f4b5943",
    "0x435245445f30303031",
    "0x1ce8adcb0d0e5e0d0a3e2b8b8f9e5c3b2a1908070605040302010f0e0d0c0b0",
    "0x41434352454449544544",
    "0x6b4b2380",
  ],
  hash: "0x33416da028165a7c7d2799315f717493f4ffe5379a4f1efe7fb85e1244db1b5",
} as const;

/**
 * `subject_action_hash` under the `:V2` tag, which binds the chain and the gate as well.
 *
 * | Field | Value |
 * | --- | --- |
 * | tag | `CORDON_SUBJECT_ACTION:V2` |
 * | `chain_id` | `SN_MAIN` |
 * | `gate_address` | `0x02c0de00…de001` |
 * | `policy_id` | `PAY_ACCREDITED_V1` |
 * | `note_id` | `note_0` |
 * | `token` | STRK |
 * | `amount` | `400` |
 * | `nonce` | `nonce_0` |
 */
const SUBJECT_ACTION_VECTOR = {
  preimage: [
    "0x434f52444f4e5f5355424a4543545f414354494f4e3a5632",
    "0x534e5f4d41494e",
    "0x2c0de00c0de00c0de00c0de00c0de00c0de00c0de00c0de00c0de00c0de001",
    "0x5041595f414343524544495445445f5631",
    "0x6e6f74655f30",
    "0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
    "0x190",
    "0x6e6f6e63655f30",
  ],
  hash: "0x1d07660058550812f9d317014bcb9a843f55a2ed9362642fdb0c0eb2eca65e9",
} as const;

describe("pinned vectors", () => {
  it("computes the pinned credential hash", () => {
    expect(credentialHash(CREDENTIAL_FIXTURE)).toBe(CREDENTIAL_VECTOR.hash);
  });

  it("builds the documented credential preimage, element for element", () => {
    expect(credentialPreimage(CREDENTIAL_FIXTURE)).toEqual([...CREDENTIAL_VECTOR.preimage]);
  });

  it("hashes the literal credential preimage to the pinned value", () => {
    expect(poseidon(CREDENTIAL_VECTOR.preimage)).toBe(CREDENTIAL_VECTOR.hash);
  });

  it("computes the pinned subject action hash", () => {
    expect(subjectActionHash(SUBJECT_ACTION_FIXTURE)).toBe(SUBJECT_ACTION_VECTOR.hash);
  });

  it("builds the documented action preimage, element for element", () => {
    expect(subjectActionPreimage(SUBJECT_ACTION_FIXTURE)).toEqual([
      ...SUBJECT_ACTION_VECTOR.preimage,
    ]);
  });

  it("hashes the literal action preimage to the pinned value", () => {
    expect(poseidon(SUBJECT_ACTION_VECTOR.preimage)).toBe(SUBJECT_ACTION_VECTOR.hash);
  });
});

describe("the Cairo source", () => {
  const tags = readDomainTags();
  const vectors = readPinnedVectors();

  it("declares the tags this SDK signs under", () => {
    expect(tags.credential).toBe(CREDENTIAL_TAG);
    expect(tags.credential).toBe(toFelt(DOMAIN_TAGS.credential));
    expect(tags.subjectAction).toBe(SUBJECT_ACTION_TAG);
    expect(tags.subjectAction).toBe(toFelt(DOMAIN_TAGS.subjectAction));
  });

  it("pins the credential hash this implementation computes", () => {
    expect(poseidon(vectors.credential.preimage)).toBe(vectors.credential.expected);
    expect(vectors.credential.expected).toBe(CREDENTIAL_VECTOR.hash);
    expect(vectors.credential.preimage).toEqual([...CREDENTIAL_VECTOR.preimage]);
  });

  it("pins the action hash this implementation computes", () => {
    expect(poseidon(vectors.subjectAction.preimage)).toBe(vectors.subjectAction.expected);
    expect(vectors.subjectAction.expected).toBe(SUBJECT_ACTION_VECTOR.hash);
    expect(vectors.subjectAction.preimage).toEqual([...SUBJECT_ACTION_VECTOR.preimage]);
  });

  it("pins a credential preimage the typed builder reproduces field for field", () => {
    const preimage = vectors.credential.preimage;
    expect(preimage).toHaveLength(6);
    const [tag, issuerId, credentialId, subjectPublicKey, claim, expiresAt] = preimage as string[];
    expect(tag).toBe(CREDENTIAL_TAG);
    expect(
      credentialHash({
        issuerId: issuerId as string,
        credentialId: credentialId as string,
        subjectPublicKey: subjectPublicKey as string,
        claim: claim as string,
        expiresAt: expiresAt as string,
      }),
    ).toBe(vectors.credential.expected);
  });

  it("pins an action preimage the typed builder reproduces field for field", () => {
    const preimage = vectors.subjectAction.preimage;
    expect(preimage).toHaveLength(8);
    const [tag, chainId, gateAddress, policyId, noteId, token, amount, nonce] =
      preimage as string[];
    expect(tag).toBe(SUBJECT_ACTION_TAG);
    expect(
      subjectActionHash({
        chainId: chainId as string,
        gateAddress: gateAddress as string,
        policyId: policyId as string,
        noteId: noteId as string,
        token: token as string,
        amount: amount as string,
        nonce: nonce as string,
      }),
    ).toBe(vectors.subjectAction.expected);
  });
});

describe("side by side", () => {
  it("reports the Cairo value next to the TypeScript value for both hashes", () => {
    const vectors = readPinnedVectors();
    const rows: [string, string, string][] = [
      ["credential_hash", vectors.credential.expected, credentialHash(CREDENTIAL_FIXTURE)],
      [
        "subject_action_hash",
        vectors.subjectAction.expected,
        subjectActionHash(SUBJECT_ACTION_FIXTURE),
      ],
    ];
    for (const [name, cairo, typescript] of rows) {
      expect(typescript, `${name}: Cairo pins ${cairo}, TypeScript computed ${typescript}`).toBe(
        cairo,
      );
    }
  });
});
