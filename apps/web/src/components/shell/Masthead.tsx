"use client";

import Link from "next/link";

import { useChainHead } from "@/hooks/useChainHead";
import { formatCount, formatInstant } from "@/lib/record/format";
import { SAMPLE_BLOCK, SAMPLE_NOW } from "@/lib/record/sample";
import { useRecordSource } from "@/lib/record/source";
import { Rule, Unavailable } from "@/components/record/primitives";

/**
 * The masthead of a public record.
 *
 * Four things, on a rule: what this is, which chain it is about, which block it
 * was read at, and when. The block and the clock are the record's provenance —
 * in live mode they come off the node, and in sample mode they are the fixed
 * date this seeded document was printed with, stated as such directly beneath.
 */
export function Masthead() {
  const source = useRecordSource();
  const head = useChainHead(source.live);

  const block = source.live ? head.block : SAMPLE_BLOCK;
  const at = source.live ? null : SAMPLE_NOW;

  return (
    <header>
      <Rule />
      <div className="grid4 pt-gut pb-bl items-end">
        <div>
          <h1 className="font-display text-lede uppercase tracking-[0.34em] leading-none">
            <Link href="/" className="border-0 hover:bg-transparent">
              Cordon
            </Link>
            <span className="text-ink-3"> · Public record</span>
          </h1>
          <p className="lede mt-tick">
            A gate the pool cannot settle around. Credential and policy enforcement for shielded
            STRK20 value on Starknet. Identities stay private; the amount and the fact a check
            passed are public.
          </p>
        </div>

        <Fact label="Network" value="SN_MAIN" />
        <Fact
          label="Block"
          value={block === null ? null : formatCount(block)}
          note={source.live && head.loading ? "reading" : null}
        />
        <Fact
          label={source.live ? "Read at" : "Printed"}
          value={at === null ? (source.live ? "live" : null) : formatInstant(at).slice(0, 10)}
          note={at === null ? null : formatInstant(at).slice(11)}
        />
      </div>
    </header>
  );
}

function Fact({
  label,
  value,
  note,
}: {
  label: string;
  value: string | null;
  note?: string | null;
}) {
  return (
    <dl>
      <dt className="label">{label}</dt>
      <dd className="font-display text-sub leading-[22px]">
        {value === null ? <Unavailable reason={note ?? undefined} /> : value}
      </dd>
      {note ? <dd className="font-mono text-agate text-ink-3 leading-[14px]">{note}</dd> : null}
    </dl>
  );
}
