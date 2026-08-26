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
  { key: "building", label: "Build" },
  { key: "awaiting-signature", label: "Sign" },
  { key: "submitted", label: "Submit" },
  { key: "confirmed", label: "Confirm" },
] as const;

const ORDER: Record<string, number> = {
  idle: -1,
  building: 0,
  "awaiting-signature": 1,
  submitted: 2,
  confirmed: 3,
  unconfirmed: 2,
  refused: 3,
  failed: 3,
};

const MESSAGE: Record<string, string> = {
  idle: "",
  building: "Reading the policy, checking the credential and signing the authorisation.",
  "awaiting-signature":
    "Waiting for the wallet. It is generating a STARK proof before it can submit, which takes a while.",
  submitted: "On chain. Waiting for the proof to be verified and the receipt to settle.",
  confirmed: "Settled. The value moved and the policy check is a public fact.",
  refused: "Refused. The transaction reverted whole and the value stayed shielded.",
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

  const label =
    payment.status === "building"
      ? "Building"
      : payment.status === "awaiting-signature"
        ? "Waiting for the wallet"
        : payment.status === "submitted"
          ? "Submitted"
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
            {payment.transactionHash && payment.voyagerUrl ? (
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

      {payment.status === "failed" && payment.error ? (
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
