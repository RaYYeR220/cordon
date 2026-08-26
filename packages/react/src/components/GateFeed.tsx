"use client";

/**
 * `<GateFeed>` — the public record of what the gate allowed, and what it refused.
 *
 * Passes are read from `PolicyPassed` events on chain: anyone can verify them, and they say a
 * policy was satisfied and how much moved without saying who moved it. Refusals cannot come from
 * events, because a refusal reverts its transaction and a reverted transaction emits nothing — so
 * the refusal rows are the ones this session watched happen.
 *
 * The feed labels every row with where it came from rather than blending the two, because a reader
 * who cannot tell a verifiable on-chain fact from a local observation is being misled by the
 * layout.
 */

import type { ReactNode } from "react";
import { feltToShortString } from "@cordon/sdk";

import { useCordonConfig } from "../context/CordonProvider.js";
import { useGateFeed, type GateFeedEntry, type UseGateFeedOptions } from "../hooks/useGateFeed.js";
import { formatUnits, relativeTime, shortHex } from "../strk20/index.js";
import { Badge, Heading, cx } from "./primitives.js";

export interface GateFeedProps extends UseGateFeedOptions {
  className?: string;
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  title?: ReactNode | null;
  /** Decimals used to render amounts. Defaults to the configured token's. */
  decimals?: number;
  /** Explain why refusals are session-local. On by default; it is not obvious and it matters. */
  showProvenanceNote?: boolean;
}

function Row({ entry, decimals }: { entry: GateFeedEntry; decimals: number }): ReactNode {
  if (entry.verdict === "refused") {
    return (
      <li className="cordon-feed__row" data-verdict="refused">
        <Badge verdict="refuse" srLabel="Verdict">
          refused
        </Badge>
        <code className="cordon-mono">{entry.refusal.code}</code>
        <span>{entry.refusal.title}</span>
        <span className="cordon-feed__detail cordon-feed__spacer">
          seen in this session, {relativeTime(Math.floor((entry.at - Date.now()) / 1000))}
        </span>
        {entry.voyagerUrl ? (
          <a
            className="cordon-link cordon-feed__detail"
            href={entry.voyagerUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            {shortHex(entry.transactionHash as string)}
          </a>
        ) : (
          <span className="cordon-feed__detail">predicted, never submitted</span>
        )}
      </li>
    );
  }

  const { event } = entry;
  const detail =
    event.kind === "PolicyPassed"
      ? `${event.policyLabel} · ${formatUnits(event.amount, decimals)}`
      : event.kind === "SettlementFunded"
        ? `escrowed ${formatUnits(event.amount, decimals)} · claim policy ${feltToShortString(event.payeeClaimPolicyId) ?? shortHex(event.payeeClaimPolicyId)}`
        : `${formatUnits(event.amount, decimals)}`;

  const label =
    event.kind === "PolicyPassed"
      ? "passed"
      : event.kind === "SettlementFunded"
        ? "funded"
        : event.kind === "SettlementClaimed"
          ? "claimed"
          : "refunded";

  return (
    <li className="cordon-feed__row" data-verdict="pass">
      <Badge verdict="pass" srLabel="Verdict">
        {label}
      </Badge>
      <span>{detail}</span>
      <span className="cordon-feed__detail cordon-feed__spacer">
        {entry.blockNumber !== null ? `block ${entry.blockNumber}` : "on chain"}
      </span>
      <a
        className="cordon-link cordon-feed__detail"
        href={entry.voyagerUrl}
        target="_blank"
        rel="noreferrer noopener"
      >
        {shortHex(entry.transactionHash)}
      </a>
    </li>
  );
}

export function GateFeed({
  className,
  headingLevel = 3,
  title = "Gate decisions",
  decimals,
  showProvenanceNote = true,
  ...options
}: GateFeedProps): ReactNode {
  const config = useCordonConfig();
  const feed = useGateFeed(options);
  const places = decimals ?? config.tokenDecimals;

  return (
    <section className={cx("cordon", "cordon-card", className)} aria-label="Gate decisions">
      <div className="cordon-card__header">
        {title !== null ? <Heading level={headingLevel}>{title}</Heading> : null}
        {feed.loading ? <span className="cordon-note">reading…</span> : null}
      </div>

      {feed.status === "unavailable" ? (
        <p className="cordon-empty" role="status" aria-live="polite">
          The gate&rsquo;s events could not be read: {feed.error?.message ?? "the node did not answer"}.
          This is not an empty feed — it is an unread one.
        </p>
      ) : feed.status === "loading" ? (
        <p className="cordon-empty" role="status" aria-live="polite">
          Reading the gate&rsquo;s events.
        </p>
      ) : feed.entries.length === 0 ? (
        <p className="cordon-empty">Nothing has settled through this gate yet.</p>
      ) : (
        <ul className="cordon-feed" aria-live="polite" aria-relevant="additions">
          {feed.entries.map((entry) => (
            <Row key={entry.id} entry={entry} decimals={places} />
          ))}
        </ul>
      )}

      {showProvenanceNote ? (
        <p className="cordon-note">
          Passes are read from the gate&rsquo;s <code>PolicyPassed</code> events, so anyone can
          verify them. A refusal reverts its whole transaction and emits nothing, so refusals are
          the ones this session watched happen — they exist on chain only as a reverted receipt.
        </p>
      ) : null}
    </section>
  );
}
