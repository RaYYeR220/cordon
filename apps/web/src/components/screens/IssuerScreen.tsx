"use client";

import { useId, useState } from "react";

import { LiveIssuerConsole } from "@/components/screens/LiveIssuerConsole";
import { CordonLine } from "@/components/record/CordonLine";
import { Folio } from "@/components/record/Folio";
import { ProhibitedMark } from "@/components/record/Pictograms";
import { ContractRef, TxRef } from "@/components/record/TxRef";
import {
  Agate,
  BigFigure,
  Rule,
  SectionHead,
  Stat,
} from "@/components/record/primitives";
import { formatCount, formatInstant, formatUnits, shorten } from "@/lib/record/format";
import { useRecordSource } from "@/lib/record/source";
import {
  POLICY_PUBLISH_TX,
  PRIMARY_SUBJECT,
  REVOCATION_TX,
  REVOKED_CREDENTIAL,
  REVOKED_REVERT,
  REVOKED_SUBJECT,
  SAMPLE_BLOCK,
  SAMPLE_ISSUERS,
  SAMPLE_ISSUER_CONSOLE,
  SAMPLE_ISSUER_REGISTRY,
  SAMPLE_POLICIES,
  SAMPLE_POLICY_REGISTRY,
  SAMPLE_REVOCATION_REGISTRY,
  SAMPLE_SCREENING,
} from "@/lib/record/sample";

/**
 * 03 · ISSUER CONSOLE — issue, revoke, publish.
 *
 * Forms as ruled stationery. No boxes, no cards: a label, a rule, and the value
 * sitting on it, which is what a form has looked like on paper for a century
 * and reads as consequential rather than as a web page.
 *
 * The revoke order carries the weight of the only irreversible act on this
 * screen — a heavy rule, an ISO 7010 prohibition mark and a typed confirmation
 * — but not the colour. Red belongs to refusal, and revocation is not a
 * refusal; it is what manufactures them. The only red here is the code the
 * revocation will cause, named before the button rather than after it.
 */
export function IssuerScreen() {
  const source = useRecordSource();
  const issuer = SAMPLE_ISSUERS[0]!;
  const confirmPhrase = `REVOKE ${shorten(REVOKED_CREDENTIAL.credential.credentialId, 10, 0)}`;
  const [confirmation, setConfirmation] = useState("");
  const armed = confirmation.trim().toUpperCase() === confirmPhrase.toUpperCase();
  const ids = useId();

  // The sample console is a drawing of a console. Live, none of it may stand in for the chain or
  // for a service that is not there, so the two are separate components rather than one with
  // conditionals threaded through every figure.
  if (source.live) return <LiveIssuerConsole />;

  return (
    <article>
      <Folio
        number="03"
        running="Cordon · 03 · Issuer console"
        title="Issue, revoke, publish"
        facts={[
          { label: "Signed in as", value: issuer.name },
          { label: "Issuer id", value: `${issuer.id} · ${issuer.state}` },
          { label: "Operator", value: shorten(SAMPLE_ISSUER_CONSOLE.operator) },
        ]}
      />

      <section className="grid4 items-start pt-gut">
        <div className="span2">
          <BigFigure hero value={formatCount(SAMPLE_ISSUER_CONSOLE.issued)} word="Issued">
            credentials signed by this issuer since the registry opened. Every one is a felt the gate
            can verify without ever learning who the bearer is — and{" "}
            {formatCount(SAMPLE_ISSUER_CONSOLE.revoked)} of them are a permanent public record that
            we changed our mind.
          </BigFigure>
        </div>
        <Stat
          entries={[
            { label: "Active", value: formatCount(SAMPLE_ISSUER_CONSOLE.active) },
            { label: "Revoked", value: formatCount(SAMPLE_ISSUER_CONSOLE.revoked) },
            { label: "Expired", value: formatCount(SAMPLE_ISSUER_CONSOLE.expired) },
            {
              label: "Pending screening",
              value: formatCount(SAMPLE_ISSUER_CONSOLE.pendingScreening),
              unit: "in queue",
            },
          ]}
        />
        <div>
          <p className="label border-t border-ink pt-hair pb-tick">Recent issues</p>
          <dl className="rows border-t-0">
            {SAMPLE_ISSUER_CONSOLE.recent.map((entry) => (
              <div className="rw" key={entry.claim}>
                <dt>&lsquo;{entry.claim}&rsquo;</dt>
                <dd className="v">
                  {shorten(entry.subject)}
                  <br />
                  {entry.at}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ── the screening feed ────────────────────────────────────────── */}
      <div className="mt-gut">
        <Rule weight="thin" />
        <div className="grid4 items-baseline py-tick">
          <div className="flex items-baseline gap-bl">
            <span className="label">Screening feed</span>
            <span className="font-display text-sub tracking-[var(--tracking-label)]">
              {SAMPLE_SCREENING.list}
            </span>
          </div>
          <p className="font-mono text-fine text-ink-2">published {SAMPLE_SCREENING.published}</p>
          <p className="font-mono text-fine text-ink-2">
            {formatCount(SAMPLE_SCREENING.entries)} entries
          </p>
          <p className="font-mono text-fine text-ink-2 sm:text-right">
            last sync {formatInstant(SAMPLE_SCREENING.lastSync)}
          </p>
        </div>
        <Rule weight="thin" />
      </div>

      {/* ── issue / revoke ────────────────────────────────────────────── */}
      <section className="grid4 items-start pt-gut">
        <div className="span2">
          <SectionHead
            title="Issue a credential"
            right={<>Signed with {shorten(issuer.publicKey)}</>}
            level={3}
          />
          <div className="form">
            <Field id={`${ids}-sub`} label="Subject pseudonym" defaultValue={PRIMARY_SUBJECT} />
            <Field id={`${ids}-claim`} label="Claim" defaultValue="'KYC_L2'" />
            <Field id={`${ids}-exp`} label="Expires at" defaultValue="2027-08-19 00:00:00 UTC" />
            <Field
              id={`${ids}-scr`}
              label="Screening"
              defaultValue={`${SAMPLE_SCREENING.list} ${SAMPLE_SCREENING.published} · ${formatCount(
                SAMPLE_SCREENING.entries
              )} entries · no match`}
            />
            <Field
              id={`${ids}-reg`}
              label="Registry write"
              defaultValue="none — the credential never touches the chain"
            />
          </div>
          <div className="flex flex-wrap items-center gap-bl pt-bl">
            <button type="button" className="btn" disabled>
              Sign and issue
            </button>
            <p className="note">
              Issuance is performed by the issuer service, not by this console — the signing key does
              not belong in a browser. What the chain ever sees is the hash, verified against this
              issuer&rsquo;s registered key at the moment of settlement.
            </p>
          </div>
        </div>

        <div className="span2">
          <SectionHead
            title="Revoke a credential"
            meta="Irreversible"
            right={
              <>
                RevocationRegistry <ContractRef address={SAMPLE_REVOCATION_REGISTRY} />
              </>
            }
            level={3}
          />
          <Rule weight="heavy" />
          <div className="order mt-bl">
            <div className="flex items-start gap-bl pb-bl">
              <span className="shrink-0">
                <ProhibitedMark size={64} />
              </span>
              <p className="lede">
                Revocation is a public, permanent write. From the next block every gate on Starknet
                reads this credential as dead — mid-flight transactions included. There is no
                un-revoke.
              </p>
            </div>
            <div className="form">
              <Field
                id={`${ids}-cred`}
                label="Credential id"
                defaultValue={REVOKED_CREDENTIAL.credential.credentialId}
              />
              <Field id={`${ids}-rsub`} label="Subject pseudonym" defaultValue={REVOKED_SUBJECT} />
              <Field
                id={`${ids}-rclaim`}
                label="Claim carried"
                defaultValue={`'ACCREDITED' · issued ${formatInstant(REVOKED_CREDENTIAL.issuedAt).slice(0, 10)}`}
              />
              <div className="field">
                <label htmlFor={`${ids}-conf`}>Type to confirm</label>
                <input
                  id={`${ids}-conf`}
                  type="text"
                  value={confirmation}
                  placeholder={confirmPhrase}
                  aria-describedby={`${ids}-conf-help`}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </div>
            </div>
            <p id={`${ids}-conf-help`} className="note pt-tick">
              Type <span className="font-mono text-ink">{confirmPhrase}</span> to arm the button.
              Effective from block {formatCount(SAMPLE_BLOCK + 1)}.{" "}
              {formatCount(SAMPLE_ISSUER_CONSOLE.revoked)} credentials revoked to date — this makes{" "}
              <span className="text-ink">{formatCount(SAMPLE_ISSUER_CONSOLE.revoked + 1)}</span>.
              From that block on, every settlement this bearer attempts is refused with{" "}
              <span className="font-mono text-red">CORDON_REVOKED</span>.
            </p>
            <p className="note pt-tick border-t border-rule mt-bl">
              The last revocation under this key settled at block{" "}
              {formatCount(REVOKED_CREDENTIAL.revokedAtBlock ?? 0)} and refused a{" "}
              {formatUnits(REVOKED_REVERT.amount ?? 0n)}&thinsp;STRK transfer two hours later:{" "}
              <TxRef hash={REVOCATION_TX} />
            </p>
            <div className="pt-bl">
              <button
                type="button"
                className="btn btn--heavy"
                disabled={!armed}
                aria-disabled={!armed}
              >
                <span>Sign and publish revocation</span>
                <span className="font-mono normal-case tracking-normal">
                  {shorten(REVOKED_CREDENTIAL.credential.credentialId)}
                </span>
              </button>
              <p className="note pt-tick" role="status">
                {armed
                  ? "Armed. In a live deployment this would submit the registry write and there would be no way back."
                  : "Not armed — the confirmation does not match."}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── the published policies ────────────────────────────────────── */}
      <SectionHead
        title="Published policies"
        meta={
          <>
            PolicyRegistry <ContractRef address={SAMPLE_POLICY_REGISTRY} />
          </>
        }
        right={
          <>
            Last publish <TxRef hash={POLICY_PUBLISH_TX} />
          </>
        }
      />
      <Agate caption="Published policies">
        <thead>
          <tr>
            <th>Policy id</th>
            <th>Required claim</th>
            <th>Issuer</th>
            <th className="num">Per-transfer cap</th>
            <th className="num">Velocity limit</th>
            <th>Payee cred</th>
            <th className="num">Ver</th>
            <th className="w-[280px]">Cap line · largest amount seen in 24h</th>
          </tr>
        </thead>
        <tbody>
          {SAMPLE_POLICIES.map((entry) => (
            <tr key={entry.id}>
              <td>{entry.id}</td>
              <td className="code">&lsquo;{entry.claimLabel}&rsquo;</td>
              <td>{entry.issuerLabel}</td>
              <td className="num amount">
                {entry.policy.maxAmount === 0n ? (
                  <span className="text-ink-3">unlimited</span>
                ) : (
                  formatUnits(entry.policy.maxAmount)
                )}
              </td>
              <td className="num">
                {entry.policy.maxPerEpoch === 0n ? (
                  <span className="text-ink-3">—</span>
                ) : (
                  `${formatUnits(entry.policy.maxPerEpoch)} / ${Number(entry.policy.epochLength) / 3600}h`
                )}
              </td>
              <td className={entry.policy.requirePayeeCredential ? "" : "text-ink-3"}>
                {entry.policy.requirePayeeCredential ? "required" : "no"}
              </td>
              <td className="num">{entry.version}</td>
              <td style={{ paddingTop: 11, paddingBottom: 11, minWidth: 280 }}>
                <CordonLine
                  size="mini"
                  scaleTop={entry.scaleTop}
                  cap={entry.policy.maxAmount === 0n ? null : entry.policy.maxAmount}
                  amount={entry.largestSeen}
                  ticks={[
                    "0",
                    entry.policy.maxAmount === 0n
                      ? "no cap — no line to draw"
                      : `cap ${formatUnits(entry.policy.maxAmount)}`,
                    formatCount(entry.scaleTop / 10n ** 18n),
                  ]}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </Agate>
      <p className="note pt-bl">
        One policy in this register has no line: NOT_SANCTIONED_BASE caps nothing, because sanctions
        screening is a question about the document rather than about the amount. The other three draw
        a line, and the gate holds it.
      </p>

      {/* ── the issuer registry ──────────────────────────────────────── */}
      <SectionHead
        title="Issuer registry"
        meta={
          <>
            IssuerRegistry <ContractRef address={SAMPLE_ISSUER_REGISTRY} />
          </>
        }
        right="A deactivated issuer fails at step 4, before the signature is even read"
      />
      <Agate caption="Registered issuers">
        <thead>
          <tr>
            <th>Issuer id</th>
            <th>Display name</th>
            <th>Public key</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {SAMPLE_ISSUERS.map((entry) => (
            <tr key={entry.id} data-verdict={entry.state === "ACTIVE" ? "pass" : undefined}>
              <td>{entry.id}</td>
              <td>{entry.name}</td>
              <td className="pseudonym">{entry.publicKey}</td>
              <td className="decision">
                {entry.state === "ACTIVE"
                  ? "Active"
                  : `Deactivated ${entry.stateNote ?? ""}`.trim()}
                {entry.state === "ACTIVE" ? null : (
                  <span className="font-mono text-red normal-case tracking-normal">
                    {" "}
                    · CORDON_BAD_ISSUER
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Agate>
    </article>
  );
}

function Field({
  id,
  label,
  defaultValue,
}: {
  id: string;
  label: string;
  defaultValue: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="text" defaultValue={defaultValue} spellCheck={false} />
    </div>
  );
}
