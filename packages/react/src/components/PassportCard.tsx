"use client";

/**
 * `<PassportCard>` — the credential, and what the chain currently thinks of it.
 *
 * A Cordon credential carries no name, no address and no document: six asserted felts about a
 * pseudonym the holder generated locally. So this card shows what there is — issuer, claim,
 * expiry, subject key — and, more importantly, the live standing of each check the gate will run.
 *
 * The state worth designing for is the third one. A credential can be valid, refused, or of
 * **unknown** standing because a registry read failed. Unknown is rendered as unknown. Treating an
 * unreadable revocation registry as "not revoked" would be the single most dangerous shortcut this
 * component could take.
 */

import { useState, type ReactNode } from "react";

import { useCordonContext } from "../context/CordonProvider.js";
import { useCordonCredential, type UseCordonCredential } from "../hooks/useCordonCredential.js";
import { relativeTime, shortHex } from "../strk20/index.js";
import { Badge, Fields, Heading, Unavailable, cx } from "./primitives.js";
import { RefusalNotice } from "./RefusalNotice.js";

export interface PassportCardProps {
  /** An already-loaded credential from `useCordonCredential`. One is created when omitted. */
  credential?: UseCordonCredential;
  className?: string;
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  title?: ReactNode | null;
  /** Show a paste box for loading a credential from JSON, an encoded string, or a URI. */
  allowImport?: boolean;
  /**
   * Show the control that derives the subject pseudonym from a wallet signature.
   *
   * Without a pseudonym there is nothing for an issuer to attest and nothing to sign a settlement
   * with, so an app that expects a user to arrive with neither needs this somewhere.
   */
  allowDerive?: boolean;
  /** Show the first refusal in full beneath the fields. */
  showRefusal?: boolean;
}

const VERDICT = {
  valid: "pass",
  refused: "refuse",
  unknown: "warn",
  checking: "unknown",
  none: "unknown",
} as const;

const LABEL = {
  valid: "valid",
  refused: "would be refused",
  unknown: "standing unknown",
  checking: "checking",
  none: "no credential",
} as const;

export function PassportCard({
  credential: supplied,
  className,
  headingLevel = 3,
  title = "Passport",
  allowImport = false,
  allowDerive = false,
  showRefusal = true,
}: PassportCardProps): ReactNode {
  const own = useCordonCredential();
  const state = supplied ?? own;
  const { summary } = state;

  return (
    <section className={cx("cordon", "cordon-card", className)} aria-label="Credential">
      <div className="cordon-card__header">
        {title !== null ? <Heading level={headingLevel}>{title}</Heading> : null}
        <Badge verdict={VERDICT[state.status]} srLabel="Credential status">
          {LABEL[state.status]}
        </Badge>
      </div>

      <p className="cordon-note" role="status" aria-live="polite">
        {state.status === "none"
          ? "No credential loaded."
          : state.status === "checking"
            ? "Reading the issuer and revocation registries."
            : state.status === "valid"
              ? "Every check that could be run passed."
              : state.status === "refused"
                ? `${state.refusals.length} rule${state.refusals.length === 1 ? "" : "s"} would refuse this credential.`
                : "One of the on-chain checks could not be run, so this credential's standing is genuinely unknown."}
      </p>

      {summary ? (
        <Fields
          entries={[
            ["Claim", <span key="claim">{summary.claim}</span>],
            ["Issuer", <span key="issuer">{summary.issuer}</span>],
            [
              "Credential id",
              <span key="id" className="cordon-mono">
                {summary.credentialId}
              </span>,
            ],
            [
              "Subject",
              <span key="subject" className="cordon-mono">
                {shortHex(summary.subject, 10, 6)}
              </span>,
            ],
            [
              "Expires",
              state.secondsUntilExpiry === null ? null : (
                <span key="expiry">
                  {new Date(summary.expiresAt).toISOString().slice(0, 16).replace("T", " ")} UTC
                  {" · "}
                  {relativeTime(state.secondsUntilExpiry)}
                </span>
              ),
            ],
            [
              "Issuer registered",
              state.issuerActive === null ? null : state.issuerActive ? "yes" : "no — deactivated",
            ],
            [
              "Revoked",
              state.revoked === null ? null : state.revoked ? "yes" : "no",
            ],
            [
              "Issuer key",
              state.issuerPublicKey === null ? null : (
                <span key="key" className="cordon-mono">
                  {shortHex(state.issuerPublicKey, 10, 6)}
                </span>
              ),
            ],
          ]}
        />
      ) : null}

      {state.check && state.check.skipped.length > 0 ? (
        <p className="cordon-note">
          Not checked: {state.check.skipped.join("; ")}. A skipped check is not a passed one.
        </p>
      ) : null}

      {state.error ? (
        <p className="cordon-note">
          A registry read failed: {state.error.message} <Unavailable />
        </p>
      ) : null}

      {allowDerive ? <SubjectControl state={state} /> : null}

      {allowImport ? (
        <div>
          <label className="cordon-note" htmlFor="cordon-credential-import">
            Load a credential — JSON, an encoded string, or a <code>cordon-credential:</code> URI
          </label>
          <textarea
            id="cordon-credential-import"
            className="cordon-mono"
            rows={3}
            style={{ width: "100%", marginTop: "0.375rem" }}
            aria-describedby={state.importError ? "cordon-credential-import-error" : undefined}
            onChange={(event) => {
              const text = event.target.value;
              if (text.trim().length > 0) state.load(text);
            }}
          />
          {state.importError ? (
            <p id="cordon-credential-import-error" className="cordon-note" role="alert">
              {state.importError}
            </p>
          ) : null}
        </div>
      ) : null}

      {showRefusal && state.refusals.length > 0 ? (
        <RefusalNotice refusal={state.refusals[0] ?? null} predicted />
      ) : null}
    </section>
  );
}

/**
 * The pseudonym: derive it, read it, hand it to an issuer.
 *
 * This is the first step of the whole flow and the easiest one to leave out of a UI, because
 * nothing visibly breaks until a payment reports `NO_SUBJECT_KEY` several screens later. A
 * credential is a statement *about a key the subject controls*, so there is no credential to ask
 * for until this exists, and no way to authorise a settlement without it.
 *
 * The derivation is a wallet signature over a fixed SNIP-12 message, which makes the key
 * reproducible on any device from the same wallet and keeps it off disk. It is not the wallet's
 * own key: binding a pseudonym to an address would undo the privacy the pool provides.
 */
function SubjectControl({ state }: { state: UseCordonCredential }): ReactNode {
  const { connection } = useCordonContext();
  const [deriving, setDeriving] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [copied, setCopied] = useState(false);

  const derive = async (): Promise<void> => {
    setDeriving(true);
    setDeclined(false);
    try {
      setDeclined((await state.deriveSubject()) === null);
    } finally {
      setDeriving(false);
    }
  };

  const copy = async (): Promise<void> => {
    if (!state.subject) return;
    try {
      await navigator.clipboard.writeText(state.subject.publicKey);
      setCopied(true);
    } catch {
      // A browser that refuses the clipboard still shows the key in full below; there is nothing
      // to report and nothing lost.
    }
  };

  return (
    <div>
      <Fields
        entries={[
          [
            "Subject pseudonym",
            state.subject ? (
              <span className="cordon-mono" style={{ overflowWrap: "anywhere" }}>
                {state.subject.publicKey}
              </span>
            ) : null,
          ],
          [
            "Matches the credential",
            state.credential === null ? null : state.matchesSubject ? "yes" : "no",
          ],
        ]}
      />
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "0.5rem" }}>
        <button
          type="button"
          className="cordon-button"
          onClick={() => void derive()}
          disabled={!connection || deriving}
        >
          {deriving
            ? "Waiting for the wallet"
            : state.subject
              ? "Derive again"
              : "Derive pseudonym from wallet"}
        </button>
        {state.subject ? (
          <button type="button" className="cordon-button" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy pseudonym"}
          </button>
        ) : null}
      </div>
      <p className="cordon-note" role="status">
        {!connection
          ? "Connect a wallet first: the pseudonym is derived from a signature, not generated at random, so the same wallet always produces the same one."
          : declined
            ? "The wallet did not sign, so no pseudonym was derived. Nothing happened."
            : state.subject
              ? "Held for this session only. Hand this key to an issuer to be attested; it is not a wallet address and reveals nothing about one."
              : "One signature, nothing spent. The key never leaves this page and is not written to disk."}
      </p>
      {state.credential && state.subject && !state.matchesSubject ? (
        <p className="cordon-note" role="alert">
          The loaded credential is about a different pseudonym, so this session cannot authorise
          anything with it. Either derive from the wallet the credential was issued to, or load the
          credential that names {shortHex(state.subject.publicKey, 10, 6)}.
        </p>
      ) : null}
    </div>
  );
}
