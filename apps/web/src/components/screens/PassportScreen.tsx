"use client";

import { useMemo } from "react";
import { PassportCard, useCordonCredential } from "@cordon/react";
import { epochResetsAt, feltToShortString } from "@cordon/sdk";

import { CordonLine } from "@/components/record/CordonLine";
import { Folio } from "@/components/record/Folio";
import { Mrz, Stamp, StampField, mrzField } from "@/components/record/passport";
import { RefusalSignal } from "@/components/record/RefusalSignal";
import { ContractRef, TxRef } from "@/components/record/TxRef";
import { Agate, Row, Rows, Rule, SectionHead } from "@/components/record/primitives";
import { STEP_COUNT } from "@/lib/record/enforcement";
import {
  daysBetween,
  formatCount,
  formatDate,
  formatInstant,
  formatUnits,
  shorten,
} from "@/lib/record/format";
import {
  PRIMARY_CREDENTIAL,
  PRIMARY_SUBJECT,
  REVOKED_CREDENTIAL,
  REVOKED_REVERT,
  REVOKED_SUBJECT,
  SAMPLE_BLOCK,
  SAMPLE_EPOCH_SPEND,
  SAMPLE_NOW,
  SAMPLE_POLICIES,
  SAMPLE_POLICY,
  SAMPLE_POLICY_REGISTRY,
  SAMPLE_REVOCATION_REGISTRY,
  SAMPLE_SCREENING,
  SCREENING_CREDENTIAL,
  SETTLED_TRANSACTION,
} from "@/lib/record/sample";
import { useRecordSource } from "@/lib/record/source";
import { judge } from "@/lib/record/verdict";
import { DEFAULT_POOL_ADDRESS } from "@/lib/strk20";

/**
 * 02 · PASSPORT — the credential, and what it is good for.
 *
 * The one screen that earns a metaphor. A credential is a document presented at
 * a border, so this screen keeps two devices no other screen has: a
 * machine-readable zone built from the credential's own felts, and an impressed
 * stamp from the gate that read it.
 *
 * The verdict column is not written down. Every row runs the SDK's `preflight`
 * against that policy with this credential, so "precisely why" is the gate's
 * own reasoning rather than a caption — and a policy this document does satisfy
 * cannot be labelled refused by accident.
 */
export function PassportScreen() {
  const source = useRecordSource();
  const credential = useCordonCredential();

  const verdicts = useMemo(
    () =>
      SAMPLE_POLICIES.map((entry) => ({
        entry,
        verdict: judge({
          policy: entry.policy,
          credential: PRIMARY_CREDENTIAL.credential,
          amount: 1n,
          issuerPublicKey: PRIMARY_CREDENTIAL.issuer.publicKey,
          issuerActive: true,
          revokedCredentialIds: [],
          nonceUsed: false,
          epochSpend: 0n,
          now: SAMPLE_NOW,
          poolAddress: DEFAULT_POOL_ADDRESS,
          policyLabel: entry.id,
        }),
      })),
    []
  );

  const ceiling = SAMPLE_POLICY.policy.maxPerEpoch;
  const proposed = SAMPLE_EPOCH_SPEND + 4200n * 10n ** 18n;
  const resetsAt = epochResetsAt(SAMPLE_POLICY.policy, SAMPLE_NOW);

  const cred = PRIMARY_CREDENTIAL.credential;

  return (
    <article>
      <Folio
        number="02"
        running="Cordon · 02 · Passport"
        title="The credential, and what it is good for"
        facts={[
          { label: "Document", value: `Type CD · No. ${shorten(cred.credentialId, 10, 0)}` },
          { label: "Issuing authority", value: PRIMARY_CREDENTIAL.issuer.id },
          { label: "Read at block", value: formatCount(SAMPLE_BLOCK) },
        ]}
      />

      <section className="grid4 items-start pt-bl">
        <div className="span2">
          <SectionHead
            title="The bearer"
            right="A pseudonym, never a wallet address"
            level={3}
          />
          <Rows>
            <Row label="Claim" value={`'${feltToShortString(cred.claim) ?? cred.claim}'`} big strong />
            <Row label="Credential id" value={cred.credentialId} />
            <Row label="Subject pseudonym" value={PRIMARY_SUBJECT} />
            <Row
              label="Issuer"
              value={`${PRIMARY_CREDENTIAL.issuer.name} · ${PRIMARY_CREDENTIAL.issuer.id}`}
              tone="pass"
            />
            <Row
              label="Issuer key"
              value={`${shorten(PRIMARY_CREDENTIAL.issuer.publicKey)} · ACTIVE`}
            />
            <Row label="Issued" value={formatInstant(PRIMARY_CREDENTIAL.issuedAt)} />
            <Row
              label="Expires"
              value={`${formatInstant(cred.expiresAt)} · ${daysBetween(SAMPLE_NOW, cred.expiresAt)} days`}
              tone="pass"
            />
            <Row
              label="Revocation state"
              value="VALID · not listed in RevocationRegistry"
              tone="pass"
            />
          </Rows>

          <SectionHead
            title="Second credential on this passport"
            right="Same bearer, different issuer"
            level={3}
          />
          <Rows>
            <Row label="Claim" value="'NOT_SANCTIONED'" />
            <Row
              label="Credential id"
              value={SCREENING_CREDENTIAL.credential.credentialId}
            />
            <Row
              label="Issuer"
              value={`${SCREENING_CREDENTIAL.issuer.name} · ${SCREENING_CREDENTIAL.issuer.id}`}
              tone="pass"
            />
            <Row
              label="Screened against"
              value={`${SAMPLE_SCREENING.list} ${SAMPLE_SCREENING.published} · ${formatCount(
                SAMPLE_SCREENING.entries
              )} entries · no match`}
            />
            <Row
              label="Expires"
              value={`${formatDate(SCREENING_CREDENTIAL.credential.expiresAt)} · ${daysBetween(
                SAMPLE_NOW,
                SCREENING_CREDENTIAL.credential.expiresAt
              )} days`}
              tone="pass"
            />
          </Rows>
        </div>

        <div className="span2">
          <SectionHead title="Endorsement" right="For official use" level={3} />
          <StampField
            caption={`Impressed by PolicyGate at block ${formatCount(SETTLED_TRANSACTION.block)}`}
            height={132}
          >
            <Stamp
              word="Admitted"
              lines={[
                `${SAMPLE_POLICY.id} · ${formatUnits(SETTLED_TRANSACTION.amount ?? 0n)} STRK`,
                formatInstant(SETTLED_TRANSACTION.at),
              ]}
              style={{ left: 48, top: 34 }}
            />
          </StampField>

          <SectionHead
            title="Limits endorsed on this document"
            right={resetsAt === null ? "No epoch" : `Epoch closes ${formatInstant(resetsAt)}`}
            level={3}
          />
          <CordonLine
            scaleTop={(ceiling * 4n) / 3n}
            cap={ceiling}
            amount={proposed}
            spent={SAMPLE_EPOCH_SPEND}
            flip
            capLabel={formatUnits(ceiling)}
            headline={
              <>
                <b>Velocity budget</b> — {formatUnits(ceiling)} STRK per 24h
              </>
            }
            headRight={`${formatUnits(ceiling - SAMPLE_EPOCH_SPEND)} remaining`}
            permitLabel={`Spent ${formatUnits(SAMPLE_EPOCH_SPEND)}`}
            ticks={["0", "4,000", "8,000", "12,000", "16,000"]}
            foot={
              <>
                Compose 4,200.00 against a remainder of{" "}
                {formatUnits(ceiling - SAMPLE_EPOCH_SPEND)} and the bar crosses the line by{" "}
                <b className="font-mono">{formatUnits(proposed - ceiling)}&thinsp;STRK</b>.
              </>
            }
            verdict={{ label: "Over velocity", tone: "refuse" }}
          />
          <p className="note pt-bl">
            The same document that is admitted at{" "}
            {formatUnits(SETTLED_TRANSACTION.amount ?? 0n)}&thinsp;STRK is refused at
            4,200.00&thinsp;STRK. Nothing about the credential changed — the epoch did.
          </p>
        </div>
      </section>

      {/* ── the machine-readable zone ──────────────────────────────────── */}
      <div className="pt-gut">
        <Mrz
          caption={
            <>
              Machine-readable zone · built from the credential&rsquo;s own felts, which is what
              the gate hashes
            </>
          }
          lines={[
            `CDSNMAIN<<${mrzField(feltToShortString(cred.issuerId) ?? "", 14)}<<<<<<<<<<<<<<<<<`,
            `${mrzField(cred.credentialId, 40)}<<<<`,
            `${mrzField(feltToShortString(cred.claim) ?? "", 14)}<${formatDate(
              PRIMARY_CREDENTIAL.issuedAt
            ).replace(/-/g, "")}<${formatDate(cred.expiresAt).replace(/-/g, "")}<<${mrzField(
              PRIMARY_SUBJECT,
              8
            )}<<<<<8`,
          ]}
        />
      </div>

      {/* ── which policies it satisfies ───────────────────────────────── */}
      <SectionHead
        title="Policies this document satisfies — and precisely why it fails the rest"
        meta={
          <>
            PolicyRegistry <ContractRef address={SAMPLE_POLICY_REGISTRY} />
          </>
        }
        right="Every verdict computed by the SDK pre-flight"
      />
      <Agate caption="Policies this credential satisfies">
        <thead>
          <tr>
            <th>Policy</th>
            <th>Required claim</th>
            <th>Issuer required</th>
            <th className="num">Per-transfer cap</th>
            <th className="num">Velocity limit</th>
            <th>Verdict</th>
            <th className="w-[32%]">Precisely why</th>
          </tr>
        </thead>
        <tbody>
          {verdicts.map(({ entry, verdict }) => {
            const refused = !verdict.preflight.allowed;
            return (
              <tr key={entry.id} data-verdict={refused ? "refused" : "pass"}>
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
                    `${formatUnits(entry.policy.maxPerEpoch)} / ${
                      Number(entry.policy.epochLength) / 3600
                    }h`
                  )}
                </td>
                <td className="decision">{refused ? "Refused" : "Admitted"}</td>
                <td className="wrap">
                  {refused ? (
                    <>
                      <span className="code panic">{verdict.preflight.refusal?.code}</span>{" "}
                      <span className="text-ink-3">
                        at step {verdict.preflight.refusal?.step ?? "—"} of {STEP_COUNT} —{" "}
                        {verdict.preflight.refusal?.title.toLowerCase()}
                      </span>
                    </>
                  ) : (
                    <span className="text-ink-3">
                      Claim, issuer, signature, expiry and revocation all clear
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </Agate>
      <p className="note pt-bl">
        NOT_SANCTIONED_BASE is refused <em>on this credential</em> and satisfied by the second one on
        the same passport: {shorten(SCREENING_CREDENTIAL.credential.credentialId)}. A passport holds
        documents; a policy asks for one of them.
      </p>

      {/* ── the revoked document ──────────────────────────────────────── */}
      <SectionHead
        title="A revoked document, for comparison"
        meta={<>Credential {shorten(REVOKED_CREDENTIAL.credential.credentialId)}</>}
        right={
          <>
            RevocationRegistry <ContractRef address={SAMPLE_REVOCATION_REGISTRY} />
          </>
        }
      />
      <Rule weight="signal" />

      <section className="grid4 items-start pt-bl">
        <div className="span3">
          <RevokedRefusal />
          <div className="pt-bl">
            <Mrz
              caption="Machine-readable zone · the revoked document as the gate reads it"
              refused
              lines={[
                `${mrzField(REVOKED_CREDENTIAL.credential.credentialId, 40)}<<<<`,
                `REVOKED<<<${formatDate(REVOKED_CREDENTIAL.revokedAt ?? 0).replace(
                  /-/g,
                  ""
                )}<<<<<<<<<<<<${mrzField(REVOKED_SUBJECT, 8)}<<<<<3`,
              ]}
            />
          </div>
        </div>

        <div>
          <StampField caption="Entry refused" height={198}>
            <Stamp
              word="Revoked"
              tone="revoked"
              lines={[
                `${formatDate(REVOKED_CREDENTIAL.revokedAt ?? 0)} · CORDON_REVOKED`,
                "Nothing settled",
              ]}
              style={{ left: 12, top: 44 }}
            />
          </StampField>
          <p className="note pt-bl">
            The officer never learns who the bearer is. Only whether the document is on the list.
          </p>
        </div>
      </section>

      {/* ── the reader's own credential ───────────────────────────────── */}
      <SectionHead
        title="Your own passport"
        meta={source.live ? "Read from the chain" : "Nothing is loaded in sample mode"}
        right="Derive a pseudonym from your wallet, then load the credential issued for it"
      />
      <Rule weight="thin" />
      <div className="pt-bl max-w-[72ch]">
        <PassportCard credential={credential} allowDerive allowImport title={null} />
      </div>
      <p className="note pt-bl max-w-[74ch]">
        The pseudonym comes first and everything else follows from it. It is derived from one wallet
        signature over a fixed message — nothing is spent, and the same wallet always produces the
        same key — and it is what an issuer attests, what the gate books velocity against, and what
        signs a settlement. It is not a wallet address and reveals nothing about one. Hand it to the
        Issuer console, and paste the credential that comes back into the box above; the Pay screen
        reads both from here.
      </p>
    </article>
  );
}

/** The revoked story, in the same panel every refusal uses. */
function RevokedRefusal() {
  const refusal = useMemo(() => {
    const found = judge({
      policy: SAMPLE_POLICY.policy,
      credential: REVOKED_CREDENTIAL.credential,
      amount: 1000n * 10n ** 18n,
      issuerPublicKey: REVOKED_CREDENTIAL.issuer.publicKey,
      issuerActive: true,
      revokedCredentialIds: [REVOKED_CREDENTIAL.credential.credentialId],
      nonceUsed: false,
      epochSpend: 0n,
      now: SAMPLE_NOW,
      poolAddress: DEFAULT_POOL_ADDRESS,
      policyLabel: SAMPLE_POLICY.id,
    });
    return found.preflight.refusal;
  }, []);

  if (!refusal) return null;

  return (
    <>
      <RefusalSignal
        refusal={refusal}
        transactionHash={REVOKED_REVERT.hash}
        block={REVOKED_REVERT.block}
        at={REVOKED_REVERT.at}
        fee={REVOKED_REVERT.fee}
        revertReason={REVOKED_REVERT.revertReason}
        panicFelt={REVOKED_REVERT.panicFelt}
      />
      <p className="note pt-tick">
        {REVOKED_CREDENTIAL.issuer.name} revoked this credential on{" "}
        {formatInstant(REVOKED_CREDENTIAL.revokedAt ?? 0)} at block{" "}
        {formatCount(REVOKED_CREDENTIAL.revokedAtBlock ?? 0)}. The revocation is a public, permanent
        write — see <TxRef hash={REVOKED_REVERT.hash} />.
      </p>
    </>
  );
}
