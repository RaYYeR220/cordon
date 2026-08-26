"use client";

/**
 * `<RefusalNotice>` — the component this whole package exists for.
 *
 * A gate that refuses in silence is worthless. On chain a refusal is a short-string panic and a
 * reverted transaction; a user gets "execution reverted" and no idea which rule fired. This names
 * the exact `CORDON_*` code, says in one plain sentence which rule stopped them, says who can do
 * something about it, and links the transaction on Voyager so the refusal is a public fact rather
 * than a claim.
 *
 * It renders inside a permanent `role="alert"` region, so the announcement fires when a refusal
 * arrives rather than depending on the element being mounted first.
 */

import { useEffect, useRef, type ReactNode } from "react";
import type { Refusal, RefusalRemedy } from "@cordon/sdk";

import { useCordonConfig } from "../context/CordonProvider.js";
import { shortHex, voyagerTxUrl } from "../strk20/index.js";
import { Badge, cx } from "./primitives.js";

/** Who can act, in the second person. */
const REMEDY: Record<RefusalRemedy, string> = {
  payer: "You can fix this: change the payment and try again.",
  issuer: "Only the credential's issuer can fix this — ask them to re-attest or renew.",
  operator: "Only the registry owner can fix this — the policy or issuer needs publishing.",
  integrator: "The transaction was assembled wrongly. This one is for whoever built the app.",
};

export interface RefusalNoticeProps {
  /** The refusal to show. Nothing renders when this is null, but the live region stays. */
  refusal: Refusal | null;
  /** The reverted transaction, when there is one. */
  transactionHash?: string | null;
  /** True when the refusal was predicted locally and no transaction was ever sent. */
  predicted?: boolean;
  className?: string;
  /**
   * Move focus here when a refusal appears.
   *
   * Appropriate after a user-initiated payment — they pressed a button and this is the answer —
   * and wrong for a refusal that appears on its own, which is why it is off by default.
   */
  autoFocus?: boolean;
  /** Override the Voyager link. Defaults to the configured chain's explorer. */
  explorerUrl?: (transactionHash: string) => string;
}

export function RefusalNotice({
  refusal,
  transactionHash = null,
  predicted = false,
  className,
  autoFocus = false,
  explorerUrl,
}: RefusalNoticeProps): ReactNode {
  const config = useCordonConfig();
  const container = useRef<HTMLDivElement>(null);
  const lastCode = useRef<string | null>(null);

  useEffect(() => {
    if (!refusal || !autoFocus) return;
    if (lastCode.current === refusal.code) return;
    lastCode.current = refusal.code;
    container.current?.focus();
  }, [refusal, autoFocus]);

  const href = transactionHash
    ? (explorerUrl?.(transactionHash) ?? voyagerTxUrl(transactionHash, config.chainId))
    : null;

  return (
    <div className={cx("cordon", className)} role="alert">
      {refusal ? (
        <div className="cordon-refusal" ref={container} tabIndex={-1}>
          <div className="cordon-refusal__head">
            <Badge verdict="refuse" srLabel="Refusal code">
              <code className="cordon-refusal__code">{refusal.code}</code>
            </Badge>
            <p className="cordon-refusal__title">{refusal.title}</p>
          </div>

          <p className="cordon-refusal__body">{refusal.explanation}</p>
          <p className="cordon-refusal__body">{REMEDY[refusal.remedy]}</p>

          <p className="cordon-refusal__meta">
            {refusal.step !== undefined ? (
              <span>Stopped at check {refusal.step} of the gate&rsquo;s enforcement order.</span>
            ) : null}
            <span>
              {predicted
                ? "Predicted before signing — nothing was submitted and no fee was charged."
                : "The transaction reverted whole. The value stayed shielded."}
            </span>
            {href ? (
              <a className="cordon-link" href={href} target="_blank" rel="noreferrer noopener">
                View {shortHex(transactionHash as string)} on Voyager
              </a>
            ) : null}
          </p>
        </div>
      ) : null}
    </div>
  );
}
