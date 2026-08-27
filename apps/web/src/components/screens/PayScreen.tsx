"use client";

import { useMemo, useState } from "react";
import {
  ConnectWallet,
  useCordonContext,
  useCordonCredential,
  useCordonPolicy,
  useGatedPayment,
} from "@cordon/react";
import { epochResetsAt, type Refusal } from "@cordon/sdk";

import { BindingControl, type BindingMode } from "@/components/record/Binding";
import { ChecksLadder } from "@/components/record/ChecksLadder";
import { CordonLine } from "@/components/record/CordonLine";
import { EpochClock } from "@/components/record/EpochClock";
import { Folio } from "@/components/record/Folio";
import { RefusalSignal } from "@/components/record/RefusalSignal";
import { ContractRef, TxRef } from "@/components/record/TxRef";
import { Row, Rows, Rule, SectionHead } from "@/components/record/primitives";
import { useEnforcementRun } from "@/hooks/useEnforcementRun";
import { useNow } from "@/hooks/useNow";
import { STEP_COUNT } from "@/lib/record/enforcement";
import {
  daysBetween,
  formatCount,
  formatDuration,
  formatInstant,
  formatUnits,
  shorten,
  strk,
} from "@/lib/record/format";
import { LIVE_NOTE_ID, LIVE_PAYEE, LIVE_POLICY_ID } from "@/lib/record/live";
import {
  HERO_REVERT,
  POOL_FEE,
  PRIMARY_CREDENTIAL,
  PRIMARY_SUBJECT,
  SAMPLE_EPOCH_SPEND,
  SAMPLE_GATE,
  SAMPLE_ISSUER_PUBLIC_KEY,
  SAMPLE_NONCE,
  SAMPLE_NOW,
  SAMPLE_POLICY,
  SAMPLE_PRIOR_TRANSFERS,
} from "@/lib/record/sample";
import { useRecordSource } from "@/lib/record/source";
import { judge } from "@/lib/record/verdict";
import { DEFAULT_POOL_ADDRESS, STRK_TOKEN } from "@/lib/strk20";

/**
 * 01 · PAY — the money shot.
 *
 * One amount, composed once, carried through the whole screen: the cordon line
 * it crosses, the pipeline it is judged by, and the refusal it earns. The
 * amount is a single piece of state and is never held twice — in live mode it
 * goes straight to `useGatedPayment`, which signs it, and the withdraw leg is
 * read back off that authorisation rather than typed again.
 */

/** The three amounts worth composing against the sample policy. */
const SCENARIOS = [
  { label: "Within both limits", amount: strk(2000n) },
  { label: "Over the epoch budget", amount: strk(4200n) },
  { label: "Over the per-transfer cap", amount: strk(6500n) },
] as const;

export function PayScreen() {
  const source = useRecordSource();
  const { config } = useCordonContext();
  const [amount, setAmount] = useState<bigint>(SCENARIOS[2].amount);
  // Strong binding is the default and stays the default. The two modes are not
  // equivalent, and the screen never presents them as if they were.
  const [binding, setBinding] = useState<BindingMode>("strong");
  const gateAddress = source.live ? config.gateAddress : SAMPLE_GATE;

  // Live reads. Both no-op on a null id, so the sample record makes no network
  // calls at all and the hook order stays stable across a mode switch.
  const livePolicy = useCordonPolicy(source.live ? LIVE_POLICY_ID : null, {
    pollMs: source.live ? 15_000 : 0,
  });
  const credential = useCordonCredential();
  const payment = useGatedPayment({
    policyId: source.live ? LIVE_POLICY_ID : null,
    amount: source.live ? amount : null,
    payee: source.live ? LIVE_PAYEE : null,
    credential: credential.credential,
    subjectPrivateKey: credential.subject?.privateKey ?? null,
    noteId: LIVE_NOTE_ID,
  });

  const sample = useMemo(
    () =>
      judge({
        policy: SAMPLE_POLICY.policy,
        credential: PRIMARY_CREDENTIAL.credential,
        amount,
        issuerPublicKey: SAMPLE_ISSUER_PUBLIC_KEY,
        issuerActive: true,
        revokedCredentialIds: [],
        nonceUsed: false,
        epochSpend: SAMPLE_EPOCH_SPEND,
        now: SAMPLE_NOW,
        poolAddress: DEFAULT_POOL_ADDRESS,
        policyLabel: SAMPLE_POLICY.id,
      }),
    [amount]
  );

  const refusal: Refusal | null = source.live
    ? (payment.refusal ?? payment.preflight?.refusal ?? null)
    : sample.preflight.refusal;
  const stopsAt = refusal?.step ?? null;
  const skipped = source.live ? (payment.preflight?.skipped ?? []) : sample.preflight.skipped;

  const run = useEnforcementRun({
    stopAt: stopsAt,
    autoRunKey: `${source.mode}:${amount.toString()}:${refusal?.code ?? "clear"}`,
  });

  const policy = source.live ? livePolicy.policy : SAMPLE_POLICY.policy;
  const cap = policy && policy.maxAmount > 0n ? policy.maxAmount : null;
  const ceiling = policy && policy.maxPerEpoch > 0n ? policy.maxPerEpoch : null;
  const spent = source.live ? livePolicy.epochSpend : SAMPLE_EPOCH_SPEND;
  const liveNow = useNow();
  const now = source.live ? liveNow : SAMPLE_NOW;
  const resetsAt = source.live
    ? livePolicy.epochResetsAt
    : epochResetsAt(SAMPLE_POLICY.policy, SAMPLE_NOW);
  const epoch = source.live ? livePolicy.epoch : null;

  // The scale is the limit plus room to show the overshoot, so a bar can always
  // cross the line without leaving the figure.
  const capScale = cap === null ? amount * 2n : (cap * 7n) / 5n;
  const epochScale = ceiling === null ? null : (ceiling * 4n) / 3n;
  const composedTotal = spent === null ? null : spent + amount;

  const stepValues = source.live ? {} : sample.stepValues;

  return (
    <article>
      <Folio
        number="01"
        running="Cordon · 01 · Pay"
        title="Compose a gated private payment"
        facts={[
          { label: "Policy in force", value: source.live ? (livePolicy.label ?? LIVE_POLICY_ID) : SAMPLE_POLICY.id },
          {
            label: "Epoch closes",
            value: resetsAt === null || now === null ? null : formatDuration(resetsAt - now),
          },
          {
            label: "Payer pseudonym",
            value: source.live
              ? (credential.subject?.publicKey ?? null)
              : shorten(PRIMARY_SUBJECT),
          },
        ]}
      />

      {source.live ? <LivePreconditions payment={payment} /> : null}

      <section className="grid4 items-start pt-bl">
        {/* ── what is being composed ─────────────────────────────────────── */}
        <div className="span2">
          <SectionHead
            title="The transfer"
            right="Wallet API · three actions, one transaction"
            level={3}
          />
          <fieldset className="border-0 p-0">
            <legend className="label pb-tick">Amount to compose</legend>
            <div className="flex flex-wrap gap-tick pb-bl">
              {SCENARIOS.map((scenario) => (
                <button
                  key={scenario.label}
                  type="button"
                  className="btn"
                  aria-pressed={amount === scenario.amount}
                  onClick={() => setAmount(scenario.amount)}
                  style={
                    amount === scenario.amount
                      ? { background: "var(--color-ink)", color: "var(--color-paper)" }
                      : undefined
                  }
                >
                  {formatUnits(scenario.amount)}
                  <span className="sr-only"> STRK — {scenario.label}</span>
                </button>
              ))}
            </div>
            <p className="note pb-bl">
              One amount, held once. It is what the pre-flight judges and, in live mode, what the
              subject signs — the withdraw leg is read back off that authorisation rather than
              typed a second time.
            </p>
          </fieldset>

          <div className="border-t border-ink pt-tick pb-bl">
            <BindingControl mode={binding} onChange={setBinding} noteId={LIVE_NOTE_ID} />
          </div>

          <Rows>
            <Row
              label="Amount composed"
              value={`${formatUnits(amount)} STRK`}
              big
              strong
            />
            <Row
              label="Per-transfer cap"
              value={cap === null ? (policy ? "unlimited" : null) : `${formatUnits(cap)} STRK`}
            />
            <Row label="Token · STRK" value={<ContractRef address={STRK_TOKEN} live />} />
            <Row
              label="Privacy pool · STRK20"
              value={<ContractRef address={DEFAULT_POOL_ADDRESS} live />}
            />
            <Row label="Pool fee" value={`${formatUnits(POOL_FEE)} STRK per apply_actions`} />
            <Row
              label="Nonce"
              value={source.live ? "fresh per attempt" : `${SAMPLE_NONCE} · unspent`}
            />
          </Rows>

          <SectionHead
            title="Credential in force"
            right={
              gateAddress ? (
                <>
                  Presented to PolicyGate <ContractRef address={gateAddress} />
                </>
              ) : (
                "No gate address configured"
              )
            }
            level={3}
          />
          {source.live ? (
            <LiveCredentialRows credential={credential} />
          ) : (
            <Rows>
              <Row
                label="Credential id"
                value={shorten(PRIMARY_CREDENTIAL.credential.credentialId)}
              />
              <Row
                label="Issuer"
                value={`${PRIMARY_CREDENTIAL.issuer.id} · ${PRIMARY_CREDENTIAL.issuer.name} · ACTIVE`}
                tone="pass"
              />
              <Row label="Claim" value="'ACCREDITED' · matches policy" tone="pass" />
              <Row label="Subject pseudonym" value={shorten(PRIMARY_SUBJECT)} />
              <Row
                label="Expires"
                value={`${formatInstant(PRIMARY_CREDENTIAL.credential.expiresAt)} · ${daysBetween(
                  SAMPLE_NOW,
                  PRIMARY_CREDENTIAL.credential.expiresAt
                )} days`}
                tone="pass"
              />
              <Row label="Revocation state" value="Not listed in RevocationRegistry" tone="pass" />
            </Rows>
          )}
        </div>

        {/* ── the shape, and the pipeline ────────────────────────────────── */}
        <div className="span2">
          <SectionHead title="Transaction shape" right="Phases non-decreasing" level={3} />
          <ol className="form">
            <Action
              number={1}
              op="withdraw"
              detail={
                <>
                  <i className="not-italic text-ink">{formatUnits(amount + POOL_FEE)} STRK</i>{" "}
                  from the shielded balance{" "}
                  <span className="text-ink-3">
                    ({formatUnits(amount)} + {formatUnits(POOL_FEE)} pool fee)
                  </span>
                </>
              }
            />
            <Action
              number={2}
              op="transfer"
              detail={
                <>
                  to <b>&quot;${"{poolAddress}"}&quot;</b> as <b>&quot;OPEN&quot;</b> → note{" "}
                  <b>&quot;${"{openNoteIds[0]}"}&quot;</b>
                </>
              }
            />
            <Action
              number={3}
              op="invoke"
              detail={
                <>
                  <b>PolicyGate.privacy_invoke(</b>token, pool, note, policy_id=
                  <i className="not-italic text-ink">
                    {source.live ? (LIVE_POLICY_ID ?? "unset") : SAMPLE_POLICY.id}
                  </i>
                  , note_binding=
                  <i className="not-italic text-ink">
                    {binding === "strong" ? "the resolved note" : "NOTE_ANY"}
                  </i>
                  , payer=Credential&#123;…&#125;, sig_r, sig_s, nonce<b>)</b>
                </>
              }
            />
          </ol>
          <p className="note pt-tick">
            At most one invoke-phase action per transaction. The pool moves the value to the gate
            before the gate has decided anything — which is why a refusal has to revert the whole
            transaction rather than decline it.
          </p>

          <SectionHead
            title="Enforcement order"
            meta={`Direct leg · ${STEP_COUNT} steps · fail-closed`}
            right={
              <span className={stopsAt === null ? "" : "text-red"}>
                {stopsAt === null ? "Clears the pipeline" : `Stops at ${stopsAt}`}
              </span>
            }
            level={3}
          />
          <ChecksLadder
            ran={run.ran}
            failedAt={run.settled || run.ran >= (stopsAt ?? STEP_COUNT) ? stopsAt : null}
            values={stepValues}
            firedCode={refusal?.code ?? null}
          />

          <div className="flex flex-wrap items-baseline justify-between gap-tick pt-bl">
            <button type="button" className="btn" onClick={run.run}>
              Run the gate again
            </button>
            <p className="label" aria-live="polite">
              {run.phase === "stepping"
                ? `Step ${run.ran} of ${STEP_COUNT}`
                : run.phase === "driving"
                  ? "Driving the amount to the line"
                  : run.settled
                    ? refusal
                      ? `Refused at step ${stopsAt ?? "—"}`
                      : "Cleared every step"
                    : "Ready"}
            </p>
          </div>

          {skipped.length ? (
            <p className="note pt-bl">
              The pre-flight is a prediction, not a promise. It could not run{" "}
              {skipped.length === 1 ? "one check" : `${skipped.length} checks`}:{" "}
              {skipped.join("; ")}. A green light means nothing checkable would refuse this — never
              that it will settle.
            </p>
          ) : null}
        </div>
      </section>

      {/* ── the cordon line, at hero size ──────────────────────────────── */}
      <SectionHead
        title="The cordon line"
        meta={`Per-transfer cap · ${source.live ? (livePolicy.label ?? LIVE_POLICY_ID ?? "policy") : SAMPLE_POLICY.id}`}
        right={`Scale 0 → ${formatUnits(capScale)} STRK`}
      />
      <Rule />
      <CordonLine
        className="span4"
        size="hero"
        driving={run.driving}
        scaleTop={capScale}
        cap={cap}
        amount={amount}
        flip
        capLabel={cap === null ? undefined : `Cap ${formatUnits(cap)} — do not pass`}
        headline={
          <>
            <b>Amount against cap</b> — everything past the line is prohibited by the policy
          </>
        }
        headRight={`${formatUnits(amount)} / ${cap === null ? "unlimited" : formatUnits(cap)} STRK`}
        ticks={tickLabels(capScale)}
        foot={
          cap !== null && amount > cap ? (
            <>
              The composed amount crosses the hard limit by{" "}
              <b className="font-mono">{formatUnits(amount - cap)}&thinsp;STRK</b>. The gate panics
              at step {refusal?.step ?? "—"}, and no later step is ever evaluated.
            </>
          ) : (
            <>
              The composed amount stays inside the per-transfer cap. That is one limit cleared —
              the epoch budget below is a separate one.
            </>
          )
        }
        verdict={
          cap !== null && amount > cap
            ? { label: "Over cap", tone: "refuse" }
            : { label: "Within cap", tone: "pass" }
        }
      />

      {/* ── the epoch, and the budget draining inside it ───────────────── */}
      <section className="grid4 items-start pt-gut">
        <div className="span2">
          <SectionHead
            title={epoch === null ? "The epoch" : `Epoch ${epoch.toString()}`}
            meta={
              policy && policy.epochLength > 0n
                ? `${(Number(policy.epochLength) / 3600).toFixed(0)}h window`
                : "No velocity limit"
            }
            right={
              resetsAt === null || now === null
                ? "—"
                : `Closes in ${formatDuration(resetsAt - now)}`
            }
            level={3}
          />
          {resetsAt !== null && policy && now !== null ? (
            <EpochClock
              openedAt={resetsAt - Number(policy.epochLength)}
              closesAt={resetsAt}
              now={now}
              marks={source.live ? [] : SAMPLE_PRIOR_TRANSFERS}
            />
          ) : (
            <p className="note">
              This policy sets no velocity limit, so there is no epoch to draw and no budget to
              drain.
            </p>
          )}
          <p className="note pt-bl">
            {source.live
              ? "Prior transfers inside this epoch are not published — the gate keeps a counter, not a list, and no event names a subject. What is readable is the counter itself."
              : "Three transfers have already settled inside this epoch. The budget does not reset on the next block: it resets when the epoch rolls over, and the gate reads the counter from storage rather than from the caller."}
          </p>
        </div>

        <CordonLine
          className="span2"
          driving={run.driving}
          scaleTop={epochScale ?? capScale}
          cap={ceiling}
          amount={composedTotal}
          spent={spent}
          flip
          capLabel={ceiling === null ? undefined : formatUnits(ceiling)}
          headline={
            <>
              <b>Velocity budget</b> —{" "}
              {ceiling === null ? "none set" : `${formatUnits(ceiling)} STRK per epoch`}
            </>
          }
          headRight={
            spent === null
              ? "spend unavailable"
              : `${formatUnits(spent)} spent · ${formatUnits(
                  ceiling === null ? 0n : ceiling - spent
                )} left`
          }
          permitLabel={spent === null ? "Spent" : `Spent ${formatUnits(spent)}`}
          ticks={epochScale ? tickLabels(epochScale, 4) : undefined}
          foot={
            composedTotal !== null && ceiling !== null && composedTotal > ceiling ? (
              <>
                Adding {formatUnits(amount)} crosses this line by{" "}
                <b className="font-mono">{formatUnits(composedTotal - ceiling)}&thinsp;STRK</b>.
                {stopsAt !== null && stopsAt < 11
                  ? " The gate refuses earlier than this and never gets here."
                  : ""}
              </>
            ) : (
              <>The banded bar is the epoch&rsquo;s accumulated spend, not one transfer.</>
            )
          }
          verdict={
            spent === null
              ? { label: "Not readable", tone: "idle" }
              : composedTotal !== null && ceiling !== null && composedTotal > ceiling
                ? stopsAt !== null && stopsAt < 11
                  ? { label: "Not assessed", tone: "idle" }
                  : { label: "Over velocity", tone: "refuse" }
                : { label: "Within budget", tone: "pass" }
          }
        />
      </section>

      {/* ── the refusal ────────────────────────────────────────────────── */}
      <SectionHead
        title="The verdict"
        meta={refusal ? `${refusal.code} · step ${refusal.step ?? "—"} of ${STEP_COUNT}` : "No rule fires"}
        right={
          source.live
            ? payment.transactionHash
              ? "Reverted on Starknet mainnet"
              : "Predicted before signing"
            : "Predicted by the SDK pre-flight"
        }
      />
      <Rule weight={refusal ? "signal" : "ink"} />

      <div aria-live="polite" aria-atomic="false" className="pt-bl">
        {run.settled && refusal ? (
          <>
            <RefusalSignal
              refusal={refusal}
              predicted={source.live ? payment.predicted : true}
              transactionHash={source.live ? payment.transactionHash : null}
              {...(source.live && payment.error?.revertReason
                ? { revertReason: payment.error.revertReason }
                : {})}
            />
            {!source.live && refusal.code === HERO_REVERT.code ? (
              <p className="note pt-tick">
                Nothing was submitted here — this verdict is the pre-flight&rsquo;s. The sample
                record separately carries a transaction that reverted with the same code:{" "}
                <TxRef hash={HERO_REVERT.hash} />, block {formatCount(HERO_REVERT.block)},{" "}
                {formatInstant(HERO_REVERT.at)}, fee {HERO_REVERT.fee}&thinsp;STRK. Its receipt reads{" "}
                <span className="font-mono text-ink">
                  {HERO_REVERT.revertReason} {HERO_REVERT.panicFelt}
                </span>{" "}
                (&lsquo;{HERO_REVERT.code}&rsquo;).
              </p>
            ) : null}
          </>
        ) : run.settled ? (
          <div className="border border-ink p-bl">
            <p className="font-display text-sub uppercase tracking-[var(--tracking-label)] text-green">
              Nothing refuses this
            </p>
            <p className="lede pt-tick">
              Every step the pre-flight could run cleared. That is not a promise the transaction
              will settle — {skipped.length ? "the checks it could not run are listed above, and " : ""}
              chain state can change between this prediction and the block that executes it.
            </p>
          </div>
        ) : (
          <p className="label">The pipeline is running.</p>
        )}
      </div>
    </article>
  );
}

/* ── pieces ─────────────────────────────────────────────────────────────── */

function Action({
  number,
  op,
  detail,
}: {
  number: number;
  op: string;
  detail: React.ReactNode;
}) {
  return (
    <li className="grid grid-cols-[20px_84px_minmax(0,1fr)] items-baseline gap-bl border-b border-rule py-tick">
      <span className="font-display text-lede leading-none text-rule">{number}</span>
      <span className="label">{op}</span>
      <span className="font-mono text-fine leading-[18px] text-ink-2 break-words">{detail}</span>
    </li>
  );
}

function LivePreconditions({ payment }: { payment: ReturnType<typeof useGatedPayment> }) {
  if (!payment.blockers.length) return null;
  return (
    <section className="border-y border-ink py-tick">
      <SectionHead
        title="Before this can be attempted"
        meta={`${payment.blockers.length} missing`}
        level={3}
        className="pt-0"
      />
      <ul className="pt-hair">
        {payment.blockers.map((blocker) => (
          <li key={blocker.code} className="flex gap-bl border-b border-rule py-hair text-fine">
            <span className="font-mono text-agate text-ink-3 w-[18ch] shrink-0">
              {blocker.code}
            </span>
            <span className="text-ink-2">{blocker.message}</span>
          </li>
        ))}
      </ul>
      <div className="pt-bl">
        <ConnectWallet title={null} />
      </div>
    </section>
  );
}

function LiveCredentialRows({
  credential,
}: {
  credential: ReturnType<typeof useCordonCredential>;
}) {
  const summary = credential.summary;
  return (
    <Rows>
      <Row label="Credential id" value={summary ? shorten(summary.credentialId) : null} />
      <Row label="Issuer" value={summary?.issuer ?? null} />
      <Row label="Claim" value={summary ? `'${summary.claim}'` : null} />
      <Row
        label="Subject pseudonym"
        value={credential.subject ? shorten(credential.subject.publicKey) : null}
      />
      <Row
        label="Expires"
        value={summary?.expiresAt ?? null}
        tone={credential.expired ? "refuse" : "pass"}
      />
      <Row
        label="Revocation state"
        value={
          credential.revoked === null ? null : credential.revoked ? "Listed — revoked" : "Not listed"
        }
        tone={credential.revoked ? "refuse" : "pass"}
      />
      <Row
        label="Issuer registry"
        value={
          credential.issuerActive === null
            ? null
            : credential.issuerActive
              ? "Registered and active"
              : "Not accepted"
        }
        tone={credential.issuerActive ? "pass" : "refuse"}
      />
    </Rows>
  );
}

/** Tick labels across a scale, on round numbers a reader can check. */
function tickLabels(top: bigint, divisions = 7): string[] {
  const labels: string[] = [];
  for (let index = 0; index <= divisions; index += 1) {
    const value = (top * BigInt(index)) / BigInt(divisions);
    labels.push(formatCount(value / 10n ** 18n));
  }
  return labels;
}
