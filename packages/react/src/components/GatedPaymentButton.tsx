"use client";

/**
 * `<GatedPaymentButton>` — one button, and the whole state machine visible beside it.
 *
 * The steps are rendered because on STRK20 they are slow and genuinely different: the wallet has
 * to generate a STARK proof before it can even submit, and the proof is verified on chain
 * afterwards, so "awaiting signature" and "submitted" can each take minutes. A spinner would tell
 * the user nothing about which minute they are in.
 *
 * The button disables itself only for reasons it can name. Every blocker comes back from
 * `useGatedPayment` with a sentence, and those sentences are what the button is described by, so a
 * screen-reader user hears why it is unavailable instead of just that it is.
 */

import { useId, type ReactNode } from "react";

import { useGatedPayment, type UseGatedPayment, type UseGatedPaymentOptions } from "../hooks/useGatedPayment.js";
import { shortHex } from "../strk20/index.js";
import { Badge, cx } from "./primitives.js";
import { RefusalNotice } from "./RefusalNotice.js";

export interface GatedPaymentButtonProps extends UseGatedPaymentOptions {
  /** An already-built payment from `useGatedPayment`, when the host is driving it. */
  payment?: UseGatedPayment;
  className?: string;
  /** Button label in the idle state. */
  children?: ReactNode;
  /**
   * Submit even when the pre-flight predicted a refusal.
   *
   * The pool charges its fee whatever the outcome, so this is off by default. Turn it on when the
   * revert is the point.
   */
  force?: boolean;
  /** Hide the step list, for a host that renders its own progress. */
  showSteps?: boolean;
  /** Hide the refusal notice, for a host that renders `<RefusalNotice>` itself. */
  showRefusal?: boolean;
}

const STEPS = [
  { key: "building", label: "Check" },
  { key: "preparing", label: "Prepare" },
  { key: "awaiting-signature", label: "Sign" },
  { key: "submitted", label: "Submit" },
  { key: "confirmed", label: "Confirm" },
] as const;

const ORDER: Record<string, number> = {
  idle: -1,
  building: 0,
  preparing: 1,
  "awaiting-signature": 2,
  submitted: 3,
  confirmed: 4,
  unconfirmed: 3,
  refused: 4,
  failed: 4,
  "note-drift": 1,
  "prepare-failed": 1,
};

const MESSAGE: Record<string, string> = {
  idle: "",
  building: "Reading the policy and checking the credential against the registries.",
  preparing:
    "Asking the wallet which note this will land in, signing for exactly that note, and " +
    "generating the STARK proof. This is the slow part.",
  "awaiting-signature": "Waiting for the wallet to approve and submit.",
  submitted: "On chain. Waiting for the proof to be verified and the receipt to settle.",
  confirmed: "Settled. The value moved and the policy check is a public fact.",
  refused: "Refused. The transaction reverted whole and the value stayed shielded.",
  "note-drift":
    "Another transaction landed on this channel while the payment was being prepared, so the " +
    "note it was signed for is no longer the note it would fill. Nothing was submitted. This is " +
    "the check working — try again to sign for the new note.",
  "prepare-failed":
    "This payment cannot be signed safely with this wallet, so nothing was submitted.",
  failed: "Could not be completed.",
  unconfirmed:
    "Stopped waiting for the receipt. The transaction may still land — check the explorer link.",
};

export function GatedPaymentButton({
  payment: supplied,
  className,
  children = "Pay",
  force = false,
  showSteps = true,
  showRefusal = true,
  ...options
}: GatedPaymentButtonProps): ReactNode {
  const own = useGatedPayment(options);
  const payment = supplied ?? own;
  const describedBy = useId();

  const blocked = payment.blockers.length > 0;
  const disabled = blocked || payment.busy;
  const position = ORDER[payment.status] ?? -1;

  // A drift is a retry, not a dead end, so the button says so rather than repeating "Pay" as if
  // nothing had happened.
  const label =
    payment.status === "building"
      ? "Checking"
      : payment.status === "preparing"
        ? "Preparing"
        : payment.status === "awaiting-signature"
          ? "Waiting for the wallet"
          : payment.status === "submitted"
            ? "Submitted"
            : payment.status === "note-drift"
              ? "Try again"
              : children;

  return (
    <div className={cx("cordon", "cordon-payment", className)}>
      <button
        type="button"
        className="cordon-button"
        disabled={disabled}
        aria-describedby={describedBy}
        aria-busy={payment.busy}
        onClick={() => void payment.pay({ force })}
      >
        {label}
      </button>

      {showSteps ? (
        <ol className="cordon-steps" aria-hidden="true">
          {STEPS.map((step, index) => (
            <li
              key={step.key}
              className="cordon-steps__item"
              data-state={
                payment.status === "refused" && index === STEPS.length - 1
                  ? "refused"
                  : payment.status === "note-drift" && step.key === "preparing"
                    ? "refused"
                  : index < position
                    ? "done"
                    : index === position
                      ? "active"
                      : "pending"
              }
            >
              {step.label}
              {index < STEPS.length - 1 ? " ›" : null}
            </li>
          ))}
        </ol>
      ) : null}

      {/* One polite live region for progress. The refusal has its own assertive one below. */}
      <div id={describedBy} className="cordon-payment__status" role="status" aria-live="polite">
        {blocked ? (
          <ul className="cordon-list">
            {payment.blockers.map((blocker) => (
              <li key={blocker.code}>{blocker.message}</li>
            ))}
          </ul>
        ) : (
          <>
            {MESSAGE[payment.status]}
            {/* On a refusal the notice below owns the explorer link, so it is not repeated here. */}
            {payment.transactionHash && payment.voyagerUrl && !(showRefusal && payment.refusal) ? (
              <>
                {" "}
                <a
                  className="cordon-link"
                  href={payment.voyagerUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {shortHex(payment.transactionHash)} on Voyager
                </a>
              </>
            ) : null}
          </>
        )}
      </div>

      {payment.status === "confirmed" ? (
        <p>
          <Badge verdict="pass" srLabel="Payment status">
            settled
          </Badge>
        </p>
      ) : null}

      {/*
        What the signature committed to about its destination, in the SDK's own words. On a bound
        authorisation this is reassurance; on an unbound one it is a warning, and the wording comes
        from `describeBinding` so the screen says exactly what the signed message does.
      */}
      {payment.bindingDescription ? (
        <p className="cordon-note">{payment.bindingDescription}</p>
      ) : null}

      {payment.status === "note-drift" && payment.drift ? (
        <p className="cordon-note" role="alert">
          Signed for note <span className="cordon-mono">{shortHex(payment.drift.signedNoteId)}</span>
          ; the transaction would now fill{" "}
          <span className="cordon-mono">{shortHex(payment.drift.preparedNoteId)}</span>.
        </p>
      ) : null}

      {(payment.status === "failed" || payment.status === "prepare-failed") && payment.error ? (
        <p className="cordon-note" role="alert">
          {payment.error.message}
        </p>
      ) : null}

      {showRefusal ? (
        <RefusalNotice
          refusal={payment.refusal}
          transactionHash={payment.transactionHash}
          predicted={payment.predicted}
          autoFocus
        />
      ) : null}
    </div>
  );
}
