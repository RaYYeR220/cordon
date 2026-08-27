"use client";

import type { Refusal, RefusalRemedy } from "@cordon/sdk";

import { describeStop, stepOf } from "@/lib/record/enforcement";
import { formatCount, formatInstant } from "@/lib/record/format";

import { SignalPanel } from "./SignalPanel";
import { TxRef } from "./TxRef";

/**
 * A refusal, rendered.
 *
 * Every word of it comes from the SDK's decoder rather than from copy written
 * in this app, which is what lets one component render any refusal the gate can
 * raise — all forty-eight of them, including the ones no demo will ever show —
 * without a mapping here to fall out of date. The design contributes the panel;
 * the contract contributes the words.
 *
 * `remedy` is the part a refused person actually needs: telling someone to
 * contact their issuer when they merely need to send less is the difference
 * between a useful refusal and a dead end.
 */

const REMEDY: Record<RefusalRemedy, string> = {
  payer: "You can fix this: change the payment and try again.",
  issuer: "Only the credential's issuer can fix this — ask them to re-attest or renew.",
  operator: "Only the registry owner can fix this — the policy or issuer needs publishing.",
  integrator: "The transaction was assembled wrongly. This one is for whoever built the app.",
};

export type RefusalSignalProps = {
  refusal: Refusal;
  /** The reverted transaction, when one was submitted. */
  transactionHash?: string | null;
  /** True when the refusal was worked out locally and nothing was sent. */
  predicted?: boolean;
  block?: number | null;
  at?: number | null;
  fee?: string | null;
  /** The revert reason as the receipt carried it. Never paraphrased. */
  revertReason?: string | null;
  /** The panic felt, when the node reported one. */
  panicFelt?: string | null;
  /** Move focus here when the refusal arrives — the user asked, and this is the answer. */
  autoFocus?: boolean;
  className?: string;
};

export function RefusalSignal({
  refusal,
  transactionHash = null,
  predicted = false,
  block = null,
  at = null,
  fee = null,
  revertReason = null,
  panicFelt = null,
  className = "",
}: RefusalSignalProps) {
  const step = refusal.step ?? stepOf(refusal.code);

  return (
    <SignalPanel
      className={className}
      word="Refused"
      code={refusal.code}
      step={
        <>
          {describeStop(step)
            .split(". ")
            .map((part, index) => (
              <span key={index} className="block">
                {part.replace(/\.$/, "")}
              </span>
            ))}
        </>
      }
      sentence={
        <>
          <strong>{refusal.title}.</strong> {refusal.explanation}
        </>
      }
      remedy={REMEDY[refusal.remedy]}
      verbatim={
        revertReason || panicFelt ? (
          <>
            Revert reason, verbatim from the receipt — {revertReason}{" "}
            {panicFelt ? <i>{panicFelt}</i> : null} {panicFelt ? `('${refusal.code}')` : null}
          </>
        ) : predicted ? (
          <>
            Predicted by the pre-flight against chain state read at this block. Nothing was
            submitted and the pool charged no fee, so there is no receipt to quote.
          </>
        ) : null
      }
      meta={
        <>
          <span>
            Status <b>{predicted ? "Not submitted" : "Reverted"}</b>
          </span>
          {block !== null ? (
            <span>
              Block <b>{formatCount(block)}</b>
            </span>
          ) : null}
          {at !== null ? <span>{formatInstant(at)}</span> : null}
          {fee ? (
            <span>
              Fee <b>{fee}&thinsp;STRK</b>
            </span>
          ) : null}
          {transactionHash ? (
            <span>
              Transaction <TxRef hash={transactionHash} />
            </span>
          ) : null}
        </>
      }
    />
  );
}
