/**
 * Print the conformance vectors, ready to paste into Cairo.
 *
 * The TypeScript and Cairo implementations of the preimages have to agree exactly, and the cheapest
 * way to keep them agreeing is for both sides to pin the same fixture. This prints that fixture as
 * felt tables.
 *
 *     npm run vectors
 */

import {
  CREDENTIAL_TAG,
  LEG_TAGS,
  SETTLEMENT_TERMS_TAG,
  SUBJECT_ACTION_TAG,
  credentialHash,
  credentialPreimage,
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
} from "../test/fixtures.js";

type Row = [string, string, string];

function table(rows: Row[]): string {
  const widths = [0, 1, 2].map((column) =>
    Math.max(...rows.map((row) => (row[column] as string).length)),
  );
  return rows
    .map((row) => row.map((cell, column) => cell.padEnd(widths[column] as number)).join("  "))
    .join("\n");
}

const credentialRows: Row[] = [
  ["field", "value", "felt"],
  ["tag", "CORDON_CREDENTIAL:V1", CREDENTIAL_TAG],
  ["issuer_id", String(CREDENTIAL_FIXTURE.issuerId), toFelt(CREDENTIAL_FIXTURE.issuerId)],
  [
    "credential_id",
    String(CREDENTIAL_FIXTURE.credentialId),
    toFelt(CREDENTIAL_FIXTURE.credentialId),
  ],
  [
    "subject_public_key",
    String(CREDENTIAL_FIXTURE.subjectPublicKey),
    toFelt(CREDENTIAL_FIXTURE.subjectPublicKey),
  ],
  ["claim", String(CREDENTIAL_FIXTURE.claim), toFelt(CREDENTIAL_FIXTURE.claim)],
  ["expires_at", String(CREDENTIAL_FIXTURE.expiresAt), toFelt(CREDENTIAL_FIXTURE.expiresAt)],
];

const termsRows: Row[] = [
  ["field", "value", "felt"],
  ["tag", "CORDON_SETTLEMENT_TERMS:V1", SETTLEMENT_TERMS_TAG],
  [
    "settlement_id",
    String(SETTLEMENT_TERMS_FIXTURE.settlementId),
    toFelt(SETTLEMENT_TERMS_FIXTURE.settlementId),
  ],
  [
    "payee_subject_key",
    String(SETTLEMENT_TERMS_FIXTURE.payeeSubjectKey),
    toFelt(SETTLEMENT_TERMS_FIXTURE.payeeSubjectKey),
  ],
  [
    "payee_claim_policy_id",
    String(SETTLEMENT_TERMS_FIXTURE.payeeClaimPolicyId),
    toFelt(SETTLEMENT_TERMS_FIXTURE.payeeClaimPolicyId),
  ],
  [
    "expires_at",
    String(SETTLEMENT_TERMS_FIXTURE.expiresAt),
    toFelt(SETTLEMENT_TERMS_FIXTURE.expiresAt),
  ],
];

const actionRows: Row[] = [
  ["field", "value", "felt"],
  ["tag", "CORDON_SUBJECT_ACTION:V3", SUBJECT_ACTION_TAG],
  ["chain_id", String(SUBJECT_ACTION_FIXTURE.chainId), toFelt(SUBJECT_ACTION_FIXTURE.chainId)],
  [
    "gate_address",
    String(SUBJECT_ACTION_FIXTURE.gateAddress),
    toFelt(SUBJECT_ACTION_FIXTURE.gateAddress),
  ],
  [
    "pool_address",
    String(SUBJECT_ACTION_FIXTURE.poolAddress),
    toFelt(SUBJECT_ACTION_FIXTURE.poolAddress),
  ],
  ["leg", `CORDON_LEG_${SUBJECT_ACTION_FIXTURE.leg.toUpperCase()}`, LEG_TAGS[SUBJECT_ACTION_FIXTURE.leg]],
  ["policy_id", String(SUBJECT_ACTION_FIXTURE.policyId), toFelt(SUBJECT_ACTION_FIXTURE.policyId)],
  ["note_id", String(SUBJECT_ACTION_FIXTURE.noteId), toFelt(SUBJECT_ACTION_FIXTURE.noteId)],
  ["token", String(SUBJECT_ACTION_FIXTURE.token), toFelt(SUBJECT_ACTION_FIXTURE.token)],
  ["amount", String(SUBJECT_ACTION_FIXTURE.amount), toFelt(SUBJECT_ACTION_FIXTURE.amount)],
  ["nonce", String(SUBJECT_ACTION_FIXTURE.nonce), toFelt(SUBJECT_ACTION_FIXTURE.nonce)],
  ["terms_hash", "the settlement terms above", toFelt(SUBJECT_ACTION_FIXTURE.termsHash)],
];

const lines = [
  "credential_hash",
  "---------------",
  table(credentialRows),
  "",
  `  = ${credentialHash(CREDENTIAL_FIXTURE)}`,
  "",
  "  preimage:",
  ...credentialPreimage(CREDENTIAL_FIXTURE).map((felt) => `    ${felt}`),
  "",
  "settlement_terms_hash",
  "---------------------",
  table(termsRows),
  "",
  `  = ${settlementTermsHash(SETTLEMENT_TERMS_FIXTURE)}`,
  "",
  "  preimage:",
  ...settlementTermsPreimage(SETTLEMENT_TERMS_FIXTURE).map((felt) => `    ${felt}`),
  "",
  "subject_action_hash",
  "-------------------",
  table(actionRows),
  "",
  `  = ${subjectActionHash(SUBJECT_ACTION_FIXTURE)}`,
  "",
  "  preimage:",
  ...subjectActionPreimage(SUBJECT_ACTION_FIXTURE).map((felt) => `    ${felt}`),
];

process.stdout.write(`${lines.join("\n")}\n`);
