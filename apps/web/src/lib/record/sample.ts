/**
 * The seeded sample record.
 *
 * A judge opens this product with no wallet, no account and no funds, and has
 * to be able to read the whole thing. That is what this file is for — and the
 * one rule it lives under is that it must never be mistaken for chain state.
 * Every screen rendered from it is stamped SAMPLE RECORD, and a sample
 * transaction hash is printed rather than linked, because a link to a
 * transaction that does not exist is worse than no link at all.
 *
 * What is *not* faked here is the enforcement. The policies and credentials
 * below are real SDK objects: the credentials carry real STARK-curve
 * signatures over their real hashes, and the Pay screen runs the SDK's actual
 * `preflight()` over them. When the sample record says a payment is refused
 * with `CORDON_OVER_CAP`, that verdict was computed by the same code the live
 * path uses, not written down in advance.
 */

import {
  createPolicy,
  issueCredential,
  subjectPublicKey,
  shortStringToFelt,
  type Credential,
  type Policy,
} from "@cordon/sdk";

import { DEFAULT_POOL_ADDRESS, STRK_TOKEN } from "@/lib/strk20";

import { strk } from "./format";

/** The instant this record was printed at. A document has a date on it. */
export const SAMPLE_NOW = Math.floor(Date.parse("2026-08-26T14:42:07Z") / 1000);
export const SAMPLE_BLOCK = 1_482_913;
export const BLOCK_TIME_SECONDS = 30;

/**
 * The key the sample issuer signs with.
 *
 * It exists so the sample credentials verify for real rather than carrying
 * decorative signatures. It is a demonstration key in a public repository and
 * attests nothing about anybody.
 */
const SAMPLE_ISSUER_KEY = "0x03c1f9a3e7b0d248c6a1e5b9f3d7a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4";
const SAMPLE_SCREENER_KEY = "0x02e8b4d6f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a0c2e1";

export const SAMPLE_ISSUER_PUBLIC_KEY = subjectPublicKey(SAMPLE_ISSUER_KEY);
export const SAMPLE_SCREENER_PUBLIC_KEY = subjectPublicKey(SAMPLE_SCREENER_KEY);

/* ── the contracts ──────────────────────────────────────────────────────── */

export type ContractRef = {
  name: string;
  address: string;
  /** True when the address is a live mainnet deployment anyone can open. */
  live: boolean;
};

export const SAMPLE_CONTRACTS: readonly ContractRef[] = [
  {
    name: "PolicyGate",
    address: "0x03a7f1c9e5b28d604f1a9c73e0b8d5426fa1c9e3b7d0528f4a6c1e9b3d7f0a52",
    live: false,
  },
  {
    name: "PolicyRegistry",
    address: "0x01d4b8e2f6a09c357e1b4d8f2a6c093e5b7d1f4a8c2e6b0d3f7a1c5e9b2d4f68",
    live: false,
  },
  {
    name: "IssuerRegistry",
    address: "0x0629ae4c8f1b3d570a2e6c94b8d1f3a5e7c0b2d4f6a8c1e3b5d7f9a0c2e4b6d8",
    live: false,
  },
  {
    name: "RevocationRegistry",
    address: "0x074c3f8a1e5b9d260c4a8e2f6b0d3a7c1e5b9f2d4a6c8e0b3d5f7a9c1e3b5d79",
    live: false,
  },
  { name: "Privacy pool · STRK20", address: DEFAULT_POOL_ADDRESS, live: true },
  { name: "STRK token", address: STRK_TOKEN, live: true },
];

export const SAMPLE_GATE = SAMPLE_CONTRACTS[0]!.address;
export const SAMPLE_POLICY_REGISTRY = SAMPLE_CONTRACTS[1]!.address;
export const SAMPLE_ISSUER_REGISTRY = SAMPLE_CONTRACTS[2]!.address;
export const SAMPLE_REVOCATION_REGISTRY = SAMPLE_CONTRACTS[3]!.address;

/** The pool charges this per `apply_actions`, once per transaction, win or lose. */
export const POOL_FEE = strk(6n);

/* ── the published policies ─────────────────────────────────────────────── */

export type SamplePolicy = {
  id: string;
  version: string;
  policy: Policy;
  /** How the register prints the issuer requirement. */
  issuerLabel: string;
  claimLabel: string;
  /** The largest amount the monitor saw against this policy in the window. */
  largestSeen: bigint;
  /** The top of the scale a cordon line for this policy is drawn against. */
  scaleTop: bigint;
};

export const SAMPLE_POLICIES: readonly SamplePolicy[] = [
  {
    id: "ACCREDITED_SEED_V2",
    version: "v2",
    claimLabel: "ACCREDITED",
    issuerLabel: "HARBOUR_KYC",
    largestSeen: strk(6500n),
    scaleTop: strk(7000n),
    policy: createPolicy({
      requiredClaim: shortStringToFelt("ACCREDITED"),
      issuerId: shortStringToFelt("HARBOUR_KYC"),
      maxAmount: strk(5000n),
      epochLength: 86_400,
      maxPerEpoch: strk(12_000n),
      requirePayeeCredential: false,
    }),
  },
  {
    id: "KYC_L2_RETAIL",
    version: "v4",
    claimLabel: "KYC_L2",
    issuerLabel: "any active issuer",
    largestSeen: strk(1400n),
    scaleTop: strk(2100n),
    policy: createPolicy({
      requiredClaim: shortStringToFelt("KYC_L2"),
      maxAmount: strk(1500n),
      epochLength: 3_600,
      maxPerEpoch: strk(4000n),
      requirePayeeCredential: false,
    }),
  },
  {
    id: "NOT_SANCTIONED_BASE",
    version: "v1",
    claimLabel: "NOT_SANCTIONED",
    issuerLabel: "OFAC_SCREEN_01",
    largestSeen: strk(18_500n),
    scaleTop: strk(20_000n),
    policy: createPolicy({
      requiredClaim: shortStringToFelt("NOT_SANCTIONED"),
      issuerId: shortStringToFelt("OFAC_SCREEN_01"),
      requirePayeeCredential: false,
    }),
  },
  {
    id: "TREASURY_EGRESS_V3",
    version: "v3",
    claimLabel: "TREASURY_OP",
    issuerLabel: "HARBOUR_KYC",
    largestSeen: strk(120_000n),
    scaleTop: strk(350_000n),
    policy: createPolicy({
      requiredClaim: shortStringToFelt("TREASURY_OP"),
      issuerId: shortStringToFelt("HARBOUR_KYC"),
      maxAmount: strk(250_000n),
      epochLength: 604_800,
      maxPerEpoch: strk(750_000n),
      requirePayeeCredential: true,
    }),
  },
];

/** The policy the Pay and Passport screens are written against. */
export const SAMPLE_POLICY = SAMPLE_POLICIES[0]!;

/* ── the issuers ────────────────────────────────────────────────────────── */

export type SampleIssuer = {
  id: string;
  name: string;
  publicKey: string;
  state: "ACTIVE" | "DEACTIVATED";
  stateNote: string | null;
};

export const SAMPLE_ISSUERS: readonly SampleIssuer[] = [
  {
    id: "HARBOUR_KYC",
    name: "Harbour Compliance GmbH",
    publicKey: SAMPLE_ISSUER_PUBLIC_KEY,
    state: "ACTIVE",
    stateNote: null,
  },
  {
    id: "OFAC_SCREEN_01",
    name: "Cordon Screening Service (OFAC SDN)",
    publicKey: SAMPLE_SCREENER_PUBLIC_KEY,
    state: "ACTIVE",
    stateNote: null,
  },
  {
    id: "NB_ATTEST_EU",
    name: "Nordbank Attestation (EU)",
    publicKey: "0x0713d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b",
    state: "DEACTIVATED",
    stateNote: "2026-07-14",
  },
];

/* ── the credentials ────────────────────────────────────────────────────── */

export const PRIMARY_SUBJECT = "0x06b3d9f1a4c7e2b5d8f0a3c6e9b1d4f7a0c3e6b9d2f5a8c1e4b7d0f3a6c9e2b";
export const REVOKED_SUBJECT = "0x041c8e5b2d9f6a3c0e7b4d1f8a5c2e9b6d3f0a7c4e1b8d5f2a9c6e3b0d7f4a1";

export type SampleCredential = {
  credential: Credential;
  issuer: SampleIssuer;
  issuedAt: number;
  /** Null unless the issuer has published a revocation for it. */
  revokedAt: number | null;
  revokedAtBlock: number | null;
};

export const PRIMARY_CREDENTIAL: SampleCredential = {
  credential: issueCredential(
    {
      issuerId: shortStringToFelt("HARBOUR_KYC"),
      credentialId: "0x0c4e1a97f2b8d5306e9a4c1f7b3d8e0a5c2f9b6d4a1e7c3f0b8d5a2e9c6f3b1",
      subjectPublicKey: PRIMARY_SUBJECT,
      claim: shortStringToFelt("ACCREDITED"),
      expiresAt: Math.floor(Date.parse("2027-03-02T09:14:22Z") / 1000),
    },
    SAMPLE_ISSUER_KEY
  ),
  issuer: SAMPLE_ISSUERS[0]!,
  issuedAt: Math.floor(Date.parse("2026-03-02T09:14:22Z") / 1000),
  revokedAt: null,
  revokedAtBlock: null,
};

export const SCREENING_CREDENTIAL: SampleCredential = {
  credential: issueCredential(
    {
      issuerId: shortStringToFelt("OFAC_SCREEN_01"),
      credentialId: "0x09f2c5e8b1d4a7f0c3e6b9d2f5a8c1e4b7d0f3a6c9e2b5d8f1a4c7e0b3d6f9a",
      subjectPublicKey: PRIMARY_SUBJECT,
      claim: shortStringToFelt("NOT_SANCTIONED"),
      expiresAt: Math.floor(Date.parse("2026-09-25T00:00:00Z") / 1000),
    },
    SAMPLE_SCREENER_KEY
  ),
  issuer: SAMPLE_ISSUERS[1]!,
  issuedAt: Math.floor(Date.parse("2026-08-25T00:00:00Z") / 1000),
  revokedAt: null,
  revokedAtBlock: null,
};

export const REVOKED_CREDENTIAL: SampleCredential = {
  credential: issueCredential(
    {
      issuerId: shortStringToFelt("HARBOUR_KYC"),
      credentialId: "0x0a1d7e4b9c2f6a0d3e7b1c5f9a2d6e0b4c8f1a5d9e3b7c0f4a8d2e6b1c5f9a3",
      subjectPublicKey: REVOKED_SUBJECT,
      claim: shortStringToFelt("ACCREDITED"),
      expiresAt: Math.floor(Date.parse("2027-03-02T09:14:22Z") / 1000),
    },
    SAMPLE_ISSUER_KEY
  ),
  issuer: SAMPLE_ISSUERS[0]!,
  issuedAt: Math.floor(Date.parse("2026-03-02T09:14:22Z") / 1000),
  revokedAt: Math.floor(Date.parse("2026-08-24T11:03:51Z") / 1000),
  revokedAtBlock: 1_477_340,
};

/** The screening the `NOT_SANCTIONED` attestation was made against. */
export const SAMPLE_SCREENING = {
  list: "OFAC SDN",
  published: "2026-08-25",
  entries: 17_204,
  lastSync: Math.floor(Date.parse("2026-08-26T06:00:11Z") / 1000),
  match: false,
};

/* ── the payer's live budget ────────────────────────────────────────────── */

export type PriorTransfer = { at: number; amount: bigint };

export const SAMPLE_EPOCH_SPEND = strk(9340n);

export const SAMPLE_PRIOR_TRANSFERS: readonly PriorTransfer[] = [
  { at: Math.floor(Date.parse("2026-08-26T04:11:38Z") / 1000), amount: strk(1200n) },
  { at: Math.floor(Date.parse("2026-08-26T08:47:02Z") / 1000), amount: strk(3900n) },
  { at: Math.floor(Date.parse("2026-08-26T12:30:19Z") / 1000), amount: strk(4240n) },
];

/** The nonce the composed authorisation would spend. */
export const SAMPLE_NONCE = "0x1a";

/* ── transactions ───────────────────────────────────────────────────────── */

export type SampleTransaction = {
  hash: string;
  status: "REVERTED" | "ACCEPTED_ON_L2";
  block: number;
  at: number;
  amount: bigint | null;
  fee: string | null;
  revertReason: string | null;
  panicFelt: string | null;
  code: string | null;
};

export const HERO_REVERT: SampleTransaction = {
  hash: "0x06f2b8d1a4c7e0b3d6f9a2c5e8b1d4f7a0c3e6b9d2f5a8c1e4b7d0f3a6c9e21",
  status: "REVERTED",
  block: 1_482_617,
  at: Math.floor(Date.parse("2026-08-26T12:31:44Z") / 1000),
  amount: strk(6500n),
  fee: "0.00218",
  revertReason: "Error in the called contract … execution failed:",
  panicFelt: "0x434f52444f4e5f4f5645525f434150",
  code: "CORDON_OVER_CAP",
};

export const REVOKED_REVERT: SampleTransaction = {
  hash: "0x02c9e6b3d0f7a4c1e8b5d2f9a6c3e0b7d4f1a8c5e2b9d6f3a0c7e4b1d8f5a29",
  status: "REVERTED",
  block: 1_482_344,
  at: Math.floor(Date.parse("2026-08-26T10:18:02Z") / 1000),
  amount: strk(1000n),
  fee: "0.00211",
  revertReason: "Error in the called contract … execution failed:",
  panicFelt: "0x434f52444f4e5f5245564f4b4544",
  code: "CORDON_REVOKED",
};

export const SETTLED_TRANSACTION: SampleTransaction = {
  hash: "0x0417d0a3c6e9b2d5f8a1c4e7b0d3f6a9c2e5b8d1f4a7c0e3b6d9f2a5c8e1b47",
  status: "ACCEPTED_ON_L2",
  block: 1_482_905,
  at: Math.floor(Date.parse("2026-08-26T14:37:51Z") / 1000),
  amount: strk(3200n),
  fee: "0.00305",
  revertReason: null,
  panicFelt: null,
  code: null,
};

export const POLICY_PUBLISH_TX = "0x08b5d2f9a6c3e0b7d4f1a8c5e2b9d6f3a0c7e4b1d8f5a2c9e6b3d0f7a4c1e83";
export const REVOCATION_TX = "0x05e9c2f7a1d4b8e0c3f6a9d2b5e8c1f4a7d0b3e6c9f2a5d8b1e4c7f0a3d6b92";

/* ── the gate monitor's feed ────────────────────────────────────────────── */

/**
 * One row of the gate monitor.
 *
 * There is no party column and there cannot be one. `PolicyPassed` used to
 * carry the subject's pseudonym and no longer does: an event naming the payer
 * and one naming the payee, joinable through a settlement id, would publish a
 * permanent indexed edge between two counterparties and the exact amount that
 * passed between them. The log records that a policy held and how much moved,
 * and stops there.
 */
export type FeedRow = {
  at: number;
  block: number;
  verdict: "pass" | "refused";
  /** The gate event this row came from, or the leg a refusal reverted. */
  kind: "PolicyPassed" | "SettlementFunded" | "SettlementClaimed" | "Direct";
  policyId: string;
  amount: bigint;
  epoch: bigint | null;
  code: string | null;
  reference: string;
};

const feedAt = (clock: string) => Math.floor(Date.parse(`2026-08-26T${clock}Z`) / 1000);

export const SAMPLE_FEED: readonly FeedRow[] = [
  {
    at: feedAt("14:41:52"),
    block: 1_482_912,
    verdict: "refused",
    kind: "Direct",
    policyId: "ACCREDITED_SEED_V2",
    amount: strk(6500n),
    epoch: null,
    code: "CORDON_OVER_CAP",
    reference: HERO_REVERT.hash,
  },
  {
    at: feedAt("14:39:20"),
    block: 1_482_907,
    verdict: "pass",
    kind: "PolicyPassed",
    policyId: "KYC_L2_RETAIL",
    amount: strk(840n),
    epoch: 484_138n,
    code: null,
    reference: "1482907_4_2",
  },
  {
    at: feedAt("14:37:51"),
    block: 1_482_905,
    verdict: "pass",
    kind: "PolicyPassed",
    policyId: "ACCREDITED_SEED_V2",
    amount: strk(3200n),
    epoch: 20_691n,
    code: null,
    reference: SETTLED_TRANSACTION.hash,
  },
  {
    at: feedAt("14:33:07"),
    block: 1_482_896,
    verdict: "refused",
    kind: "Direct",
    policyId: "ACCREDITED_SEED_V2",
    amount: strk(1000n),
    epoch: null,
    code: "CORDON_REVOKED",
    reference: REVOKED_REVERT.hash,
  },
  {
    at: feedAt("14:29:44"),
    block: 1_482_889,
    verdict: "pass",
    kind: "PolicyPassed",
    policyId: "NOT_SANCTIONED_BASE",
    amount: strk(18_500n),
    epoch: 0n,
    code: null,
    reference: "1482889_2_1",
  },
  {
    // 1,400.00 rather than a figure above KYC_L2_RETAIL's 1,500.00 cap: an amount
    // over the cap panics at step 10 and never reaches the velocity check, so it
    // could not carry this code.
    at: feedAt("14:26:11"),
    block: 1_482_882,
    verdict: "refused",
    kind: "Direct",
    policyId: "KYC_L2_RETAIL",
    amount: strk(1400n),
    epoch: null,
    code: "CORDON_OVER_VELOCITY",
    reference: "0x03b6d9f2a5c8e1b4d7f0a3c6e9b2d5f8a1c4e7b0d3f6a9c2e5b8d1f4a7c0e36",
  },
  {
    at: feedAt("14:22:38"),
    block: 1_482_875,
    verdict: "pass",
    kind: "SettlementClaimed",
    policyId: "ACCREDITED_SEED_V2",
    amount: strk(450n),
    epoch: 20_691n,
    code: null,
    reference: "1482875_3_2",
  },
  {
    at: feedAt("14:18:05"),
    block: 1_482_866,
    verdict: "refused",
    kind: "Direct",
    policyId: "NOT_SANCTIONED_BASE",
    amount: strk(9000n),
    epoch: null,
    code: "CORDON_EXPIRED",
    reference: "0x0d4f1a8c5e2b9d6f3a0c7e4b1d8f5a2c9e6b3d0f7a4c1e8b5d2f9a6c3e0b71",
  },
  {
    at: feedAt("14:14:52"),
    block: 1_482_860,
    verdict: "pass",
    kind: "SettlementFunded",
    policyId: "TREASURY_EGRESS_V3",
    amount: strk(120_000n),
    epoch: 2_955n,
    code: null,
    reference: "1482860_5_3",
  },
  {
    at: feedAt("14:09:31"),
    block: 1_482_849,
    verdict: "refused",
    kind: "Direct",
    policyId: "ACCREDITED_SEED_V2",
    amount: strk(5000n) + 10n ** 16n,
    epoch: null,
    code: "CORDON_OVER_CAP",
    reference: "0x0a7c4e1b8d5f2a9c6e3b0d7f4a1c8e5b2d9f6a3c0e7b4d1f8a5c2e9b6d3f04",
  },
];

export const SAMPLE_ROLLUP = {
  windowFrom: 1_482_849,
  windowTo: 1_482_912,
  decisions: 1284,
  passed: 1061,
  refused: 223,
  /** Refusals where a limit was crossed, so a cordon line can be drawn for them. */
  linesCrossed: 157,
  /** Refusals where the credential itself was not good. */
  documentFailed: 66,
  breakdown: [
    { code: "CORDON_OVER_CAP", count: 96, line: true },
    { code: "CORDON_OVER_VELOCITY", count: 61, line: true },
    { code: "CORDON_REVOKED", count: 34, line: false },
    { code: "CORDON_EXPIRED", count: 18, line: false },
    { code: "CORDON_CLAIM_MISMATCH", count: 9, line: false },
    { code: "CORDON_BAD_ISSUER", count: 5, line: false },
  ],
  worstOverCap: { amount: strk(6500n), cap: strk(5000n), block: 1_482_912 },
  smallestOverCap: { over: 10n ** 16n, block: 1_482_849 },
  worstOverVelocity: { amount: strk(13_540n), ceiling: strk(12_000n) },
} as const;

/* ── the issuer console ─────────────────────────────────────────────────── */

export const SAMPLE_ISSUER_CONSOLE = {
  operator: "0x0d6f3a0c7e4b1d8f5a2c9e6b3d0f7a4c1e8b5d2f9a6c3e0b7d4f1a8c5e2b9d6",
  issued: 2847,
  active: 2611,
  revoked: 194,
  expired: 42,
  pendingScreening: 3,
  recent: [
    { claim: "ACCREDITED", subject: PRIMARY_SUBJECT, at: "2026-03-02" },
    {
      claim: "KYC_L2",
      subject: "0x0b7e2d5f8a1c4e7b0d3f6a9c2e5b8d1f4a7c0e3b6d9f2a5c8e1b9a4c11",
      at: "2026-08-19",
    },
    {
      claim: "NOT_SANCTIONED",
      subject: "0x03f8a1c4e7b0d3f6a9c2e5b8d1f4a7c0e3b6d9f2a5c8e1b4d7f0a32e7d40",
      at: "2026-08-25",
    },
  ],
} as const;

/* ── the auditor's disclosure ───────────────────────────────────────────── */

export const SAMPLE_DISCLOSURE = {
  id: "DR-2026-0814-17",
  requestedBy: "Nordbank Attestation (EU)",
  requestedById: "NB_ATTEST_EU",
  auditorKey: "0x0f3a6c9e2b5d8f1a4c7e0b3d6f9a2c5e8b1d4f7a0c3e6b9d2f5a8c1e4b7d0f3",
  policyId: "ACCREDITED_SEED_V2",
  epochFrom: 4468,
  epochTo: 4471,
  blockFrom: 1_478_102,
  blockTo: 1_482_905,
  transfers: 14,
  volume: strk(38_420n),
  passed: 11,
  refused: 3,
  refusedBreakdown: "2 over cap, 1 revoked",
  merkleRoot: "0x0b8d5f2a9c6e3b0d7f4a1c8e5b2d9f6a3c0e7b4d1f8a5c2e9b6d3f0a7c4e1b",
  leaves: 14,
  verifiedInMs: 412,
  /**
   * Fields nobody handed over. Counted rather than merely listed: the number is
   * the sentence that wins this screen.
   */
  withheld: [
    { field: "Counterparties", heldBy: "nobody — pseudonyms only" },
    { field: "Note contents", heldBy: "the payer's wallet" },
    { field: "Wallet addresses", heldBy: "the payer's wallet" },
    { field: "Viewing key", heldBy: "the payer, and only the payer" },
  ],
} as const;

export const WITHHELD_COUNT = SAMPLE_DISCLOSURE.withheld.length;

/* ── honest limits ──────────────────────────────────────────────────────── */

export const HONEST_LIMITS =
  "Amounts are public at the gate. Shielding is public. The pool's measured median effective " +
  "anonymity set is 1.00. Cordon enforces on plaintext value routed through it — not on " +
  "encrypted amounts. We say so.";
