/**
 * Conformance: TypeScript and Cairo must compute the same hashes.
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
 * 3. **The domain and leg tags**, read from `contracts/src/hashing.cairo`, because a tag version
 *    bump is exactly the change that produces silently unverifiable signatures.
 */

import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_TAG,
  DIRECT_TERMS_HASH,
  DOMAIN_TAGS,
  LEG_TAGS,
  SETTLEMENT_TERMS_TAG,
  SUBJECT_ACTION_TAG,
  credentialHash,
  credentialPreimage,
  poseidon,
  quotedSettlementHash,
  settlementTermsHash,
  settlementTermsPreimage,
  subjectActionHash,
  subjectActionPreimage,
  toFelt,
} from "../src/index.js";
import {
  CREDENTIAL_FIXTURE,
  SETTLEMENT_TERMS_FIXTURE,
  SUBJECT_ACTION_FIXTURE,
} from "./fixtures.js";
import { readDomainTags, readLegTags, readPinnedVectors } from "./cairo-source.js";

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
 * `settlement_terms_hash`, the nested hash a `Fund` binds.
 *
 * | Field | Value |
 * | --- | --- |
 * | tag | `CORDON_SETTLEMENT_TERMS:V1` |
 * | `settlement_id` | `stl_0` |
 * | `payee_subject_key` | `0x066ee0…ce00` |
 * | `payee_claim_policy_id` | `RECV_KYC_L2_V1` |
 * | `expires_at` | `1800007200` |
 */
const SETTLEMENT_TERMS_VECTOR = {
  preimage: [
    "0x434f52444f4e5f534554544c454d454e545f5445524d533a5631",
    "0x73746c5f30",
    "0x66ee00a11ce00a11ce00a11ce00a11ce00a11ce00a11ce00a11ce00a11ce00",
    "0x524543565f4b59435f4c325f5631",
    "0x6b49ee20",
  ],
  hash: "0x4d1dba11f958448bb5b3d4b7e39ebba33b79ca80ea191539bc1868a628f7d3d",
} as const;

/**
 * `subject_action_hash` under the `:V3` tag: a `Fund` leg, bound to a chain, a gate and a pool.
 *
 * | Field | Value |
 * | --- | --- |
 * | tag | `CORDON_SUBJECT_ACTION:V3` |
 * | `chain_id` | `SN_MAIN` |
 * | `gate_address` | `0x02c0de00…de001` |
 * | `pool_address` | `0x0900100c…11002` |
 * | `leg` | `CORDON_LEG_FUND` |
 * | `policy_id` | `PAY_ACCREDITED_V1` |
 * | `note_id` | `0` — a funding leg fills no note |
 * | `token` | STRK |
 * | `amount` | `400` |
 * | `nonce` | `nonce_0` |
 * | `terms_hash` | the settlement terms above |
 */
const SUBJECT_ACTION_VECTOR = {
  preimage: [
    "0x434f52444f4e5f5355424a4543545f414354494f4e3a5633",
    "0x534e5f4d41494e",
    "0x2c0de00c0de00c0de00c0de00c0de00c0de00c0de00c0de00c0de00c0de001",
    "0x900100c0011ea1100c0011ea1100c0011ea1100c0011ea1100c0011ea11002",
    "0x434f52444f4e5f4c45475f46554e44",
    "0x5041595f414343524544495445445f5631",
    "0x0",
    "0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
    "0x190",
    "0x6e6f6e63655f30",
    "0x4d1dba11f958448bb5b3d4b7e39ebba33b79ca80ea191539bc1868a628f7d3d",
  ],
  hash: "0x699b15a2d12d1e8df2bc0aaafd30dfdf1eb8b48380496855dc89b85ada49c83",
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

  it("computes the pinned settlement terms hash", () => {
    expect(settlementTermsHash(SETTLEMENT_TERMS_FIXTURE)).toBe(SETTLEMENT_TERMS_VECTOR.hash);
  });

  it("builds the documented terms preimage, element for element", () => {
    expect(settlementTermsPreimage(SETTLEMENT_TERMS_FIXTURE)).toEqual([
      ...SETTLEMENT_TERMS_VECTOR.preimage,
    ]);
  });

  it("hashes the literal terms preimage to the pinned value", () => {
    expect(poseidon(SETTLEMENT_TERMS_VECTOR.preimage)).toBe(SETTLEMENT_TERMS_VECTOR.hash);
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

  it("nests the terms hash as the eleventh element of the action preimage", () => {
    expect(SUBJECT_ACTION_VECTOR.preimage).toHaveLength(11);
    expect(SUBJECT_ACTION_VECTOR.preimage[10]).toBe(SETTLEMENT_TERMS_VECTOR.hash);
  });
});

describe("the Direct terms hash", () => {
  it("is a literal zero, not the hash of four zeros", () => {
    // Using `settlementTermsHash(0,0,0,0)` here is the mistake this test exists to catch: it is a
    // large non-zero felt, and a Direct signed with it is refused as CORDON_BAD_SUBJECT_SIG with
    // nothing in the revert to say why.
    expect(DIRECT_TERMS_HASH).toBe("0x0");
    expect(
      settlementTermsHash({
        settlementId: 0,
        payeeSubjectKey: 0,
        payeeClaimPolicyId: 0,
        expiresAt: 0,
      }),
    ).not.toBe(DIRECT_TERMS_HASH);
  });

  it("quotes a settlement id with the other three fields zeroed", () => {
    expect(quotedSettlementHash("stl_0")).toBe(
      settlementTermsHash({
        settlementId: "stl_0",
        payeeSubjectKey: 0,
        payeeClaimPolicyId: 0,
        expiresAt: 0,
      }),
    );
    // A quoted hash is not a Fund's terms hash: the payee, policy and expiry are absent.
    expect(quotedSettlementHash("stl_0")).not.toBe(settlementTermsHash(SETTLEMENT_TERMS_FIXTURE));
  });
});

describe("the Cairo source", () => {
  const tags = readDomainTags();
  const legs = readLegTags();
  const vectors = readPinnedVectors();

  it("declares the three domain tags this SDK signs under", () => {
    expect(tags.credential).toBe(CREDENTIAL_TAG);
    expect(tags.credential).toBe(toFelt(DOMAIN_TAGS.credential));
    expect(tags.subjectAction).toBe(SUBJECT_ACTION_TAG);
    expect(tags.subjectAction).toBe(toFelt(DOMAIN_TAGS.subjectAction));
    expect(tags.settlementTerms).toBe(SETTLEMENT_TERMS_TAG);
    expect(tags.settlementTerms).toBe(toFelt(DOMAIN_TAGS.settlementTerms));
  });

  it("declares the four leg tags this SDK signs with", () => {
    expect(legs["DIRECT"]).toBe(LEG_TAGS.Direct);
    expect(legs["FUND"]).toBe(LEG_TAGS.Fund);
    expect(legs["CLAIM"]).toBe(LEG_TAGS.Claim);
    expect(legs["REFUND"]).toBe(LEG_TAGS.Refund);
  });

  it("pins the credential hash this implementation computes", () => {
    expect(poseidon(vectors.credential.preimage)).toBe(vectors.credential.expected);
    expect(vectors.credential.expected).toBe(CREDENTIAL_VECTOR.hash);
    expect(vectors.credential.preimage).toEqual([...CREDENTIAL_VECTOR.preimage]);
  });

  it("pins the settlement terms hash this implementation computes", () => {
    expect(poseidon(vectors.settlementTerms.preimage)).toBe(vectors.settlementTerms.expected);
    expect(vectors.settlementTerms.expected).toBe(SETTLEMENT_TERMS_VECTOR.hash);
    expect(vectors.settlementTerms.preimage).toEqual([...SETTLEMENT_TERMS_VECTOR.preimage]);
  });

  it("pins the action hash this implementation computes", () => {
    expect(poseidon(vectors.subjectAction.preimage)).toBe(vectors.subjectAction.expected);
    expect(vectors.subjectAction.expected).toBe(SUBJECT_ACTION_VECTOR.hash);
    expect(vectors.subjectAction.preimage).toEqual([...SUBJECT_ACTION_VECTOR.preimage]);
  });

  it("pins a credential preimage the typed builder reproduces field for field", () => {
    const preimage = vectors.credential.preimage as string[];
    expect(preimage).toHaveLength(6);
    const [tag, issuerId, credentialId, subjectPublicKey, claim, expiresAt] = preimage;
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

  it("pins a terms preimage the typed builder reproduces field for field", () => {
    const preimage = vectors.settlementTerms.preimage as string[];
    expect(preimage).toHaveLength(5);
    const [tag, settlementId, payeeSubjectKey, payeeClaimPolicyId, expiresAt] = preimage;
    expect(tag).toBe(SETTLEMENT_TERMS_TAG);
    expect(
      settlementTermsHash({
        settlementId: settlementId as string,
        payeeSubjectKey: payeeSubjectKey as string,
        payeeClaimPolicyId: payeeClaimPolicyId as string,
        expiresAt: expiresAt as string,
      }),
    ).toBe(vectors.settlementTerms.expected);
  });

  it("pins an action preimage the typed builder reproduces field for field", () => {
    const preimage = vectors.subjectAction.preimage as string[];
    expect(preimage).toHaveLength(11);
    const [
      tag,
      chainId,
      gateAddress,
      poolAddress,
      leg,
      policyId,
      noteId,
      token,
      amount,
      nonce,
      termsHash,
    ] = preimage;

    expect(tag).toBe(SUBJECT_ACTION_TAG);
    const named = Object.entries(LEG_TAGS).find(([, felt]) => felt === leg)?.[0];
    expect(named, `the Cairo fixture signs leg ${leg}, which this SDK does not know`).toBeDefined();

    expect(
      subjectActionHash({
        chainId: chainId as string,
        gateAddress: gateAddress as string,
        poolAddress: poolAddress as string,
        leg: named as keyof typeof LEG_TAGS,
        policyId: policyId as string,
        noteId: noteId as string,
        token: token as string,
        amount: amount as string,
        nonce: nonce as string,
        termsHash: termsHash as string,
      }),
    ).toBe(vectors.subjectAction.expected);
  });
});

describe("side by side", () => {
  it("reports the Cairo value next to the TypeScript value for all three hashes", () => {
    const vectors = readPinnedVectors();
    const rows: [string, string, string][] = [
      ["credential_hash", vectors.credential.expected, credentialHash(CREDENTIAL_FIXTURE)],
      [
        "settlement_terms_hash",
        vectors.settlementTerms.expected,
        settlementTermsHash(SETTLEMENT_TERMS_FIXTURE),
      ],
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
