import { describe, expect, it } from "vitest";
import {
  PolicyError,
  createPolicy,
  currentEpoch,
  describePolicy,
  epochResetsAt,
  issueCredential,
  policyCalldata,
  policyFromCalldata,
  preflight,
  subjectPublicKey,
  toFelt,
} from "../src/index.js";
import { CREDENTIAL_FIXTURE, STRK, TEST_ISSUER_PRIVATE_KEY } from "./fixtures.js";

const ISSUER_PUBLIC_KEY = subjectPublicKey(TEST_ISSUER_PRIVATE_KEY);
const credential = issueCredential(CREDENTIAL_FIXTURE, TEST_ISSUER_PRIVATE_KEY);
const NOW = 1_700_000_000;

const policy = createPolicy({
  requiredClaim: "ACCREDITED",
  issuerId: "CORDON_KYC",
  token: STRK,
  maxAmount: 1_000n,
  epochLength: 86_400n,
  maxPerEpoch: 2_500n,
});

const chainState = {
  token: STRK,
  unaccountedBalance: 1_000_000n,
  issuerPublicKey: ISSUER_PUBLIC_KEY,
  issuerActive: true,
  revokedCredentialIds: [] as string[],
  nonceUsed: false,
  epochSpend: 0n,
  now: NOW,
};

describe("policy model", () => {
  it("round-trips through the eight felts the Cairo struct declares", () => {
    const calldata = policyCalldata(policy);
    expect(calldata).toHaveLength(8);
    expect(policyFromCalldata(calldata)).toEqual(policy);
  });

  it("rejects a velocity epoch with no allowance, as the registry does", () => {
    expect(() => createPolicy({ requiredClaim: "ACCREDITED", epochLength: 3_600n })).toThrow(
      PolicyError,
    );
  });

  it("describes itself in sentences", () => {
    expect(describePolicy(policy)).toEqual([
      "Requires the claim ACCREDITED.",
      "Only from the issuer CORDON_KYC.",
      `Only the token at ${toFelt(STRK)}.`,
      "At most 1000 per transaction.",
      "At most 2500 per subject per 86400 seconds.",
    ]);
  });

  it("reports no epoch for a policy with no velocity limit", () => {
    const unlimited = createPolicy({ requiredClaim: "ACCREDITED" });
    expect(currentEpoch(unlimited, NOW)).toBe(0n);
    expect(epochResetsAt(unlimited, NOW)).toBeNull();
  });

  it("computes the epoch the gate would book into", () => {
    expect(currentEpoch(policy, NOW)).toBe(BigInt(Math.floor(NOW / 86_400)));
    expect(epochResetsAt(policy, NOW)).toBe((Math.floor(NOW / 86_400) + 1) * 86_400);
  });
});

describe("preflight", () => {
  it("allows a settlement that satisfies every rule", () => {
    const result = preflight({ policy, credential, amount: 400n, ...chainState });
    expect(result.refusals).toEqual([]);
    expect(result.allowed).toBe(true);
    expect(result.skipped).toEqual([]);
    expect(result.remainingThisEpoch).toBe(2_500n);
  });

  it("names the token pin when the transaction settles a different ERC20", () => {
    const result = preflight({
      policy,
      credential,
      amount: 400n,
      ...chainState,
      token: "0x1234",
    });
    expect(result.refusals.map((refusal) => refusal.code)).toContain("CORDON_TOKEN_NOT_ALLOWED");
  });

  it("names underfunding when the gate cannot back the signed amount", () => {
    // The amount is signed, not read off a balance, so what matters is whether the gate holds
    // enough above what it already owes to open settlements.
    const result = preflight({
      policy,
      credential,
      amount: 400n,
      ...chainState,
      unaccountedBalance: 399n,
    });
    expect(result.refusals.map((refusal) => refusal.code)).toContain("CORDON_UNDERFUNDED");
  });

  it("names the cap when the amount is too large", () => {
    const result = preflight({ policy, credential, amount: 1_001n, ...chainState });
    expect(result.refusal?.code).toBe("CORDON_OVER_CAP");
    expect(result.refusal?.remedy).toBe("payer");
  });

  it("names velocity when the epoch is nearly spent", () => {
    const result = preflight({
      policy,
      credential,
      amount: 600n,
      ...chainState,
      epochSpend: 2_000n,
    });
    expect(result.refusals.map((refusal) => refusal.code)).toEqual(["CORDON_OVER_VELOCITY"]);
    expect(result.remainingThisEpoch).toBe(500n);
  });

  it("reports the first refusal the gate would reach when several apply", () => {
    const retired = createPolicy({ requiredClaim: "ACCREDITED", active: false, maxAmount: 1n });
    const result = preflight({ policy: retired, credential, amount: 400n, ...chainState });
    expect(result.refusal?.code).toBe("CORDON_NO_POLICY");
    expect(result.refusals.map((refusal) => refusal.code)).toContain("CORDON_OVER_CAP");
  });

  it("refuses a policy that needs a payee credential this flow cannot carry", () => {
    const payeePolicy = createPolicy({
      requiredClaim: "ACCREDITED",
      requirePayeeCredential: true,
    });
    const result = preflight({ policy: payeePolicy, credential, amount: 400n, ...chainState });
    expect(result.refusals.map((refusal) => refusal.code)).toContain("CORDON_PAYEE_REQUIRED");
  });

  it("names the issuer when the policy pins a different one", () => {
    const pinned = createPolicy({ requiredClaim: "ACCREDITED", issuerId: "OTHER_KYC" });
    const result = preflight({ policy: pinned, credential, amount: 400n, ...chainState });
    expect(result.refusals.map((refusal) => refusal.code)).toContain("CORDON_BAD_ISSUER");
  });

  it("names a spent nonce", () => {
    const result = preflight({
      policy,
      credential,
      amount: 400n,
      ...chainState,
      nonceUsed: true,
    });
    expect(result.refusals.map((refusal) => refusal.code)).toContain("CORDON_NONCE_USED");
  });

  it("refuses a zero amount, as the gate does when the pool sent nothing", () => {
    const result = preflight({ policy, credential, amount: 0n, ...chainState });
    expect(result.refusals.map((refusal) => refusal.code)).toContain("CORDON_NO_VALUE");
  });

  it("admits what it could not check rather than reporting a confident pass", () => {
    const result = preflight({ policy, credential, amount: 400n, now: NOW });
    expect(result.allowed).toBe(true);
    expect(result.skipped).toContain("nonce is unused (not supplied)");
    expect(result.skipped).toContain("the gate can cover the amount (no unaccountedBalance given)");
    expect(result.skipped).toContain("issuer is active (not supplied)");
    expect(result.skipped).toContain("epoch spend so far (not supplied)");
  });

  it("catches an expired credential before anyone pays for a transaction", () => {
    const result = preflight({
      policy,
      credential,
      amount: 400n,
      ...chainState,
      now: 1_900_000_000,
    });
    expect(result.refusals.map((refusal) => refusal.code)).toContain("CORDON_EXPIRED");
  });
});
