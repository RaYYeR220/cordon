import type { ReactNode } from "react";

import { NoViewingKeyMark, ProhibitedMark, WarningMark } from "./Pictograms";

/**
 * THE SIGNAL-WORD PANEL — the one loud thing in a quiet product.
 *
 * It is spent on refusal and on nothing else, ever. When enforcement fires the
 * editorial calm breaks: a solid red block, a prohibition pictogram, REFUSED
 * set large, the panic code, one plain sentence about which rule stopped the
 * payment, the revert reason verbatim from the receipt, and the transaction.
 *
 * It arrives as a hard cut. There is no transition, no fade and no easing on
 * this component anywhere, because a revert is not a transition — the
 * transaction either settled or it did not, and there is no state between.
 */

export type SignalPanelProps = {
  /** The signal word itself. `REFUSED` on the gate; `WITHHELD` where nothing was refused. */
  word: string;
  /** The panic code, exactly as the contract raises it. */
  code: string;
  /** One plain sentence naming the rule that fired. */
  sentence: ReactNode;
  /** Where the gate stopped, and what became of the value. */
  step?: ReactNode;
  /** The revert reason as the receipt carried it, never paraphrased. */
  verbatim?: ReactNode;
  /** Transaction facts: status, block, time, fee, explorer reference. */
  meta?: ReactNode;
  /**
   * `refusal` is the red panel. `withheld` is the same grammar in ink, for the
   * one place something is deliberately not handed over rather than refused.
   */
  tone?: "refusal" | "withheld";
  /** Who can do something about it, in the second person. */
  remedy?: ReactNode;
  className?: string;
};

export function SignalPanel({
  word,
  code,
  sentence,
  step,
  verbatim,
  meta,
  tone = "refusal",
  remedy,
  className = "",
}: SignalPanelProps) {
  return (
    <div className={`signal${tone === "withheld" ? " signal--ink" : ""} ${className}`}>
      <div className="signal__pictogram">
        {tone === "withheld" ? <NoViewingKeyMark /> : <ProhibitedMark />}
      </div>
      <div className="signal__body">
        <p className="signal__word">
          {tone === "refusal" ? <WarningMark /> : null}
          <strong>{word}</strong>
          <code>{code}</code>
          {step ? <span className="signal__step">{step}</span> : null}
        </p>
        <div className="signal__message">
          <p>{sentence}</p>
          {remedy ? <p className="note pt-tick">{remedy}</p> : null}
          {verbatim ? <p className="signal__verbatim">{verbatim}</p> : null}
          {meta ? <p className="signal__meta">{meta}</p> : null}
        </div>
      </div>
    </div>
  );
}
