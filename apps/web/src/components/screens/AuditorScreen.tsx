"use client";

import { useEffect, useState } from "react";

import { CordonLine } from "@/components/record/CordonLine";
import { Folio } from "@/components/record/Folio";
import { SignalPanel } from "@/components/record/SignalPanel";
import { TxRef } from "@/components/record/TxRef";
import { Agate, Row, Rows, Rule, SectionHead } from "@/components/record/primitives";
import { formatCount, formatUnits, shorten } from "@/lib/record/format";
import {
  SAMPLE_DISCLOSURE,
  SETTLED_TRANSACTION,
  WITHHELD_COUNT,
} from "@/lib/record/sample";

/**
 * 05 · AUDITOR — verify a scoped disclosure.
 *
 * The screen exists to make one sentence unavoidable: no viewing key was
 * requested, none was offered, and none exists in this transcript. Everything
 * an auditor sees here was derived from events the chain already published, so
 * the disclosure only says which fourteen rows of a public record to read.
 *
 * The withheld fields are counted rather than merely listed. A list of things
 * you did not hand over reads as a caption; a number reads as a claim, and this
 * one is the claim the whole product rests on.
 */
export function AuditorScreen() {
  const disclosure = SAMPLE_DISCLOSURE;
  const matched = useLeafCount(disclosure.leaves);

  // Epochs are the scale; the disclosed window is a cordon with two edges.
  const epochSpan = { from: disclosure.epochFrom - 2, to: disclosure.epochTo + 3 };
  const epochTicks = Array.from(
    { length: epochSpan.to - epochSpan.from + 1 },
    (_, index) => String(epochSpan.from + index)
  );
  const scaleTop = BigInt(epochSpan.to - epochSpan.from);
  const scopeFrom = BigInt(disclosure.epochFrom - epochSpan.from);
  const scopeTo = BigInt(disclosure.epochTo - epochSpan.from);

  return (
    <article>
      <Folio
        number="05"
        running="Cordon · 05 · Auditor"
        title="Verify a scoped disclosure"
        facts={[
          { label: "Request", value: disclosure.id },
          { label: "Requested by", value: disclosure.requestedBy },
          { label: "Verified locally in", value: `${disclosure.verifiedInMs} ms` },
        ]}
      />

      <section className="grid4 items-start pt-bl">
        <div className="span2">
          <SectionHead title="The request" right="Aggregate only" level={3} />
          <Rows>
            <Row label="Disclosure request" value={disclosure.id} big strong />
            <Row
              label="Requested by"
              value={`${disclosure.requestedBy} · ${disclosure.requestedById}`}
            />
            <Row label="Auditor key" value={disclosure.auditorKey} />
            <Row label="Scope · policy" value={disclosure.policyId} />
            <Row
              label="Scope · epochs"
              value={`${disclosure.epochFrom} → ${disclosure.epochTo}`}
            />
            <Row
              label="Evidence range"
              value={`blocks ${formatCount(disclosure.blockFrom)} → ${formatCount(disclosure.blockTo)}`}
            />
          </Rows>
        </div>

        <div className="span2">
          <SectionHead
            title="The scope, as a cordon"
            right="Everything hatched was never asked for and never handed over"
            level={3}
          />
          <CordonLine
            scoped
            scaleTop={scaleTop}
            cap={scopeFrom}
            cap2={scopeTo}
            cap2Label={String(disclosure.epochTo)}
            capLabel={String(disclosure.epochFrom)}
            amount={scopeTo}
            permitLabel="Out of scope"
            forbidLabel="Out of scope"
            headline={
              <>
                <b>Disclosed window</b> — four epochs of one policy
              </>
            }
            headRight={`${formatUnits(disclosure.volume)} STRK · ${disclosure.transfers} transfers`}
            ticks={epochTicks}
            endcapLabel={`epochs ${disclosure.epochFrom}–${disclosure.epochTo}`}
            foot="The same graphic the gate uses for a spend cap, used here for a disclosure boundary. A limit is a limit."
            verdict={{ label: "In scope", tone: "pass" }}
            valueText={`Epochs ${disclosure.epochFrom} to ${disclosure.epochTo} are in scope; everything outside that range was never disclosed.`}
          />
        </div>
      </section>

      {/* ── disclosed / withheld ─────────────────────────────────────── */}
      <section className="grid4 items-start pt-gut">
        <div className="span2">
          <SectionHead
            title="What is disclosed"
            right="Derived from public events, not from anyone's keys"
            level={3}
          />
          <Agate caption="Disclosed facts">
            <thead>
              <tr>
                <th>Fact</th>
                <th className="num">Value</th>
                <th>Derived from</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Count of transfers</td>
                <td className="num amount">{disclosure.transfers}</td>
                <td className="text-ink-3">PolicyGate events, 4 epochs</td>
              </tr>
              <tr>
                <td>Total volume</td>
                <td className="num amount">{formatUnits(disclosure.volume)} STRK</td>
                <td className="text-ink-3">sum of plaintext gate amounts</td>
              </tr>
              <tr data-verdict="pass">
                <td>Passed</td>
                <td className="num amount">{disclosure.passed}</td>
                <td className="text-ink-3">PolicyPassed</td>
              </tr>
              <tr data-verdict="refused">
                <td>Refused</td>
                <td className="num amount">{disclosure.refused}</td>
                <td className="text-ink-3">reverted transactions</td>
              </tr>
              <tr>
                <td>Policy in force</td>
                <td className="num">{disclosure.policyId}</td>
                <td className="text-ink-3">PolicyRegistry</td>
              </tr>
            </tbody>
          </Agate>
        </div>

        <div className="span2">
          <SectionHead
            title="What is withheld"
            meta={
              <span className="text-ink">
                {WITHHELD_COUNT} fields
              </span>
            }
            right="Not redacted after the fact — never in the transcript"
            level={3}
          />
          <Agate caption="Withheld fields">
            <thead>
              <tr>
                <th>Field</th>
                <th>Held by</th>
                <th>Disclosed</th>
              </tr>
            </thead>
            <tbody>
              {disclosure.withheld.map((entry) => (
                <tr className="withheld" key={entry.field}>
                  <td>{entry.field}</td>
                  <td>{entry.heldBy}</td>
                  <td className="decision">No</td>
                </tr>
              ))}
            </tbody>
          </Agate>
          <p className="note pt-bl">
            {WITHHELD_COUNT} of {WITHHELD_COUNT} withheld. 0 viewing keys handled, and none
            requested.
          </p>
        </div>
      </section>

      {/* ── the point, typographically ───────────────────────────────── */}
      <div className="mt-gut border-t-[3px] border-b border-ink py-gut">
        <div className="grid4 items-start">
          <div className="span2">
            <p className="font-display text-head leading-[33px] tracking-[var(--tracking-tight)] max-w-[24ch] md:text-display md:leading-[48px]">
              No viewing key was ever requested.{" "}
              <em className="not-italic text-ink-3">
                None was offered. None exists in this transcript.
              </em>
            </p>
          </div>
          <div className="span2">
            <SignalPanel
              tone="withheld"
              word="Withheld"
              code="NO_VIEWING_KEY"
              step={
                <>
                  <span className="block">By construction</span>
                  <span className="block">Not by policy</span>
                </>
              }
              sentence={
                <>
                  The auditor verifies {disclosure.leaves} leaves against events the chain already
                  published. Handing over a viewing key would have disclosed every transfer this
                  bearer ever made, in every epoch, under every policy — forever, and to whoever the
                  auditor later becomes.
                </>
              }
              verbatim={<>Merkle root {disclosure.merkleRoot}</>}
            />
          </div>
        </div>
        <p className="note pt-bl">
          The scope was fixed before the proof was built and cannot be widened afterwards: a
          fourteen-leaf tree commits to fourteen leaves. An auditor who wants epoch{" "}
          {disclosure.epochTo + 1} files a new request and gets a new root.
        </p>
      </div>

      {/* ── the verification ─────────────────────────────────────────── */}
      <SectionHead
        title="Merkle verification"
        meta={`${disclosure.leaves} leaves · verified locally, in the browser, against PolicyGate events`}
        right={`blocks ${formatCount(disclosure.blockFrom)} → ${formatCount(disclosure.blockTo)}`}
      />
      <Rule />

      <section className="grid4 items-start pt-gut">
        <div className="span2">
          <ol className="leaves" aria-label={`${disclosure.leaves} Merkle leaves`}>
            {Array.from({ length: disclosure.leaves }, (_, index) => (
              <li
                key={index}
                className={`leaf${index < matched ? " leaf--matched" : ""}`}
                aria-label={`Leaf ${index + 1}: ${index < matched ? "matched" : "checking"}`}
              />
            ))}
          </ol>
          <div className="flex flex-wrap items-baseline gap-bl pt-gut">
            <p
              className="font-display leading-none tracking-[var(--tracking-tight)]"
              style={{ fontSize: 64 }}
              aria-live="polite"
            >
              {matched}
              <span className="text-rule">&thinsp;/&thinsp;{disclosure.leaves}</span>
            </p>
            {matched === disclosure.leaves ? (
              <p className="ml-auto text-right">
                <strong className="block font-display text-sub uppercase tracking-[var(--tracking-label)] text-green">
                  Scope verified
                </strong>
                <span className="label">
                  {disclosure.leaves} of {disclosure.leaves} leaves match on-chain events ·{" "}
                  {disclosure.verifiedInMs} ms
                </span>
              </p>
            ) : null}
          </div>
        </div>

        <div className="span2">
          <Rows>
            <Row label="Merkle root" value={disclosure.merkleRoot} strong />
            <Row label="Leaves" value={String(disclosure.leaves)} />
            <Row label="Verification time" value={`${disclosure.verifiedInMs} ms · local`} />
            <Row
              label="Signature"
              value="Checks out against PolicyGate emitted events"
              tone="pass"
            />
            <Row
              label="Evidence range"
              value={`${formatCount(disclosure.blockFrom)} → ${formatCount(disclosure.blockTo)}`}
            />
            <Row
              label="Last in-scope settlement"
              value={
                <>
                  <TxRef hash={SETTLED_TRANSACTION.hash} /> ·{" "}
                  {formatUnits(SETTLED_TRANSACTION.amount ?? 0n)} STRK
                </>
              }
            />
            <Row
              label="Refusals inside scope"
              value={`${disclosure.refused} · ${disclosure.refusedBreakdown}`}
              tone="refuse"
            />
          </Rows>
          <p className="note pt-bl">
            Every leaf is a transaction hash the auditor can open without asking us for anything.
            That is the whole trick: the record was already public, and the disclosure only says
            which {disclosure.leaves} rows of it to read. Root{" "}
            <span className="font-mono">{shorten(disclosure.merkleRoot)}</span>.
          </p>
        </div>
      </section>
    </article>
  );
}

/**
 * The leaves ticking over.
 *
 * Verification really is fast — a fourteen-leaf tree is nothing — so the count
 * is paced to be readable rather than to represent elapsed work, and it says
 * `412 ms · local` beside itself so nobody mistakes the pacing for the timing.
 */
function useLeafCount(total: number): number {
  // Starts complete: that is what the server renders, and a verified proof must
  // not depend on JavaScript to say so. The effect rewinds and replays it.
  const [matched, setMatched] = useState(total);

  useEffect(() => {
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduced) return;

    const timers: number[] = [];
    const frame = window.requestAnimationFrame(() => {
      setMatched(0);
      for (let leaf = 1; leaf <= total; leaf += 1) {
        timers.push(window.setTimeout(() => setMatched(leaf), leaf * 90));
      }
    });
    return () => {
      window.cancelAnimationFrame(frame);
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [total]);

  return matched;
}
