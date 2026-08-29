"use client";

import { useEffect, useMemo, useState } from "react";
import {
  readIssuerActive,
  readPolicy,
  useCordonContext,
  useGateFeed,
  type SessionRefusal,
} from "@cordon/react";
import { feltToShortString, refusalForCode, shortStringToFelt, type Refusal } from "@cordon/sdk";

import { ChecksLadder } from "@/components/record/ChecksLadder";
import { CordonLine } from "@/components/record/CordonLine";
import { Folio } from "@/components/record/Folio";
import { RefusalSignal } from "@/components/record/RefusalSignal";
import { ContractRef, TxRef } from "@/components/record/TxRef";
import {
  Agate,
  BigFigure,
  Row,
  Rows,
  Rule,
  SectionHead,
  Stat,
  Unavailable,
} from "@/components/record/primitives";
import { STEP_COUNT, stepOf } from "@/lib/record/enforcement";
import { formatClock, formatCount, formatPercent, formatUnits } from "@/lib/record/format";
import {
  LIVE_CLAIM_POLICY_ID,
  LIVE_POLICY_ID,
  LIVE_SETTLE_POLICY_ID,
} from "@/lib/record/live";
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
 *
 * That asymmetry is also why the two records are two components rather than one
 * with conditionals threaded through every figure. The sample record rolls up
 * 1,284 seeded decisions over a 24-hour window; the chain publishes no refusal
 * feed at all, so the live record can only count what this browser watched
 * happen. They share the decisions table and nothing else — and keeping the
 * sample constants out of the live component is what makes it impossible for a
 * sample transaction hash to reach a Voyager link.
 */
export function MonitorScreen() {
  const source = useRecordSource();
  return source.live ? <LiveMonitor /> : <SampleMonitor />;
}

/* ── live ───────────────────────────────────────────────────────────────── */

/**
 * The published policies this build is configured against.
 *
 * Neither registry can be enumerated — there is no `all_policies()` and no
 * `all_issuers()` — so a count over these ids is the only honest one available,
 * and the screen says so rather than presenting it as the whole registry.
 */
const CONFIGURED_POLICIES = [LIVE_POLICY_ID, LIVE_SETTLE_POLICY_ID, LIVE_CLAIM_POLICY_ID].filter(
  (id): id is string => Boolean(id)
);

/**
 * How far back the live feed looks, in blocks.
 *
 * Named here rather than left to the package default because the screen prints it: an empty table
 * has to say what range it covers, or it reads as a claim about the gate rather than about a
 * window. Mainnet blocks are roughly half a minute apart, so this is about three weeks.
 */
const LOOKBACK_BLOCKS = 60_000;

function LiveMonitor() {
  const { config, registries, refusals } = useCordonContext();
  // The window is named rather than left to the package's default, because the screen has to say
  // how far back it looked. An empty table means nothing in this many blocks — a fact about a
  // stated range, not about the gate's whole life.
  const feed = useGateFeed({ limit: 25, pollMs: 15_000, lookbackBlocks: LOOKBACK_BLOCKS });
  const standing = useRegistryStanding();

  const rows = useMemo<DecisionRow[]>(
    () =>
      feed.entries.map((entry) =>
        entry.verdict === "pass"
          ? {
              id: entry.id,
              at: entry.at,
              block: entry.blockNumber,
              verdict: "pass" as const,
              origin: "event",
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
              origin: "receipt",
              kind: "Direct",
              policyId: entry.policyId ?? "—",
              amount: null,
              epoch: null,
              code: entry.refusal.code,
              reference: entry.transactionHash,
              isHash: true,
            }
      ),
    [feed.entries]
  );

  const byCode = useCodeTally(refusals);
  const worst = byCode[0]?.count ?? 0;
  const latest = refusals[0] ?? null;
  const latestStep = latest ? (latest.refusal.step ?? stepOf(latest.refusal.code)) : null;

  // A read that answered is a fact, including when the answer is none: the range is bounded and
  // named, and the walk is reported as unavailable if it does not reach the head. A read that did
  // not answer is not a zero, and never renders as one.
  const passesRead = feed.status === "unavailable" ? null : feed.passes.length;

  return (
    <article>
      <Folio
        number="04"
        running="Cordon · 04 · Gate monitor"
        title="The public record of decisions"
        facts={[
          { label: "Source", value: "PolicyPassed events · session receipts" },
          {
            label: "Gate",
            value: config.gateAddress ? <ContractRef address={config.gateAddress} live /> : null,
          },
          {
            label: "Window",
            value:
              passesRead === null ? null : `last ${formatCount(LOOKBACK_BLOCKS)} blocks`,
          },
        ]}
      />

      {/* ── the figure ─────────────────────────────────────────────────── */}
      <section className="grid4 items-start pt-gut">
        <div className="span2">
          <BigFigure hero tone="refuse" value={formatCount(refusals.length)} word="Refused">
            refusals this browser session watched happen. There is no refusal feed to read back: a
            refusal panics, the panic reverts the whole pool transaction, and a reverted transaction
            emits nothing. So the passes below are the chain&rsquo;s own and the refusals are
            receipts this page held on to — which is the difference between a gate and a report
            written afterwards.
          </BigFigure>
        </div>
        <Stat
          entries={[
            {
              label: "Passed",
              value: passesRead === null ? null : formatCount(passesRead),
            },
            {
              label: "Refused, this session",
              value: formatCount(refusals.length),
              tone: "refuse",
            },
            {
              label: "Policies in force",
              value: standing.policies === null ? null : formatCount(standing.policies.inForce),
              unit: `of ${CONFIGURED_POLICIES.length} configured`,
            },
            {
              label: "Issuers active",
              value: standing.issuers === null ? null : formatCount(standing.issuers.active),
              unit: standing.issuers === null ? undefined : `of ${standing.issuers.named.length}`,
            },
          ]}
        />
        <div>
          <p className="label pb-tick">What was read</p>
          <Rows>
            <Row
              label="Policy registry"
              value={
                registries?.available ? (
                  <ContractRef address={registries.value.policyRegistry} live />
                ) : null
              }
            />
            <Row
              label="Issuer registry"
              value={
                registries?.available ? (
                  <ContractRef address={registries.value.issuerRegistry} live />
                ) : null
              }
            />
            <Row
              label="Policy ids"
              value={CONFIGURED_POLICIES.length ? CONFIGURED_POLICIES.join(" · ") : null}
            />
            <Row
              label="Issuers named"
              value={standing.issuers === null ? null : standing.issuers.named.join(" · ")}
            />
          </Rows>
          <p className="note pt-tick">
            Neither registry lists what it holds, so these two counts cover the policy ids this
            build settles under and the issuers those policies name. A policy published under an id
            this build does not know about is not counted — and is not claimed to be absent either.
          </p>
        </div>
      </section>

      {/* ── refusals, such as this session has seen ───────────────────── */}
      <SectionHead
        title="Refusals by panic code · this session"
        meta={refusals.length ? `${formatCount(refusals.length)} watched` : "none watched"}
        right="A refusal leaves no trace on chain to count"
      />
      <Rule />

      <section className="grid4 items-start pt-bl">
        <div className="span2">
          {byCode.length ? (
            <div className="grid grid-cols-[minmax(0,22ch)_minmax(0,1fr)_5ch] items-center gap-x-bl">
              {byCode.map((entry) => (
                <div key={entry.refusal.code} className="contents">
                  <span className="font-mono text-agate border-b border-rule py-hair">
                    {entry.refusal.code}
                  </span>
                  <span className="border-b border-rule py-hair">
                    <span
                      className="hairline block"
                      style={{ width: `${(entry.count / worst) * 100}%`, height: 3 }}
                    />
                  </span>
                  <span className="font-display text-body text-right border-b border-rule py-hair">
                    {entry.count}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="lede">
              Nothing has been refused in this session, so there is nothing here to count. This is
              not a chart waiting for data: the chain has none to give.
            </p>
          )}
          {byCode.length ? (
            <p className="note pt-bl">
              Every bar is a transaction this browser submitted and watched revert. Reload the page
              and the tally is gone, because the only copy of it was in this tab.
            </p>
          ) : (
            <p className="note pt-bl">
              Compose a payment over the published cap on screen 01 and it appears here. The sample
              record carries a worked rollup of a full day&rsquo;s refusals.
            </p>
          )}
        </div>

        <div className="span2">
          <p className="label pb-tick">Why there is no rollup to read</p>
          <p className="lede">
            The gate emits <span className="font-mono">PolicyPassed</span> on every leg that clears
            and emits nothing at all on a leg that does not. A refusal is a panic, a panic reverts
            the whole pool transaction, and a reverted transaction leaves no event behind — so no
            node, no indexer and no explorer can hand anyone a refusal feed.
          </p>
          <p className="note pt-tick">
            That is a property worth stating rather than apologising for. A gate that could publish
            its refusals would be publishing which pseudonyms failed which rule, permanently and to
            everyone. The only party who learns a refusal happened is the one who paid the fee to
            find out, and the only record of it is their own receipt.
          </p>
        </div>
      </section>

      {/* ── the feed ──────────────────────────────────────────────────── */}
      <SectionHead
        title="Decisions"
        meta="Newest first"
        right="No row names a party — no gate event carries one"
      />
      <DecisionsTable rows={rows} />
      <p className="note pt-bl">
        A <em>pass</em> row came from a `PolicyPassed` event the chain published. A{" "}
        <em>refused</em> row came from a receipt, because a panic reverts the whole transaction and
        a reverted transaction emits nothing — that asymmetry is exactly what makes this a gate
        rather than a report written afterwards. Neither kind of row carries a subject key: the log
        proves the rules held, not who paid whom.
      </p>
      {feed.status === "unavailable" ? (
        <p className="note pt-tick">
          The event read did not answer: {feed.error?.message ?? "the node was unreachable"}. The
          table is empty because nothing was read, not because nothing happened.
        </p>
      ) : rows.length === 0 ? (
        <p className="note pt-tick">
          Nothing to list: the gate emitted no{" "}
          <span className="font-mono">PolicyPassed</span> event in the last{" "}
          {formatCount(LOOKBACK_BLOCKS)} blocks, and no refusal has been watched here. That is a
          statement about a stated window and not about the gate&rsquo;s whole life — anything
          older than it was not looked at, and is not claimed absent. A read that could not reach
          the chain head is reported as <i>unavailable</i> rather than as an empty window.
        </p>
      ) : null}

      {/* ── one row, opened up ───────────────────────────────────────── */}
      <SectionHead
        title="Under inspection"
        meta={latest ? latest.refusal.code : "Nothing watched yet"}
        right="The enforcement order is fixed in the Cairo contract"
      />
      <Rule weight="thin" />

      <section className="grid4 items-start pt-bl">
        <div className="span2">
          {latest ? (
            <>
              <p className="quote">
                {latest.refusal.title}. <em>The gate refused it.</em>
              </p>
              <div className="pt-bl">
                <RefusalSignal
                  refusal={latest.refusal}
                  transactionHash={latest.transactionHash}
                  at={Math.floor(latest.at / 1000)}
                />
              </div>
              <Rows className="mt-bl">
                <Row label="Policy judged against" value={latest.policyId} />
                <Row label="Origin" value="A receipt this session kept. The chain published nothing." />
              </Rows>
            </>
          ) : (
            <>
              <p className="quote">
                No refusal has been watched in this session.{" "}
                <em>There is nothing to open up.</em>
              </p>
              <p className="lede pt-bl">
                A refusal reaches this screen one way only: a payment composed in this browser is
                submitted, the gate panics, and the receipt comes back here. Nought is the honest
                figure until then — this browser knows exactly how many refusals it watched, which
                is the one count on the page that needs no node to stand behind it. The sample
                record carries a worked example of a transfer refused over the per-transfer cap,
                opened up line by line.
              </p>
            </>
          )}
        </div>

        <div className="span2">
          <p className="label pb-tick">
            {latest
              ? `The pipeline, as it ran — step ${latestStep ?? "—"} of ${STEP_COUNT}`
              : `The pipeline, unrun — ${STEP_COUNT} steps`}
          </p>
          <ChecksLadder
            ran={latest && latestStep !== null ? STEP_COUNT : 0}
            failedAt={latest ? latestStep : null}
            firedCode={latest ? latest.refusal.code : null}
          />
          <p className="note pt-bl">
            The ladder is the contract&rsquo;s enforcement order, read from the SDK rather than
            written here, so it is drawn whether or not anything has run down it. The monitor cannot
            show which pseudonym a refusal belonged to, and does not guess.
          </p>
        </div>
      </section>
    </article>
  );
}

/* ── sample ─────────────────────────────────────────────────────────────── */

function SampleMonitor() {
  const rows = SAMPLE_FEED.map<DecisionRow>((row) => ({
    id: `${row.block}-${row.reference}`,
    at: row.at,
    block: row.block,
    verdict: row.verdict,
    origin: row.verdict === "pass" ? "event" : "receipt",
    kind: row.kind,
    policyId: row.policyId,
    amount: row.amount,
    epoch: row.epoch,
    code: row.code,
    reference: row.reference,
    isHash: row.reference.startsWith("0x"),
  }));

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
            value: `blocks ${formatCount(SAMPLE_ROLLUP.windowFrom)} → ${formatCount(SAMPLE_ROLLUP.windowTo)}`,
          },
          { label: "Block time", value: `~${BLOCK_TIME_SECONDS} s` },
        ]}
      />

      {/* ── the figure ─────────────────────────────────────────────────── */}
      <section className="grid4 items-start pt-gut">
        <div className="span2">
          <BigFigure hero tone="refuse" value={formatCount(SAMPLE_ROLLUP.refused)} word="Refused">
            of {formatCount(SAMPLE_ROLLUP.decisions)} decisions in the trailing 24 hours —{" "}
            {formatPercent(BigInt(SAMPLE_ROLLUP.refused), BigInt(SAMPLE_ROLLUP.decisions))} per
            cent. Every one is a transaction that reverted: the pool moved shielded value to the
            gate, the gate read the credential and the policy, and the value went back where it came
            from.
          </BigFigure>
        </div>
        <Stat
          entries={[
            { label: "Passed", value: formatCount(SAMPLE_ROLLUP.passed) },
            { label: "Decisions 24h", value: formatCount(SAMPLE_ROLLUP.decisions) },
            {
              label: "Refusal rate",
              value: formatPercent(BigInt(SAMPLE_ROLLUP.refused), BigInt(SAMPLE_ROLLUP.decisions)),
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
              value: formatCount(SAMPLE_ROLLUP.documentFailed),
              unit: "refusals",
            },
            {
              label: "A line was crossed",
              value: formatCount(SAMPLE_ROLLUP.linesCrossed),
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
      <DecisionsTable rows={rows} />
      <p className="note pt-bl">
        A <em>pass</em> row came from a `PolicyPassed` event the chain published. A{" "}
        <em>refused</em> row came from a receipt, because a panic reverts the whole transaction and
        a reverted transaction emits nothing — that asymmetry is exactly what makes this a gate
        rather than a report written afterwards. Neither kind of row carries a subject key: the log
        proves the rules held, not who paid whom.
      </p>

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

/* ── pieces ─────────────────────────────────────────────────────────────── */

/** One row of the decisions table, from either record. */
type DecisionRow = {
  id: string;
  at: number | null;
  block: number | null;
  verdict: "pass" | "refused";
  /** A published event, or a receipt. Never both, never blended. */
  origin: string;
  kind: string;
  policyId: string;
  amount: bigint | null;
  epoch: bigint | null;
  code: string | null;
  reference: string | null;
  /** True when the reference is a transaction hash rather than an event locator. */
  isHash: boolean;
};

/**
 * The decisions table, which is the one thing the two records genuinely share.
 *
 * Whether a reference becomes a link is not decided here: `<TxRef>` asks the record source, so a
 * sample hash prints and a live one links, and neither component can override the other's rule.
 */
function DecisionsTable({ rows }: { rows: readonly DecisionRow[] }) {
  return (
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
  );
}

/* ── chain reads ────────────────────────────────────────────────────────── */

/** How the registries stand, as far as the configured ids let anyone see. */
type RegistryStanding = {
  /** Published and active, out of the configured ids. Null when a read did not answer. */
  policies: { inForce: number } | null;
  /** Active issuers among the ones those policies name. Null when a read did not answer. */
  issuers: { active: number; named: readonly string[] } | null;
};

/**
 * The two figures at the top of the live screen, read rather than assumed.
 *
 * A policy that was never published is an answer and counts as not in force; a node that would not
 * answer is not an answer at all and makes the whole figure unavailable. Keeping those apart is
 * the difference between "three policies are live" and "three reads came back".
 */
function useRegistryStanding(): RegistryStanding {
  const { provider, registries } = useCordonContext();
  const [standing, setStanding] = useState<RegistryStanding>({ policies: null, issuers: null });

  useEffect(() => {
    const policyRegistry = registries?.available ? registries.value.policyRegistry : null;
    const issuerRegistry = registries?.available ? registries.value.issuerRegistry : null;
    if (!policyRegistry || !issuerRegistry || CONFIGURED_POLICIES.length === 0) return;

    let cancelled = false;
    void (async () => {
      const readings = await Promise.all(
        CONFIGURED_POLICIES.map((id) => readPolicy(provider, policyRegistry, shortStringToFelt(id)))
      );
      const unread = readings.some((reading) => !reading.available && !reading.missing);
      const published = readings.flatMap((reading) => (reading.available ? [reading.value] : []));

      // Only the issuers those policies actually name. A policy with a zero issuer id takes any
      // active issuer and names nobody, so it contributes none to check.
      const named = new Map<string, string>();
      for (const policy of published) {
        if (BigInt(policy.issuerId) === 0n) continue;
        named.set(BigInt(policy.issuerId).toString(), policy.issuerId);
      }
      const ids = [...named.values()];
      const active = await Promise.all(
        ids.map((id) => readIssuerActive(provider, issuerRegistry, id))
      );
      if (cancelled) return;

      setStanding({
        policies: unread ? null : { inForce: published.filter((entry) => entry.active).length },
        issuers:
          unread || ids.length === 0 || active.some((reading) => !reading.available)
            ? null
            : {
                active: active.filter((reading) => reading.available && reading.value).length,
                named: ids.map((id) => feltToShortString(id) ?? id),
              },
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [provider, registries]);

  return standing;
}

/** This session's refusals, tallied by the code that fired, heaviest first. */
function useCodeTally(
  refusals: readonly SessionRefusal[]
): ReadonlyArray<{ refusal: Refusal; count: number }> {
  return useMemo(() => {
    const tally = new Map<string, { refusal: Refusal; count: number }>();
    for (const entry of refusals) {
      const found = tally.get(entry.refusal.code);
      if (found) found.count += 1;
      else tally.set(entry.refusal.code, { refusal: entry.refusal, count: 1 });
    }
    return [...tally.values()].sort((a, b) => b.count - a.count);
  }, [refusals]);
}
