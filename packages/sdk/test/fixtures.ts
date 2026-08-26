/**
 * The conformance fixture, shared by the tests and by `scripts/print-vectors.ts`.
 *
 * These are the same values `contracts/src/tests/test_hashing.cairo` uses. Every field is
 * something a human can read straight out of a hex dump, which is what makes a mismatch between
 * Cairo and TypeScript debuggable rather than a wall of entropy.
 */

import type { CredentialHashInput, SubjectActionHashInput } from "../src/hashing.js";

/** The STRK fee token, identical on every Starknet network. */
export const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

/** The `PolicyGate` address the Cairo fixture uses. Recognisable on sight, not a deployment. */
export const FIXTURE_GATE =
  "0x02c0de00c0de00c0de00c0de00c0de00c0de00c0de00c0de00c0de00c0de001";

export const CREDENTIAL_FIXTURE: CredentialHashInput = {
  issuerId: "CORDON_KYC",
  credentialId: "CRED_0001",
  subjectPublicKey: "0x1ce8adcb0d0e5e0d0a3e2b8b8f9e5c3b2a1908070605040302010f0e0d0c0b0",
  claim: "ACCREDITED",
  expiresAt: 1_800_086_400,
};

/** The `:V2` action fixture, matching `fixture_action_hash` in the Cairo suite. */
export const SUBJECT_ACTION_FIXTURE: SubjectActionHashInput = {
  chainId: "SN_MAIN",
  gateAddress: FIXTURE_GATE,
  policyId: "PAY_ACCREDITED_V1",
  noteId: "note_0",
  token: STRK,
  amount: 400,
  nonce: "nonce_0",
};

/**
 * A fixed issuer key. A test key and nothing else — it is in a public repository, so anything it
 * ever signs is forgeable by anyone reading this.
 */
export const TEST_ISSUER_PRIVATE_KEY =
  "0x3c1e9550e66958296d11b60f8e8e7a7ad990d07fa65d5f7652c4a6c87d4e3cc";

/** A fixed subject key, on the same terms. */
export const TEST_SUBJECT_PRIVATE_KEY =
  "0x6b3f2c1d0e9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b";
