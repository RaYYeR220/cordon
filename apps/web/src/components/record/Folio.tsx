import type { ReactNode } from "react";

import { Rule, Unavailable } from "./primitives";

/**
 * A screen's folio.
 *
 * The running head, the screen's number set large in rule grey, its title, and
 * three facts pushed out to the margin columns. It is the page furniture of a
 * printed document — the thing that tells a reader which sheet of the record
 * they are holding.
 */
export function Folio({
  number,
  running,
  title,
  facts,
}: {
  number: string;
  running: string;
  title: string;
  facts: ReadonlyArray<{ label: string; value: ReactNode | null }>;
}) {
  return (
    <>
      <div className="grid4 items-end pt-gut pb-bl">
        <div>
          <span className="block pb-hair font-display text-agate uppercase tracking-[var(--tracking-mega)] text-ink-3">
            {running}
          </span>
          <h2 className="flex items-baseline gap-bl font-display text-head tracking-[var(--tracking-tight)]">
            <span aria-hidden="true" className="text-display leading-[44px] text-rule">
              {number}
            </span>
            {title}
          </h2>
        </div>
        {facts.map((fact) => (
          <dl key={fact.label}>
            <dt className="label">{fact.label}</dt>
            <dd className="font-mono text-fine leading-[18px]">
              {fact.value === null || fact.value === undefined ? <Unavailable /> : fact.value}
            </dd>
          </dl>
        ))}
      </div>
      <Rule weight="thin" />
    </>
  );
}
