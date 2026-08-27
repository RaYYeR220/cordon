/**
 * What the gate would decide, and what each of its steps was looking at.
 *
 * The decision itself is never made here: `preflight()` in `@cordon/sdk` makes
 * it, in the contract's own order, and this module only arranges the answer for
 * a page. That matters more than it sounds — a UI that reimplements "is this
 * over the cap" will eventually disagree with the chain, and the one thing this
 * product cannot afford is a screen that says allowed when the gate says no.
 *
 * The per-step values are display only. Every one of them is read off the same
 * policy and credential the pre-flight was given, so a row cannot show a figure
 * the verdict was not computed from.
 */

import {
  currentEpoch,
  feltToShortString,
  preflight,
  summarizeCredential,
  toBigInt,
  type Credential,
  type Policy,
  type Preflight,
} from "@cordon/sdk";

import { formatUnits, prefix, shorten } from "./format";

export type VerdictInput = {
  policy: Policy;
  credential: Credential;
  amount: bigint;
  issuerPublicKey?: string;
  issuerActive?: boolean;
  revokedCredentialIds?: readonly string[];
  nonceUsed?: boolean;
  epochSpend?: bigint;
  now: number;
  poolAddress: string;
  policyLabel: string;
};

export type Verdict = {
  preflight: Preflight;
  /** The step the gate would stop at, or null when it clears the pipeline. */
  stopsAt: number | null;
  /** Display values keyed by the gate's step number. */
  stepValues: Record<number, string>;
};

export function judge(input: VerdictInput): Verdict {
  const {
    policy,
    credential,
    amount,
    issuerPublicKey,
    issuerActive,
    revokedCredentialIds,
    nonceUsed,
    epochSpend,
    now,
    poolAddress,
    policyLabel,
  } = input;

  const result = preflight({
    policy,
    credential,
    amount,
    now,
    ...(issuerPublicKey !== undefined ? { issuerPublicKey } : {}),
    ...(issuerActive !== undefined ? { issuerActive } : {}),
    ...(revokedCredentialIds !== undefined ? { revokedCredentialIds } : {}),
    ...(nonceUsed !== undefined ? { nonceUsed } : {}),
    ...(epochSpend !== undefined ? { epochSpend } : {}),
  });

  const summary = summarizeCredential(credential, now);
  const daysLeft = Math.floor((credential.expiresAt - now) / 86_400);
  const revoked = (revokedCredentialIds ?? []).some(
    (id) => toBigInt(id) === toBigInt(credential.credentialId)
  );

  const cap = policy.maxAmount;
  const ceiling = policy.maxPerEpoch;
  const spent = epochSpend ?? 0n;

  const stepValues: Record<number, string> = {
    1: prefix(poolAddress),
    2: policyLabel,
    3: `${formatUnits(amount)} STRK`,
    4: feltToShortString(credential.issuerId) ?? shorten(credential.issuerId),
    5: issuerPublicKey ? prefix(issuerPublicKey) : "key not read",
    6: daysLeft >= 0 ? `+${daysLeft} d` : `${daysLeft} d`,
    7: revoked ? "listed" : revokedCredentialIds === undefined ? "not read" : "not listed",
    8: `'${summary.claim}'`,
    9: nonceUsed === true ? "spent" : "unspent",
    10: cap === 0n ? "no cap" : `${formatUnits(amount)} / ${formatUnits(cap)}`,
    11:
      ceiling === 0n
        ? "no budget"
        : `${formatUnits(spent + amount)} / ${formatUnits(ceiling)}`,
    12: policy.epochLength === 0n ? "—" : `epoch ${currentEpoch(policy, now).toString()}`,
  };

  return {
    preflight: result,
    stopsAt: result.refusal?.step ?? null,
    stepValues,
  };
}
