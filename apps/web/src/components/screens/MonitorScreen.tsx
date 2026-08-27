"use client";

import { useMemo } from "react";
import { useGateFeed } from "@cordon/react";
import { refusalForCode } from "@cordon/sdk";

import { ChecksLadder } from "@/components/record/ChecksLadder";
import { CordonLine } from "@/components/record/CordonLine";
import { Folio } from "@/components/record/Folio";
import { RefusalSignal } from "@/components/record/RefusalSignal";
import { TxRef } from "@/components/record/TxRef";
import {
  Agate,
  BigFigure,
  Rule,
  SectionHead,
  Stat,
  Unavailable,
} from "@/components/record/primitives";
import { STEP_COUNT, stepOf } from "@/lib/record/enforcement";
import { formatClock, formatCount, formatPercent, formatUnits } from "@/lib/record/format";
import {
  BLOCK_TIME_SECONDS,
  HERO_REVERT,
  SAMPLE_FEED,
  SAMPLE_ISSUERS,
  SAMPLE_POLICIES,
  SAMPLE_ROLLUP,
} from "@/lib/record/sample";
import { useRecordSource } from "@/lib/record/source";

/**
 * 04 · GATE MONITOR — the public record of decisions.
 *
 * There is no party column on this screen and there cannot be one.
 * `PolicyPassed` used to carry the subject's pseudonym and no longer does: an
 * event naming the payer and one naming the payee, joinable through a
 * settlement id, would publish a permanent indexed edge between two
 * counterparties and the exact amount that moved between them. So the log
 * records that a policy held and how much passed, and stops there — which is
 * the privacy claim being kept rather than merely stated.
 *
 * The other asymmetry is structural: there is no refusal *event* and there
 * cannot be one. A refusal panics, the panic reverts the whole pool
 * transaction, and a reverted transaction emits nothing. Every row therefore
 * says where it came from — a published event, or a receipt.
 */
export function MonitorScreen() {
  const source = useRecordSource();
  const feed = useGateFeed({ limit: 25, pollMs: source.live ? 15_000 : 0 });

  const rows = useMemo(() => {
    if (!source.live) {
      return SAMPLE_FEED.map((row) => ({
        id: `${row.block}-${row.reference}`,
        at: row.at,
        block: row.block,
        verdict: row.verdict,
        origin: row.verdict === "pass" ? ("event" as const) : ("receipt" as const),
        kind: row.kind,
        policyId: row.policyId,
        amount: row.amount,
        epoch: row.epoch,
        code: row.code,
        reference: row.reference,
        isHash: row.reference.startsWith("0x"),
      }));
    }

    return feed.entries.map((entry) =>
      entry.verdict === "pass"
        ? {
            id: entry.id,
            at: entry.at,
            block: entry.blockNumber,
            verdict: "pass" as const,
            origin: "event" as const,
            kind: entry.event.kind,
            policyId: entry.event.kind === "PolicyPassed" ? entry.event.policyLabel : "—",
            amount: entry.event.amount,
            epoch: entry.event.kind === "PolicyPassed" ? entry.event.epoch : null,
            code: null,
            reference: entry.transactionHash,
            isHash: true,
          }
        : {
            id: entry.id,
            at: Math.floor(entry.at / 1000),
            block: entry.blockNumber,
            verdict: "refused" as const,
            origin: "receipt" as const,
            kind: "Direct" as const,
            policyId: entry.policyId ?? "—",
            amount: null,
            epoch: null,
            code: entry.refusal.code,
            reference: entry.transactionHash,
            isHash: true,
          }
    );
  }, [source.live, feed.entries]);

  const heroRefusal = refusalForCode(HERO_REVERT.code ?? "") ?? null;
  const overCap = SAMPLE_ROLLUP.breakdown[0]!;
  const overVelocity = SAMPLE_ROLLUP.breakdown[1]!;
  const lineless = SAMPLE_ROLLUP.breakdown.filter((entry) => !entry.line);
  const maxLineless = Math.max(...lineless.map((entry) => entry.count));

  return (
    <article>
      <Folio
        number="04"
        running="Cordon · 04 · Gate monitor"
        title="The public record of decisions"
        facts={[
          { label: "Source", value: "PolicyPassed events · revert receipts" },
          {
            label: "Window",
            value: source.live
              ? feed.status === "unavailable"
                ? null
                : `${rows.length} most recent`
              : `blocks ${formatCount(SAMPLE_ROLLUP.windowFrom)} → ${formatCount(SAMPLE_ROLLUP.windowTo)}`,
          },
          { label: "Block time", value: `~${BLOCK_TIME_SECONDS} s` },
        ]}
      />

      {/* ── the figure ─────────────────────────────────────────────────── */}
      <section className="grid4 items-start pt-gut">
        <div className="span2">
          <BigFigure
            hero
            tone="refuse"
            value={source.live ? String(rows.filter((r) => r.verdict === "refused").length) : formatCount(SAMPLE_ROLLUP.refused)}
            word="Refused"
          >
            {source.live ? (
              <>
                refusals this session watched happen. There is no refusal event to read back — a
                revert emits nothing — so this counts what this browser saw, not what the chain
                published. The passes below are the chain&rsquo;s own.
              </>
            ) : (
              <>
                of {formatCount(SAMPLE_ROLLUP.decisions)} decisions in the trailing 24 hours —{" "}
                {formatPercent(BigInt(SAMPLE_ROLLUP.refused), BigInt(SAMPLE_ROLLUP.decisions))} per
                cent. Every one is a transaction that reverted: the pool moved shielded value to the
                gate, the gate read the credential and the policy, and the value went back where it
                came from.
              </>
            )}
          </BigFigure>
        </div>
        <Stat
          entries={[
            {
              label: "Passed",
              value: source.live
                ? formatCount(feed.passes.length)
                : formatCount(SAMPLE_ROLLUP.passed),
            },
            {
              label: "Decisions 24h",
              value: source.live ? null : formatCount(SAMPLE_ROLLUP.decisions),
            },
            {
              label: "Refusal rate",
              value: source.live
                ? null
                : formatPercent(BigInt(SAMPLE_ROLLUP.refused), BigInt(SAMPLE_ROLLUP.decisions)),
              unit: "%",
              tone: "refuse",
            },
            { label: "Block time", value: `~${BLOCK_TIME_SECONDS}`, unit: "s" },
          ]}
        />
        <Stat
          entries={[
            {
              label: "The document failed",
              value: source.live ? null : formatCount(SAMPLE_ROLLUP.documentFailed),
              unit: "refusals",
            },
            {
              label: "A line was crossed",
              value: source.live ? null : formatCount(SAMPLE_ROLLUP.linesCrossed),
              unit: "refusals",
              tone: "refuse",
            },
            { label: "Policies in force", value: formatCount(SAMPLE_POLICIES.length) },
            {
              label: "Issuers active",
              value: formatCount(SAMPLE_ISSUERS.filter((i) => i.state === "ACTIVE").length),
              unit: `of ${SAMPLE_ISSUERS.length}`,
            },
          ]}
        />
      </section>

      {/* ── the two codes that are lines ──────────────────────────────── */}
      <SectionHead
        title="Refusals by panic code · a line was crossed"
        meta={`${formatCount(SAMPLE_ROLLUP.linesCrossed)} of ${formatCount(SAMPLE_ROLLUP.refused)} · trailing 24h`}
        right="The same cordon line, read the same way, everywhere in this record"
      />
      <Rule />

      <section className="grid4 items-start pt-bl">
        <CordonLine
          className="span2"
          scaleTop={(SAMPLE_ROLLUP.worstOverCap.cap * 7n) / 5n}
          cap={SAMPLE_ROLLUP.worstOverCap.cap}
          amount={SAMPLE_ROLLUP.worstOverCap.amount}
          flip
          capLabel={`Cap ${formatUnits(SAMPLE_ROLLUP.worstOverCap.cap)}`}
          headline={
            <>
              <b>{overCap.code}</b> &nbsp;·&nbsp; {overCap.count} refusals &nbsp;·&nbsp;
              per-transfer cap
            </>
          }
          headRight={`worst ${formatUnits(SAMPLE_ROLLUP.worstOverCap.amount)} / ${formatUnits(SAMPLE_ROLLUP.worstOverCap.cap)}`}
          ticks={["0", "1,000", "2,000", "3,000", "4,000", "5,000", "6,000", "7,000"]}
          foot={
            <>
              Largest overshoot in the window:{" "}
              {formatUnits(SAMPLE_ROLLUP.worstOverCap.amount - SAMPLE_ROLLUP.worstOverCap.cap)}
              &thinsp;STRK, at block {formatCount(SAMPLE_ROLLUP.worstOverCap.block)}. The smallest:{" "}
              {formatUnits(SAMPLE_ROLLUP.smallestOverCap.over)}&thinsp;STRK.
            </>
          }
          verdict={{ label: `${overCap.count} × over cap`, tone: "refuse" }}
        />

        <CordonLine
          className="span2"
          scaleTop={(SAMPLE_ROLLUP.worstOverVelocity.ceiling * 4n) / 3n}
          cap={SAMPLE_ROLLUP.worstOverVelocity.ceiling}
          amount={SAMPLE_ROLLUP.worstOverVelocity.amount}
          spent={(SAMPLE_ROLLUP.worstOverVelocity.ceiling * 7n) / 9n}
          flip
          capLabel={`${formatUnits(SAMPLE_ROLLUP.worstOverVelocity.ceiling)} / 24h`}
          headline={
            <>
              <b>{overVelocity.code}</b> &nbsp;·&nbsp; {overVelocity.count} refusals &nbsp;·&nbsp;
              epoch budget
            </>
          }
          headRight={`worst ${formatUnits(SAMPLE_ROLLUP.worstOverVelocity.amount)} / ${formatUnits(SAMPLE_ROLLUP.worstOverVelocity.ceiling)}`}
          permitLabel="Already spent"
          ticks={["0", "4,000", "8,000", "12,000", "16,000"]}
          foot="The bar is the epoch's accumulated spend, not one transfer. It resets when the epoch rolls over and at no other moment."
          verdict={{ label: `${overVelocity.count} × over velocity`, tone: "refuse" }}
        />

        <div className="span4 pt-gut">
          <SectionHead
            title="Refusals by panic code · no line was crossed"
            meta={`${formatCount(SAMPLE_ROLLUP.documentFailed)} of ${formatCount(SAMPLE_ROLLUP.refused)} · the credential itself was not good`}
            right="These codes have no cordon line to draw"
            level={3}
          />
          {/* One grid, not one per row: bars that do not share an axis are not a
              comparison, they are four unrelated rules. */}
          <div className="grid grid-cols-[minmax(0,22ch)_minmax(0,1fr)_5ch] items-center gap-x-bl">
            {lineless.map((entry) => (
              <div key={entry.code} className="contents">
                <span className="font-mono text-agate border-b border-rule py-hair">
                  {entry.code}
                </span>
                <span className="border-b border-rule py-hair">
                  <span
                    className="hairline block"
                    style={{ width: `${(entry.count / maxLineless) * 100}%`, height: 3 }}
                  />
                </span>
                <span className="font-display text-body text-right border-b border-rule py-hair">
                  {entry.count}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── the feed ──────────────────────────────────────────────────── */}
      <SectionHead
        title="Decisions"
        meta="Newest first"
        right="No row names a party — no gate event carries one"
      />
      <Agate caption="Gate decisions, newest first">
        <thead>
          <tr>
            <th>Time UTC</th>
            <th className="num">Block</th>
            <th>Decision</th>
            <th>Event</th>
            <th>Policy</th>
            <th className="num">Amount STRK</th>
            <th className="num">Epoch</th>
            <th>Panic code</th>
            <th>Origin</th>
            <th>Reference</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} data-verdict={row.verdict}>
              <td>{row.at === null ? <Unavailable /> : formatClock(row.at)}</td>
              <td className="num">{row.block === null ? <Unavailable /> : formatCount(row.block)}</td>
              <td className="decision">{row.verdict === "pass" ? "Pass" : "Refused"}</td>
              <td className="code">{row.kind}</td>
              <td>{row.policyId}</td>
              <td className="num amount">
                {row.amount === null ? <Unavailable /> : formatUnits(row.amount)}
              </td>
              <td className="num">
                {row.epoch === null ? <span className="text-ink-3">—</span> : row.epoch.toString()}
              </td>
              <td className="code panic">{row.code ?? <span className="text-ink-3">—</span>}</td>
              <td className="text-ink-3">{row.origin}</td>
              <td>
                {row.reference === null ? (
                  <Unavailable />
                ) : row.isHash ? (
                  <TxRef hash={row.reference} />
                ) : (
                  <span className="font-mono">{row.reference}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Agate>
      <p className="note pt-bl">
        A <em>pass</em> row came from a `PolicyPassed` event the chain published. A{" "}
        <em>refused</em> row came from a receipt, because a panic reverts the whole transaction and
        a reverted transaction emits nothing — that asymmetry is exactly what makes this a gate
        rather than a report written afterwards. Neither kind of row carries a subject key: the log
        proves the rules held, not who paid whom.
      </p>
      {source.live && feed.status === "unavailable" ? (
        <p className="note pt-tick">
          The event read did not answer: {feed.error?.message ?? "the node was unreachable"}. The
          table is empty because nothing was read, not because nothing happened.
        </p>
      ) : null}

      {/* ── one row, opened up ───────────────────────────────────────── */}
      <SectionHead
        title="Under inspection"
        meta={`Block ${formatCount(SAMPLE_ROLLUP.worstOverCap.block)}`}
        right="The enforcement order is fixed in the Cairo contract"
      />
      <Rule weight="thin" />

      <section className="grid4 items-start pt-bl">
        <div className="span2">
          <p className="quote">
            {formatUnits(SAMPLE_ROLLUP.worstOverCap.amount)}&thinsp;STRK exceeds the{" "}
            {formatUnits(SAMPLE_ROLLUP.worstOverCap.cap)}&thinsp;STRK per-transfer cap.{" "}
            <em>The gate refused it.</em>
          </p>
          {heroRefusal ? (
            <div className="pt-bl">
              <RefusalSignal
                refusal={heroRefusal}
                transactionHash={HERO_REVERT.hash}
                block={HERO_REVERT.block}
                at={HERO_REVERT.at}
                fee={HERO_REVERT.fee}
                revertReason={HERO_REVERT.revertReason}
                panicFelt={HERO_REVERT.panicFelt}
              />
            </div>
          ) : null}
        </div>

        <div className="span2">
          <p className="label pb-tick">
            The pipeline, as it ran — step {stepOf(HERO_REVERT.code) ?? "—"} of {STEP_COUNT}
          </p>
          <ChecksLadder
            ran={STEP_COUNT}
            failedAt={stepOf(HERO_REVERT.code)}
            firedCode={HERO_REVERT.code}
            values={{
              3: `${formatUnits(SAMPLE_ROLLUP.worstOverCap.amount)} STRK`,
              10: `${formatUnits(SAMPLE_ROLLUP.worstOverCap.amount)} / ${formatUnits(SAMPLE_ROLLUP.worstOverCap.cap)}`,
            }}
          />
          <p className="note pt-bl">
            The monitor cannot show which pseudonym this was, and does not guess. It knows the
            policy, the token, the amount and the block, because those are what the gate publishes.
          </p>
        </div>
      </section>
    </article>
  );
}
