"use client";

import { useCordonContext } from "@cordon/react";

import { useRecordSource } from "@/lib/record/source";

/**
 * Which record is on the page, said out loud.
 *
 * This is the most important strip in the product and the reason it can be
 * demonstrated honestly with no wallet: everything below it is either the
 * seeded sample record or the chain, never a blend, and the strip says which
 * before a reader has looked at a single number.
 *
 * Live mode is offered only when this build has a `PolicyGate` address. Without
 * one there is nothing to read, and a switch that leads to a page of
 * `unavailable` would be a worse answer than saying so plainly.
 */
export function SourceStrip() {
  const source = useRecordSource();
  const { gateContext, config } = useCordonContext();

  const gateUnreadable = source.live && gateContext !== null && !gateContext.available;

  return (
    <div
      className={`flex flex-wrap items-baseline gap-x-gut gap-y-hair border-y ${
        source.live ? "border-ink" : "border-ink bg-paper-2"
      } px-tick py-tick`}
    >
      <p className="font-display text-agate uppercase tracking-[var(--tracking-mega)]">
        {source.live ? "Live record" : "Sample record"}
      </p>

      <p className="text-fine leading-[18px] text-ink-2 max-w-[74ch]">
        {source.live ? (
          gateUnreadable ? (
            <>
              Reading Starknet mainnet at {config.gateAddress.slice(0, 10)}…, and the gate did not
              answer. Every value below that could not be read says <i>unavailable</i> rather than
              standing in for one.
            </>
          ) : (
            <>
              Read from Starknet mainnet. Anything the node would not answer says{" "}
              <i>unavailable</i>; nothing on this page is filled in on its behalf.
            </>
          )
        ) : (
          <>
            Seeded sample data, not chain state. The policies and credentials are real SDK objects
            with real signatures and the verdicts are computed by the same enforcement code the live
            path runs — but no transaction below was submitted, and sample hashes are printed rather
            than linked.
          </>
        )}
      </p>

      <div className="ml-auto flex items-baseline gap-tick">
        {source.gateConfigured ? (
          <>
            <ModeButton
              active={!source.live}
              onClick={() => source.setMode("sample")}
              label="Sample"
            />
            <ModeButton active={source.live} onClick={() => source.setMode("live")} label="Live" />
          </>
        ) : (
          <p className="label">Gate not deployed on this build — sample only</p>
        )}
      </div>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`font-display text-agate uppercase tracking-[var(--tracking-label)] px-tick py-1 border ${
        active ? "border-ink bg-ink text-paper" : "border-rule text-ink-3 hover:border-ink"
      }`}
    >
      {label}
    </button>
  );
}
