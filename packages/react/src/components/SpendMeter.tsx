"use client";

/**
 * `<SpendMeter>` — enforcement you can watch move.
 *
 * Two bars, because the gate enforces two different limits and a user who trips one needs to know
 * which. The cap is per transaction and static: it either admits this payment or it does not. The
 * velocity is per subject per epoch and cumulative: it drains as the pseudonym settles, and refills
 * when the epoch rolls over.
 *
 * The velocity counter is keyed by `(subject_public_key, policy_id, epoch_index)`, not by wallet
 * address, so a new wallet does not reset it — which is what makes a rate limit real rather than
 * decorative.
 *
 * When the counter cannot be read the track is striped, the value reads "unavailable" and the bar
 * shows nothing. A meter that renders an empty bar for an unreadable counter is telling the user
 * they have their whole allowance left, which is the most dangerous thing it could say.
 */

import { useEffect, useState, type ReactNode } from "react";

import { useCordonConfig } from "../context/CordonProvider.js";
import { useCordonPolicy, type UseCordonPolicy } from "../hooks/useCordonPolicy.js";
import { formatUnits, relativeTime, type FeltLike } from "../strk20/index.js";
import { Heading, cx } from "./primitives.js";

export interface SpendMeterProps {
  /** The policy whose limits to show. Ignored when `policy` is supplied. */
  policyId?: FeltLike | null;
  /** The pseudonym the velocity counter is keyed by. Without it the spend cannot be read. */
  subjectPublicKey?: FeltLike | null;
  /** An already-read policy from `useCordonPolicy`, when the host is managing the read. */
  policy?: UseCordonPolicy;
  /** The payment being considered, so the cap bar shows how close it comes. */
  amount?: bigint | null;
  className?: string;
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  title?: ReactNode | null;
  /** Decimals used to render amounts. Defaults to the configured token's. */
  decimals?: number;
  /** Re-read the counter on this interval. Defaults to 15000ms; 0 polls never. */
  pollMs?: number;
}

interface BarProps {
  label: string;
  /** Null means the value could not be read. It is never treated as zero. */
  used: bigint | null;
  limit: bigint;
  decimals: number;
  detail?: string | null;
  unavailableReason?: string | null;
}

function Bar({ label, used, limit, decimals, detail, unavailableReason }: BarProps): ReactNode {
  const known = used !== null && limit > 0n;
  const ratio = known ? Number((used * 10000n) / limit) / 10000 : 0;
  const percent = Math.min(100, Math.max(0, ratio * 100));
  const tone = !known ? "" : ratio >= 1 ? "cordon-meter--full" : ratio >= 0.8 ? "cordon-meter--warn" : "";

  const valueText = known
    ? `${formatUnits(used, decimals)} of ${formatUnits(limit, decimals)} used`
    : "unavailable — this limit could not be read";

  return (
    <div className={cx("cordon-meter", tone)}>
      <div className="cordon-meter__head">
        <span className="cordon-meter__label" id={`cordon-meter-${label.replace(/\W+/g, "-")}`}>
          {label}
        </span>
        <span className="cordon-meter__value">
          {known ? `${formatUnits(used, decimals)} / ${formatUnits(limit, decimals)}` : "unavailable"}
        </span>
      </div>
      <div
        className={cx("cordon-meter__track", !known && "cordon-meter__track--unavailable")}
        role="meter"
        aria-labelledby={`cordon-meter-${label.replace(/\W+/g, "-")}`}
        aria-valuemin={0}
        aria-valuemax={known ? Number(limit) : 0}
        {...(known ? { "aria-valuenow": Number(used) } : {})}
        aria-valuetext={valueText}
        title={unavailableReason ?? undefined}
      >
        {known ? <div className="cordon-meter__fill" style={{ width: `${percent}%` }} /> : null}
      </div>
      {detail ? <p className="cordon-note">{detail}</p> : null}
    </div>
  );
}

export function SpendMeter({
  policyId,
  subjectPublicKey,
  policy: supplied,
  amount = null,
  className,
  headingLevel = 3,
  title = "Enforcement",
  decimals,
  pollMs = 15000,
}: SpendMeterProps): ReactNode {
  const config = useCordonConfig();
  const read = useCordonPolicy(supplied ? null : (policyId ?? null), {
    subjectPublicKey: subjectPublicKey ?? null,
    pollMs,
  });
  const state = supplied ?? read;
  const places = decimals ?? config.tokenDecimals;

  // A countdown has to tick, and only on the client. One interval, cleared on unmount.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (state.epochResetsAt === null) return;
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, [state.epochResetsAt]);

  if (state.status !== "ready" || !state.policy) {
    return (
      <section className={cx("cordon", "cordon-card", className)} aria-label="Spend limits">
        {title !== null ? <Heading level={headingLevel}>{title}</Heading> : null}
        <p className="cordon-empty" role="status" aria-live="polite">
          {state.status === "missing"
            ? "No policy is published under this id, so there are no limits to show."
            : state.status === "unavailable"
              ? "The policy could not be read, so its limits are unknown."
              : state.status === "loading"
                ? "Reading the policy."
                : "Select a policy to see the limits it enforces."}
        </p>
      </section>
    );
  }

  const { policy } = state;
  const hasCap = policy.maxAmount > 0n;
  const hasVelocity = policy.epochLength > 0n;

  return (
    <section className={cx("cordon", "cordon-card", className)} aria-label="Spend limits">
      <div className="cordon-card__header">
        {title !== null ? <Heading level={headingLevel}>{title}</Heading> : null}
        <span className="cordon-note">{state.label}</span>
      </div>

      {hasCap ? (
        <Bar
          label="This transaction, against the cap"
          used={amount}
          limit={policy.maxAmount}
          decimals={places}
          detail={
            amount !== null && amount > policy.maxAmount
              ? "Over the cap. The gate will refuse this with CORDON_OVER_CAP and the transaction will revert."
              : amount === null
                ? "Enter an amount to see how it sits against the cap."
                : null
          }
        />
      ) : (
        <p className="cordon-note">This policy sets no per-transaction cap.</p>
      )}

      {hasVelocity ? (
        <Bar
          label="This period, against the velocity limit"
          used={state.epochSpend}
          limit={policy.maxPerEpoch}
          decimals={places}
          detail={
            state.epochSpend === null
              ? subjectPublicKey
                ? "The velocity counter could not be read, so how much of this period is already spent is unknown."
                : "Supply a subject pseudonym to read how much of this period is already spent."
              : state.epochResetsAt !== null
                ? `Resets ${relativeTime(state.epochResetsAt - now)}. Counted against the pseudonym, so a new wallet does not reset it.`
                : null
          }
          unavailableReason={state.error?.message ?? null}
        />
      ) : (
        <p className="cordon-note">This policy sets no velocity limit.</p>
      )}
    </section>
  );
}
