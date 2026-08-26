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

import type { ReactNode } from "react";

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
