import Link from "next/link";

import { CordonLine } from "@/components/record/CordonLine";
import { Rule, SectionHead } from "@/components/record/primitives";
import { SCREENS } from "@/lib/record/screens";
import { STEP_COUNT } from "@/lib/record/enforcement";
import { formatUnits, strk } from "@/lib/record/format";
import { HONEST_LIMITS } from "@/lib/record/sample";

export const metadata = {
  title: "Cordon — a gate the pool cannot settle around",
};

/**
 * The cover.
 *
 * A record's title page: the thesis in one sentence set large enough to be the
 * only thing on it, the cordon line drawn once so the device is learned before
 * it is used, and one hard link to the money shot. A judge should be able to
 * open this and be watching the gate refuse a payment within one click.
 */
export default function CoverPage() {
  return (
    <article>
      {/* The title page. One sentence, set at the size the whole editorial
          effect depends on — the gap between 10px metadata and a line of type
          you cannot help reading first. */}
      <div className="pt-pad">
        <p className="label pb-bl">The thesis</p>
        <h1 className="font-display tracking-[var(--tracking-tight)] text-head leading-[33px] sm:text-display sm:leading-[48px] lg:text-mega lg:leading-[88px]">
          A gate the pool
          <br />
          cannot settle around.
        </h1>
      </div>

      <div className="grid4 items-start pt-pad pb-gut">
        <div className="span2">
          <p className="lede">
            Shielded value on Starknet routes through a Cairo anonymizer on its way back into a
            private note. Cordon puts a credential and a policy in that path — so a party who is
            unaccredited, revoked, expired, over their cap or over their velocity budget cannot move
            pool funds at all. The gate panics and the whole transaction reverts.
          </p>
          <p className="lede mt-bl">
            Identities stay private. The amount, and the fact that a check passed, are public. That
            trade is the product, and every screen in this record is an argument that it is the
            right one.
          </p>
        </div>

        <div className="span2">
          <p className="label pb-tick">Start here</p>
          <Link
            href="/pay"
            className="btn btn--heavy border-0"
            aria-label="Watch the gate refuse a payment, on the Pay screen"
          >
            <span>Watch the gate refuse</span>
            <span aria-hidden="true">→</span>
          </Link>
          <p className="note pt-bl">
            One click to the money shot: an amount composed over its cap, the gate&rsquo;s{" "}
            {STEP_COUNT} steps running down in order, and the refusal naming itself.
          </p>
        </div>
      </div>

      {/*
        A legend, not a reading. The numbers are round on purpose and name no published policy,
        because the cover is the one page in the record that is neither the sample nor the chain —
        it is the key to the figure every other page draws from real values.
      */}
      <SectionHead
        title="The device"
        meta="Learn it once, read it everywhere"
        right="A legend — round numbers, no policy"
      />
      <Rule />
      <CordonLine
        className="span4"
        size="hero"
        scaleTop={strk(7000n)}
        cap={strk(5000n)}
        amount={strk(6500n)}
        flip
        capLabel={`Cap ${formatUnits(strk(5000n))} — do not pass`}
        headline={
          <>
            <b>Every limit in this product is drawn the same way</b> — one hard boundary, the
            prohibited region hatched, the amount visibly crossing it
          </>
        }
        headRight="6,500.00 / 5,000.00 STRK"
        ticks={["0", "1,000", "2,000", "3,000", "4,000", "5,000", "6,000", "7,000"]}
        foot="A per-transfer cap, an epoch velocity budget and a disclosure scope are the same picture. A limit is a limit."
        verdict={{ label: "Over cap", tone: "refuse" }}
      />

      <SectionHead title="The record" meta="Five screens" right="Numbered, in order" />
      <Rule />
      <ol className="grid grid-cols-1 gap-gut pt-bl sm:grid-cols-2 lg:grid-cols-5">
        {SCREENS.map((screen) => (
          <li key={screen.href}>
            <Link href={screen.href} className="block border-0 hover:bg-transparent group">
              <span className="label">{screen.number}</span>
              <span
                aria-hidden="true"
                className="mb-tick block h-px bg-rule group-hover:bg-ink"
              />
              <span className="block font-display text-sub leading-[22px] tracking-[var(--tracking-tight)]">
                {screen.title}
              </span>
              <span className="mt-hair block text-fine leading-[18px] text-ink-2">
                {screen.blurb}
              </span>
            </Link>
          </li>
        ))}
      </ol>

      <SectionHead title="What is not claimed" meta="Stated rather than hidden" />
      <Rule weight="thin" />
      <p className="lede pt-bl max-w-[68ch]">{HONEST_LIMITS}</p>
    </article>
  );
}
