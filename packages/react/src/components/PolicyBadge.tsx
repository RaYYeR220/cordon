"use client";

/**
 * `<PolicyBadge>` — what the rule set actually says, in one glance.
 *
 * A policy is immutable once published, so this is the stable half of the enforcement story: the
 * claim it requires, whose attestation it accepts, the per-transaction cap and the velocity
 * window. `<SpendMeter>` shows the moving half.
 *
 * A policy that could not be read renders as unavailable. A policy id that was never published
 * renders as missing. They are different facts and a UI that conflates them will tell a user their
 * policy does not exist when their RPC is down.
 */

import type { ReactNode } from "react";
import { feltToShortString, toBigInt } from "@cordon/sdk";

import { useCordonConfig } from "../context/CordonProvider.js";
import { useCordonPolicy, type UseCordonPolicy } from "../hooks/useCordonPolicy.js";
import { formatUnits, type FeltLike } from "../strk20/index.js";
import { Badge, Heading, cx } from "./primitives.js";

export interface PolicyBadgeProps {
  /** The policy to read. Ignored when `policy` is supplied. */
  policyId?: FeltLike | null;
  /** An already-read policy, from `useCordonPolicy`, when the host is managing the read. */
  policy?: UseCordonPolicy;
  className?: string;
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  /** Show only the pill, no card, no rule list. For inline use beside a payment button. */
  compact?: boolean;
  /** Decimals used to render caps. Defaults to the configured token's. */
  decimals?: number;
}

const VERDICT = {
  ready: "pass",
  missing: "refuse",
  unavailable: "warn",
  loading: "unknown",
  idle: "unknown",
} as const;

const LABEL = {
  ready: "active",
  missing: "not published",
  unavailable: "unavailable",
  loading: "reading",
  idle: "no policy",
} as const;

export function PolicyBadge({
  policyId,
  policy: supplied,
  className,
  headingLevel = 3,
  compact = false,
  decimals,
}: PolicyBadgeProps): ReactNode {
  const config = useCordonConfig();
  // One of the two is always the source. Calling the hook unconditionally keeps hook order stable;
  // it no-ops on a null id.
  const read = useCordonPolicy(supplied ? null : (policyId ?? null));
  const state = supplied ?? read;
  const places = decimals ?? config.tokenDecimals;

  // A retired policy reads back fine but settles nothing, so it is shown as its own state rather
  // than as a healthy "active".
  const retired = state.policy !== null && !state.policy.active;
  const status = retired ? "missing" : state.status;
  const label = retired ? "retired" : LABEL[state.status];

  const pill = (
    <Badge verdict={VERDICT[status]} srLabel="Policy status">
      {label}
    </Badge>
  );

  if (compact) {
    return (
      <span className={cx("cordon", className)}>
        <span className="cordon-mono">{state.label ?? "—"}</span> {pill}
      </span>
    );
  }

  const claim = state.policy ? (feltToShortString(state.policy.requiredClaim) ?? state.policy.requiredClaim) : null;
  const issuer = state.policy
    ? toBigInt(state.policy.issuerId) === 0n
      ? "any active issuer"
      : (feltToShortString(state.policy.issuerId) ?? state.policy.issuerId)
    : null;

  return (
    <section className={cx("cordon", "cordon-card", className)} aria-label="Policy">
      <div className="cordon-card__header">
        <Heading level={headingLevel}>{state.label ?? "Policy"}</Heading>
        {pill}
      </div>

      <p className="cordon-note" role="status" aria-live="polite">
        {state.status === "ready" && !retired
          ? `Requires ${claim} from ${issuer}.`
          : state.status === "missing"
            ? "Nothing is published under this policy id, or it has been retired. Policies are immutable once published, so a changed rule is a new id."
            : state.status === "unavailable"
              ? `The policy could not be read: ${state.error?.message ?? "the node did not answer"}. Its contents are unknown, not empty.`
              : state.status === "loading"
                ? "Reading the policy from the registry."
                : "No policy selected."}
      </p>

      {state.policy ? (
        <ul className="cordon-rules">
          {state.description.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}

      {state.policy && state.policy.maxAmount > 0n ? (
        <p className="cordon-note">
          Per-transaction cap:{" "}
          <span className="cordon-mono">{formatUnits(state.policy.maxAmount, places)}</span>
        </p>
      ) : null}
    </section>
  );
}
