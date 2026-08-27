"use client";

import { voyagerContractUrl, voyagerTxUrl } from "@/lib/strk20";
import { shorten } from "@/lib/record/format";
import { useRecordSource } from "@/lib/record/source";

/**
 * A reference to something on chain.
 *
 * The rule the whole record follows: a real address or hash is a link anyone
 * can open, and a sample one is printed and not linked. Sending a judge to a
 * Voyager page for a transaction that does not exist would be a worse lie than
 * any placeholder — so the sample record prints the hash, says it is a sample,
 * and lets the reader see for themselves that it does not pretend otherwise.
 */

export function TxRef({
  hash,
  label,
  /** Force the link on for an address that is genuinely deployed, even in sample mode. */
  live,
}: {
  hash: string;
  label?: string;
  live?: boolean;
}) {
  const source = useRecordSource();
  const linkable = live ?? source.live;
  const text = label ?? shorten(hash);

  if (!linkable) {
    return (
      <span className="font-mono" title={hash}>
        {text}
        <span className="sr-only"> — sample reference, not a mainnet transaction</span>
        <span aria-hidden="true" className="text-ink-3">
          {" "}
          ·&nbsp;sample
        </span>
      </span>
    );
  }

  return (
    <a
      className="font-mono"
      href={voyagerTxUrl(hash)}
      target="_blank"
      rel="noreferrer noopener"
      title={hash}
    >
      {text}
      <span className="sr-only"> — open on Voyager</span>
    </a>
  );
}

export function ContractRef({
  address,
  label,
  live,
}: {
  address: string;
  label?: string;
  live?: boolean;
}) {
  const source = useRecordSource();
  const linkable = live ?? source.live;
  const text = label ?? shorten(address);

  if (!linkable) {
    return (
      <span className="font-mono" title={address}>
        {text}
        <span className="sr-only"> — sample address, not a deployed contract</span>
        <span aria-hidden="true" className="text-ink-3">
          {" "}
          ·&nbsp;sample
        </span>
      </span>
    );
  }

  return (
    <a
      className="font-mono"
      href={voyagerContractUrl(address)}
      target="_blank"
      rel="noreferrer noopener"
      title={address}
    >
      {text}
      <span className="sr-only"> — open on Voyager</span>
    </a>
  );
}
