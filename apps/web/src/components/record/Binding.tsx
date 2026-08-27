"use client";

import { useEffect, useState } from "react";

import { MAX_UNBOUND_WINDOW_SECONDS } from "@cordon/sdk";

import { CordonLine } from "./CordonLine";

/**
 * How an authorisation is bound to the note it may fill.
 *
 * The gate accepts two kinds and they are not two settings of equal standing.
 *
 * **Strong** names the note. The wallet resolves the open note id, the subject
 * signs a binding to that exact felt, and the wallet is asked to prepare a
 * second time to prove the note has not moved underneath it. The payment can
 * then only land where it was signed to land — not redirected by us, not by
 * the pool, and not by a stranger who reads the authorisation off a reverted
 * transaction.
 *
 * **Unbound** (`CORDON_NOTE_ANY`) lets the payment land in any note, so the gate
 * forces a deadline of at most {@link MAX_UNBOUND_WINDOW_SECONDS} seconds. That
 * deadline is doing real work, because a reverted Starknet transaction is
 * published with its full calldata and a revert does not burn the nonce: for as
 * long as that window is open, an authorisation that failed for a mundane
 * reason is harvestable by whoever reads the chain.
 *
 * This app never signs one. Neither does `@cordon/react` — it fails closed
 * rather than falling back, and a wallet that cannot resolve calldata at
 * prepare time is reported as a dead end rather than quietly downgraded. So
 * this control is not a switch between two modes; it is the choice explained,
 * with the second option shown for exactly as long as it takes to see why it is
 * not offered.
 *
 * The deadline is a limit, so it is drawn the way every other limit in this
 * product is drawn — as a cordon line, with the prohibited region past it
 * hatched. Learn the device once, read it everywhere.
 */

export type BindingMode = "strong" | "unbound";

export function BindingControl({
  mode,
  onChange,
  noteId,
}: {
  mode: BindingMode;
  onChange: (mode: BindingMode) => void;
  /** The note the signed authorisation names, once the wallet has resolved one. */
  noteId: string | null;
}) {
  const remaining = useWindowCountdown(mode === "unbound", MAX_UNBOUND_WINDOW_SECONDS);

  return (
    <div>
      <fieldset className="border-0 p-0">
        <legend className="label pb-tick">Note binding</legend>
        <div className="flex flex-wrap gap-tick pb-bl">
          <ModeButton
            active={mode === "strong"}
            onClick={() => onChange("strong")}
            label="Strong"
            hint="what this app signs"
          />
          <ModeButton
            active={mode === "unbound"}
            onClick={() => onChange("unbound")}
            label="Unbound"
            hint="why it is not offered"
          />
        </div>
      </fieldset>

      {mode === "strong" ? (
        <>
          <p className="lede max-w-none">
            The authorisation names the note it may fill, so this payment can only land where it was
            signed to land — even if its calldata becomes public.
          </p>
          <p className="note pt-tick">
            Note{" "}
            <span className="font-mono text-ink">
              {noteId ?? "resolved by the wallet at prepare time"}
            </span>
            . The wallet is asked to prepare twice: once to learn the note id the subject signs
            over, and once more to prove it has not moved. If it has, the payment stops and says so
            rather than settling against a note nobody authorised.
          </p>
        </>
      ) : (
        <>
          <p className="lede max-w-none">
            An unbound authorisation may land in any note, so the gate forces a deadline. It is
            weaker, and this app does not sign one — neither does the package underneath it, which
            fails closed instead of falling back.
          </p>
          <p className="note pt-tick">
            A reverted Starknet transaction is published with its full calldata, and a revert does
            not burn the nonce. For as long as this window is open, an unbound authorisation that
            failed for a mundane reason is harvestable by a stranger reading the chain. Strong
            binding has no such window.
          </p>

          <CordonLine
            className="pt-bl"
            scaleTop={BigInt(MAX_UNBOUND_WINDOW_SECONDS + 120)}
            cap={BigInt(MAX_UNBOUND_WINDOW_SECONDS)}
            amount={BigInt(MAX_UNBOUND_WINDOW_SECONDS - remaining)}
            capLabel={`Deadline ${MAX_UNBOUND_WINDOW_SECONDS}s — the gate allows no longer`}
            headline={
              <>
                <b>Authorisation window</b> — how long this signature stays worth harvesting
              </>
            }
            headRight={`${remaining}s remaining of ${MAX_UNBOUND_WINDOW_SECONDS}s`}
            permitLabel="Open"
            forbidLabel="Refused past here"
            endcapLabel={`${MAX_UNBOUND_WINDOW_SECONDS - remaining}s elapsed`}
            ticks={["0s", "180s", "360s", "540s", "720s"]}
            foot="Past the line the gate refuses the authorisation outright with CORDON_AUTH_EXPIRED — which is the point of forcing a deadline at all."
            verdict={{ label: "Not signed here", tone: "idle" }}
            valueText={`${MAX_UNBOUND_WINDOW_SECONDS - remaining} seconds elapsed of a ${MAX_UNBOUND_WINDOW_SECONDS} second window; ${remaining} seconds remain.`}
          />
        </>
      )}
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      className="btn"
      aria-pressed={active}
      onClick={onClick}
      style={active ? { background: "var(--color-ink)", color: "var(--color-paper)" } : undefined}
    >
      {label}
      <span className="font-mono text-agate normal-case tracking-normal opacity-70">{hint}</span>
    </button>
  );
}

/**
 * The window ticking down.
 *
 * It starts when the mode is chosen, because that is when an authorisation
 * would be composed. Nothing is signed here — the countdown shows the window
 * the gate would allow, and says so beside itself.
 */
function useWindowCountdown(active: boolean, seconds: number): number {
  const [remaining, setRemaining] = useState(seconds);

  useEffect(() => {
    if (!active) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      setRemaining(Math.max(0, seconds - elapsed));
    }, 1000);
    return () => {
      window.clearInterval(timer);
      setRemaining(seconds);
    };
  }, [active, seconds]);

  return remaining;
}
