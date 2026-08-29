"use client";

import { useEffect, useMemo, useState } from "react";
import { useCordonContext, useGateFeed } from "@cordon/react";

import { CordonLine } from "@/components/record/CordonLine";
import { Folio } from "@/components/record/Folio";
import { SignalPanel } from "@/components/record/SignalPanel";
import { ContractRef, TxRef } from "@/components/record/TxRef";
import { Agate, Row, Rows, Rule, SectionHead, Unavailable } from "@/components/record/primitives";
import { formatCount, formatUnits, shorten } from "@/lib/record/format";
import {
  SAMPLE_DISCLOSURE,
  SETTLED_TRANSACTION,
  WITHHELD_COUNT,
} from "@/lib/record/sample";
import { useRecordSource } from "@/lib/record/source";

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
 *
 * Live, there is no disclosure — one is a document an auditor hands over, and
 * nobody has handed this browser one. So the live screen is a different and
 * much shorter component: the argument, the machinery, the public evidence a
 * disclosure would be checked against, and `unavailable` in every place the
 * sample record prints a figure. It borrows no numbers from the sample, which
 * is what makes it structurally impossible for one to appear under a live
 * banner.
 */
export function AuditorScreen() {
  const source = useRecordSource();
  return source.live ? <LiveAuditor /> : <SampleAuditor />;
}

/* ── live ───────────────────────────────────────────────────────────────── */

function LiveAuditor() {
  const { config, registries } = useCordonContext();
  // Only what the chain published, and only passes: this is the evidence base an auditor works
  // from, not this session's private receipts.
  const feed = useGateFeed({
    kinds: ["PolicyPassed"] as const,
    limit: 100,
    pollMs: 30_000,
    chainOnly: true,
  });

  const evidence = useEvidence(feed.passes);
  const newest = feed.passes[0] ?? null;

  return (
    <article>
      <Folio
        number="05"
        running="Cordon · 05 · Auditor"
        title="Verify a scoped disclosure"
        facts={[
          { label: "Request", value: null },
          { label: "Requested by", value: null },
          { label: "Verified locally in", value: null },
        ]}
      />

      <section className="border-y border-ink py-tick">
        <p className="font-display text-agate uppercase tracking-[var(--tracking-mega)]">
          No disclosure has been presented in this session
        </p>
        <p className="lede pt-tick max-w-[74ch]">
          A scoped disclosure is a document somebody hands an auditor: one policy, a range of
          epochs, a Merkle root over the gate events inside that range, and nothing else. Nobody has
          handed this browser one, so every field that would come from it says <i>unavailable</i>{" "}
          rather than standing in for one. What is on this page instead is the argument for the
          shape, the machinery that checks it, and the public evidence it would be checked against —
          the last of those read from mainnet.
        </p>
      </section>

      {/* ── the request that has not arrived ─────────────────────────── */}
      <section className="grid4 items-start pt-gut">
        <div className="span2">
          <SectionHead title="The request" right="Nothing received" level={3} />
          <Rows>
            <Row label="Disclosure request" value={null} big strong />
            <Row label="Requested by" value={null} />
            <Row label="Auditor key" value={null} />
            <Row label="Scope · policy" value={null} />
            <Row label="Scope · epochs" value={null} />
            <Row label="Evidence range" value={null} />
          </Rows>
        </div>

        <div className="span2">
          <SectionHead title="Why the scope is the design" right="Aggregate only" level={3} />
          <p className="lede">
            The alternative to a scope is a viewing key, and a viewing key is not a narrower answer
            to the same question — it is a permanent one. It discloses every transfer the bearer
            ever made, in every epoch, under every policy, to whoever holds it and to whoever the
            holder later becomes. A scope is fixed before the proof is built and cannot be widened
            afterwards: a tree of <i>n</i> leaves commits to <i>n</i> leaves, and an auditor who
            wants the next epoch files a new request and gets a new root.
          </p>
          <p className="note pt-tick">
            None of this needs the payer to be online, or us to be. The rows a disclosure points at
            are already public, which is why an auditor can check one against a node we do not run.
          </p>
        </div>
      </section>

      {/* ── the public evidence, read ────────────────────────────────── */}
      <SectionHead
        title="The evidence a disclosure would point at"
        meta={evidence.read ? `${formatCount(evidence.count)} PolicyPassed events` : "nothing read"}
        right={
          <>
            PolicyGate{" "}
            {config.gateAddress ? (
              <ContractRef address={config.gateAddress} live />
            ) : (
              <Unavailable />
            )}
          </>
        }
      />
      <Rule />

      <section className="grid4 items-start pt-bl">
        <div className="span2">
          <Agate caption="Facts readable from published gate events">
            <thead>
              <tr>
                <th>Fact</th>
                <th className="num">Value</th>
                <th>Derived from</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Pass events read</td>
                <td className="num amount">
                  {evidence.read ? formatCount(evidence.count) : <Unavailable />}
                </td>
                <td className="text-ink-3">PolicyPassed</td>
              </tr>
              <tr>
                <td>Total volume in those events</td>
                <td className="num amount">
                  {evidence.read ? `${formatUnits(evidence.volume)} STRK` : <Unavailable />}
                </td>
                <td className="text-ink-3">sum of plaintext gate amounts</td>
              </tr>
              <tr>
                <td>Blocks covered</td>
                <td className="num">
                  {evidence.from === null || evidence.to === null ? (
                    <Unavailable />
                  ) : (
                    `${formatCount(evidence.from)} → ${formatCount(evidence.to)}`
                  )}
                </td>
                <td className="text-ink-3">block numbers on those events</td>
              </tr>
              <tr>
                <td>Policies named</td>
                <td className="num">
                  {evidence.policies.length ? evidence.policies.join(" · ") : <Unavailable />}
                </td>
                <td className="text-ink-3">PolicyPassed policy id</td>
              </tr>
              <tr data-verdict="refused">
                <td>Refusals in that range</td>
                <td className="num amount">
                  <Unavailable />
                </td>
                <td className="text-ink-3">nothing to read — a revert emits no event</td>
              </tr>
            </tbody>
          </Agate>
          {feed.status === "unavailable" ? (
            <p className="note pt-bl">
              The event read did not answer: {feed.error?.message ?? "the node was unreachable"}.
              Every figure above says <i>unavailable</i> because nothing was read, not because
              nothing has happened.
            </p>
          ) : evidence.read ? null : (
            <p className="note pt-bl">
              No event came back. The read walks a bounded number of pages rather than the whole
              chain, so this says none was found in what was read — not that the gate has passed
              nothing. Every figure says <i>unavailable</i> for that reason, and none of them says
              nought.
            </p>
          )}
        </div>

        <div className="span2">
          <SectionHead title="What a transcript never carries" level={3} right="Not redaction" />
          <Rows>
            <Row label="Counterparties" value="nobody holds them — the gate's log is pseudonymous" />
            <Row label="Note contents" value="the payer's wallet" />
            <Row label="Wallet addresses" value="the payer's wallet" />
            <Row label="Viewing key" value="the payer, and only the payer" />
          </Rows>
          <p className="note pt-tick">
            None of it is taken out of a disclosure, because none of it was ever in one. A{" "}
            <span className="font-mono">PolicyPassed</span> event names the policy, the token, the
            amount and the epoch, and stops — no subject key, no payee, no settlement graph. An
            auditor reading every event this gate ever emitted still could not say who paid whom.
          </p>
          <p className="note pt-tick">
            The one thing the chain publishes and this product does not hide: the amount at the gate
            is plaintext. Shielding is public too. The record says so on every screen.
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
                  This is the one claim on the screen that does not depend on a read. There is no
                  viewing key in the protocol to request, so there is none to refuse — an auditor is
                  pointed at events the chain already published and verifies them without being
                  handed anything.
                </>
              }
              verbatim={
                <>
                  Merkle root <Unavailable />
                </>
              }
            />
          </div>
        </div>
      </div>

      {/* ── the verification ─────────────────────────────────────────── */}
      <SectionHead
        title="Merkle verification"
        meta="Local, in the auditor's own browser, against PolicyGate events"
        right={
          evidence.from === null || evidence.to === null ? (
            <Unavailable />
          ) : (
            `blocks ${formatCount(evidence.from)} → ${formatCount(evidence.to)}`
          )
        }
      />
      <Rule />

      <section className="grid4 items-start pt-gut">
        <div className="span2">
          <p className="lede">
            There are no leaves drawn here because there is no tree. A leaf is one transaction a
            disclosure commits to, and with no disclosure there is nothing to commit to and nothing
            to check it against — so this screen shows the machinery and no result, rather than a
            progress bar over an empty set.
          </p>
          <p className="note pt-tick">
            Nor could this build check a disclosure that was pasted into it: the transcript format
            and its verifier are not part of the SDK this page loads. That is less of a gap than it
            sounds. Verification runs against events any node will serve, so an auditor checks a
            root with their own tooling against their own node — which is the property worth having.
            A verifier that only we can run is a verifier the auditor has to trust.
          </p>
        </div>

        <div className="span2">
          <Rows>
            <Row label="Merkle root" value={null} strong />
            <Row label="Leaves" value={null} />
            <Row label="Verification time" value={null} />
            <Row label="Signature" value={null} />
            <Row
              label="Evidence range"
              value={
                evidence.from === null || evidence.to === null
                  ? null
                  : `${formatCount(evidence.from)} → ${formatCount(evidence.to)}`
              }
            />
            <Row
              label="Most recent settlement read"
              value={
                newest && newest.verdict === "pass" ? (
                  <>
                    <TxRef hash={newest.transactionHash} /> ·{" "}
                    {formatUnits(newest.event.amount)} STRK
                  </>
                ) : null
              }
            />
            <Row label="Refusals inside scope" value={null} />
          </Rows>
          <p className="note pt-bl">
            Read from{" "}
            {registries?.available ? (
              <ContractRef address={registries.value.policyRegistry} live />
            ) : (
              "an unread policy registry"
            )}{" "}
            and the gate above. Every leaf a real disclosure carries is a transaction hash the
            auditor can open without asking anyone for anything — the record was already public, and
            a disclosure only says which rows of it to read.
          </p>
        </div>
      </section>
    </article>
  );
}

/* ── sample ─────────────────────────────────────────────────────────────── */

function SampleAuditor() {
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

/* ── pieces ─────────────────────────────────────────────────────────────── */

/** What the published pass events add up to, which is all a live auditor has to work with. */
type Evidence = {
  /** False until a read has actually answered, so nothing renders as a zero in the meantime. */
  read: boolean;
  count: number;
  volume: bigint;
  from: number | null;
  to: number | null;
  policies: readonly string[];
};

function useEvidence(passes: ReturnType<typeof useGateFeed>["passes"]): Evidence {
  return useMemo(() => {
    const events = passes.flatMap((entry) => (entry.verdict === "pass" ? [entry.event] : []));
    if (events.length === 0) {
      return { read: false, count: 0, volume: 0n, from: null, to: null, policies: [] };
    }
    const blocks = events
      .map((event) => event.blockNumber)
      .filter((block): block is number => block !== null);
    return {
      read: true,
      count: events.length,
      volume: events.reduce((total, event) => total + event.amount, 0n),
      from: blocks.length ? Math.min(...blocks) : null,
      to: blocks.length ? Math.max(...blocks) : null,
      policies: [
        ...new Set(
          events.flatMap((event) => (event.kind === "PolicyPassed" ? [event.policyLabel] : []))
        ),
      ],
    };
  }, [passes]);
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
