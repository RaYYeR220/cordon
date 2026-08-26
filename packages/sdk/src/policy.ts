/**
 * Policies, and predicting what the gate will do with one.
 *
 * A policy is a published, immutable rule set: a claim, optionally a pinned issuer, a
 * per-transaction cap and a per-epoch aggregate. The gate reads it and refuses anything outside
 * it. Reproducing that reasoning here means a UI can tell a user *which rule* will stop them
 * before they pay for a transaction that reverts — and can say so in the same words the chain
 * will.
 */

import {
  U128_MAX,
  U64_MAX,
  feltEquals,
  feltToShortString,
  toBigInt,
  toFelt,
  type Felt,
  type FeltLike,
} from "./felt.js";
import { validateCredential, type Credential } from "./credential.js";
import { refusalForCode, type Refusal } from "./refusals.js";

/** A published rule set. Mirrors the Cairo `Policy` struct, field for field and in order. */
export interface Policy {
  /** The claim a credential must carry, e.g. `ACCREDITED`. */
  requiredClaim: Felt;
  /** The issuer that must have signed it. Zero means any active issuer will do. */
  issuerId: Felt;
  /** Most one settlement may move, in token base units. Zero means unlimited. */
  maxAmount: bigint;
  /** Length of a velocity epoch in seconds. Zero disables velocity accounting. */
  epochLength: bigint;
  /** Aggregate one subject may move inside one epoch. Only meaningful with `epochLength`. */
  maxPerEpoch: bigint;
  /** Whether the payee must present a credential too. */
  requirePayeeCredential: boolean;
  /** Whether the policy may still be used. Publication sets this; retirement clears it. */
  active: boolean;
}

/** The same fields in whatever form a caller has them. */
export interface PolicyInput {
  requiredClaim: FeltLike;
  issuerId?: FeltLike;
  maxAmount?: FeltLike;
  epochLength?: FeltLike;
  maxPerEpoch?: FeltLike;
  requirePayeeCredential?: boolean;
  active?: boolean;
}

/** Thrown when a policy is structurally invalid. */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

/** Normalise a policy's fields, applying the defaults the registry itself would. */
export function createPolicy(input: PolicyInput): Policy {
  const maxAmount = toBigInt(input.maxAmount ?? 0);
  const epochLength = toBigInt(input.epochLength ?? 0);
  const maxPerEpoch = toBigInt(input.maxPerEpoch ?? 0);
  if (maxAmount > U128_MAX) throw new PolicyError("maxAmount does not fit in a u128");
  if (maxPerEpoch > U128_MAX) throw new PolicyError("maxPerEpoch does not fit in a u128");
  if (epochLength > U64_MAX) throw new PolicyError("epochLength does not fit in a u64");
  if (epochLength > 0n && maxPerEpoch === 0n) {
    throw new PolicyError(
      "a policy with a velocity epoch needs a non-zero maxPerEpoch, or it refuses every " +
        "settlement (the registry rejects this as CORDON_ZERO_EPOCH_CAP)",
    );
  }
  return {
    requiredClaim: toFelt(input.requiredClaim),
    issuerId: toFelt(input.issuerId ?? 0),
    maxAmount,
    epochLength,
    maxPerEpoch,
    requirePayeeCredential: input.requirePayeeCredential ?? false,
    active: input.active ?? true,
  };
}

/** The policy as the seven felts Cairo's positional `Serde` expects. */
export function policyCalldata(policy: Policy): Felt[] {
  return [
    policy.requiredClaim,
    policy.issuerId,
    toFelt(policy.maxAmount),
    toFelt(policy.epochLength),
    toFelt(policy.maxPerEpoch),
    toFelt(policy.requirePayeeCredential ? 1 : 0),
    toFelt(policy.active ? 1 : 0),
  ];
}

/** Read a policy back out of the seven felts `get_policy` returned. */
export function policyFromCalldata(calldata: readonly FeltLike[]): Policy {
  if (calldata.length !== 7) {
    throw new PolicyError(`a policy is 7 felts, got ${calldata.length}`);
  }
  const at = (index: number): FeltLike => calldata[index] as FeltLike;
  return {
    requiredClaim: toFelt(at(0)),
    issuerId: toFelt(at(1)),
    maxAmount: toBigInt(at(2)),
    epochLength: toBigInt(at(3)),
    maxPerEpoch: toBigInt(at(4)),
    requirePayeeCredential: toBigInt(at(5)) !== 0n,
    active: toBigInt(at(6)) !== 0n,
  };
}

/**
 * The epoch index a settlement lands in right now.
 *
 * Zero for a policy with no velocity limit, matching the gate, which reports zero rather than a
 * meaningless index.
 */
export function currentEpoch(policy: Policy, now = Math.floor(Date.now() / 1000)): bigint {
  if (policy.epochLength === 0n) return 0n;
  return BigInt(Math.floor(now)) / policy.epochLength;
}

/** Unix seconds at which the current velocity epoch rolls over, or `null` if there is none. */
export function epochResetsAt(policy: Policy, now = Math.floor(Date.now() / 1000)): number | null {
  if (policy.epochLength === 0n) return null;
  return Number((currentEpoch(policy, now) + 1n) * policy.epochLength);
}

/** A policy in plain sentences, one rule per line. */
export function describePolicy(policy: Policy): string[] {
  const lines = [
    `Requires the claim ${feltToShortString(policy.requiredClaim) ?? policy.requiredClaim}.`,
  ];
  lines.push(
    toBigInt(policy.issuerId) === 0n
      ? "Accepts that claim from any active issuer."
      : `Only from the issuer ${feltToShortString(policy.issuerId) ?? policy.issuerId}.`,
  );
  lines.push(
    policy.maxAmount === 0n
      ? "No per-transaction cap."
      : `At most ${policy.maxAmount} per transaction.`,
  );
  lines.push(
    policy.epochLength === 0n
      ? "No velocity limit."
      : `At most ${policy.maxPerEpoch} per subject per ${policy.epochLength} seconds.`,
  );
  if (policy.requirePayeeCredential) lines.push("The payee must present a credential as well.");
  if (!policy.active) lines.push("Retired: this policy no longer settles anything.");
  return lines;
}

/** Everything known locally about a settlement about to be attempted. */
export interface PreflightInput {
  /** The policy, as read from the registry. */
  policy: Policy;
  /** The payer's credential. */
  credential: Credential;
  /** The amount that will reach the gate, in token base units. */
  amount: FeltLike;
  /** The issuer's registered public key, if you have read it. Enables the signature check. */
  issuerPublicKey?: FeltLike;
  /** Whether the issuer is registered and active, if you have read it. */
  issuerActive?: boolean;
  /** Credential ids this issuer has revoked, if you have read them. */
  revokedCredentialIds?: readonly FeltLike[];
  /** Whether the nonce about to be used has already settled, if you have read it. */
  nonceUsed?: boolean;
  /** What this subject has already spent in the current epoch, if you have read it. */
  epochSpend?: FeltLike;
  /** Unix seconds to judge expiry and the epoch against. Defaults to now. */
  now?: number;
}

/** What the gate would do, as far as can be worked out off chain. */
export interface Preflight {
  /** True when nothing checkable would refuse this settlement. */
  allowed: boolean;
  /** Every rule that would fire, in the order the gate evaluates them. */
  refusals: Refusal[];
  /** The refusal a user should be shown: the first one the gate would reach. */
  refusal: Refusal | null;
  /** Checks that could not be run because the chain state they need was not supplied. */
  skipped: string[];
  /** Value still available to this subject in the current epoch, or `null` without a limit. */
  remainingThisEpoch: bigint | null;
  /** When the current epoch rolls over, or `null` without a limit. */
  epochResetsAt: number | null;
}

/**
 * Predict the gate's decision, check by check, in the gate's own order.
 *
 * Supply as much chain state as you have. Anything missing is reported in `skipped` rather than
 * assumed to pass — a pre-flight that quietly skips the revocation check and says "allowed" is
 * worse than one that admits it does not know.
 *
 * The order matters and is deliberately the contract's: cheap facts first, signature checks next,
 * limits last, because a legitimate fully-credentialed payer is most likely to trip a limit and is
 * better served by "over your cap" than by a vaguer earlier refusal.
 */
export function preflight(input: PreflightInput): Preflight {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const amount = toBigInt(input.amount);
  const { policy, credential } = input;
  const refusals: Refusal[] = [];
  const skipped: string[] = [];
  const refuse = (code: string): void => {
    const refusal = refusalForCode(code);
    if (refusal) refusals.push(refusal);
  };

  // 2. The policy is published and active, and does not need a payee credential this flow cannot
  //    carry.
  if (!policy.active) refuse("CORDON_NO_POLICY");
  if (policy.requirePayeeCredential) refuse("CORDON_PAYEE_REQUIRED");

  // 3. The pool actually sent value.
  if (amount === 0n) refuse("CORDON_NO_VALUE");
  if (amount > U128_MAX) refuse("CORDON_AMOUNT_OVERFLOW");

  // 4. The issuer is registered, active, and the one the policy pins.
  if (input.issuerActive === false) refuse("CORDON_BAD_ISSUER");
  else if (input.issuerActive === undefined) skipped.push("issuer is active (not supplied)");
  if (toBigInt(policy.issuerId) !== 0n && !feltEquals(policy.issuerId, credential.issuerId)) {
    refuse("CORDON_BAD_ISSUER");
  }

  // 5-8. The credential itself: signature, expiry, revocation, claim.
  const credentialCheck = validateCredential(credential, {
    now,
    ...(input.issuerPublicKey !== undefined ? { issuerPublicKey: input.issuerPublicKey } : {}),
    ...(input.revokedCredentialIds !== undefined
      ? { revokedCredentialIds: input.revokedCredentialIds }
      : {}),
    requiredClaim: policy.requiredClaim,
  });
  refusals.push(...credentialCheck.refusals);
  skipped.push(...credentialCheck.skipped.filter((entry) => !entry.startsWith("issuer pinning")));

  // 9. The subject's authorisation, and its nonce. The signature itself is checked by
  //    `verifySubjectAction`, which needs the note id this settlement will use.
  if (input.nonceUsed === true) refuse("CORDON_NONCE_USED");
  else if (input.nonceUsed === undefined) skipped.push("nonce is unused (not supplied)");

  // 10. The per-transaction cap.
  if (policy.maxAmount !== 0n && amount > policy.maxAmount) refuse("CORDON_OVER_CAP");

  // 11. Velocity.
  let remainingThisEpoch: bigint | null = null;
  if (policy.epochLength === 0n) {
    remainingThisEpoch = null;
  } else if (input.epochSpend === undefined) {
    skipped.push("epoch spend so far (not supplied)");
  } else {
    const spent = toBigInt(input.epochSpend);
    remainingThisEpoch = policy.maxPerEpoch > spent ? policy.maxPerEpoch - spent : 0n;
    if (spent + amount > policy.maxPerEpoch) refuse("CORDON_OVER_VELOCITY");
  }

  return {
    allowed: refusals.length === 0,
    refusals,
    refusal: refusals[0] ?? null,
    skipped,
    remainingThisEpoch,
    epochResetsAt: epochResetsAt(policy, now),
  };
}
