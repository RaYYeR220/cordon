import type { CSSProperties, ReactNode } from "react";

import { formatUnits, percent, ratio, UNAVAILABLE } from "@/lib/record/format";

import { Unavailable } from "./primitives";

/**
 * THE CORDON LINE — the product's signature graphic, and the word *cordon* made
 * visible.
 *
 * Every limit Cordon enforces is drawn the same way: one hard boundary rule
 * with 45° hatching over the prohibited region beyond it, and the amount
 * visibly crossing it. A per-transfer cap, an epoch velocity budget and a
 * disclosure scope are all the same picture, so a reader learns it once and can
 * read it everywhere.
 *
 * The track has four fixed lanes and labels never share one, which is what
 * stops them colliding at any width:
 *
 *   lane 1  the cap label, above the rule
 *   lane 2  the bars
 *   lane 3  the zone words, at the track top
 *   lane 4  the amount endcap, at the track bottom
 *
 * An amount that could not be read gets a striped, valueless track and no
 * `aria-valuenow` — never a full allowance, because "you have your whole limit
 * left" is the most dangerous thing this component could say wrongly.
 */

export type CordonLineProps = {
  /** The top of the scale the track is drawn against. */
  scaleTop: bigint;
  /** Where the boundary stands. Null means the policy caps nothing — no line to draw. */
  cap: bigint | null;
  /** Where the bar ends. Null means it could not be read. */
  amount: bigint | null;
  /** Value already accumulated, drawn banded, for a velocity budget. */
  spent?: bigint | null;
  /** The label printed on the boundary itself. */
  capLabel?: string;
  permitLabel?: string;
  forbidLabel?: string;
  /** Text set beside the amount where the bar ends. Defaults to the amount. */
  endcapLabel?: string;
  headline?: ReactNode;
  headRight?: ReactNode;
  /** Tick labels along the bottom of the track. */
  ticks?: readonly string[];
  foot?: ReactNode;
  verdict?: { label: string; tone: "refuse" | "pass" | "idle" } | null;
  size?: "hero" | "default" | "mini";
  /** Put the boundary label on the left of the rule, for a cap near the right edge. */
  flip?: boolean;
  /** A boundary that is a scope rather than a ban: hatched in ink, not hazard. */
  scoped?: boolean;
  /** Drive the bar to the line over 900ms. Off means it is simply there. */
  driving?: boolean;
  /** A second boundary, for a scope with two edges. */
  cap2?: bigint | null;
  cap2Label?: string;
  className?: string;
  /** What a screen reader is told the meter says, in one sentence. */
  valueText?: string;
};

export function CordonLine({
  scaleTop,
  cap,
  amount,
  spent = null,
  capLabel,
  permitLabel = "Permitted",
  forbidLabel = "Prohibited",
  endcapLabel,
  headline,
  headRight,
  ticks,
  foot,
  verdict,
  size = "default",
  flip = false,
  scoped = false,
  driving = false,
  cap2 = null,
  cap2Label,
  className = "",
  valueText,
}: CordonLineProps) {
  const capAt = cap === null ? null : ratio(cap, scaleTop);
  const cap2At = cap2 === null || cap2 === undefined ? null : ratio(cap2, scaleTop);
  const amountAt = amount === null ? null : ratio(amount, scaleTop);
  const spentAt = spent === null || spent === undefined ? null : ratio(spent, scaleTop);

  const readable = amountAt !== null;
  // A scope has two edges and no overshoot: the bar spans the disclosed window
  // and nothing about it is a refusal, so nothing about it is red.
  const twoEdged = scoped && cap2At !== null;
  const crossing = !scoped && capAt !== null && amountAt !== null && amountAt > capAt;

  const style = {
    "--cap": capAt === null ? "100%" : percent(capAt),
    "--cap2": cap2At === null ? "100%" : percent(cap2At),
    "--amt": amountAt === null ? "0%" : percent(amountAt),
    "--from": spentAt === null ? "0%" : percent(spentAt),
    "--to": amountAt === null ? "0%" : percent(amountAt),
  } as CSSProperties;

  const modifier = [
    size === "hero" ? "cordonline--hero" : "",
    size === "mini" ? "cordonline--mini" : "",
    scoped ? "cordonline--scoped" : "",
    driving ? "cordonline--driving" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Below a quarter of the track there is not room to hang the endcap to the
  // left of the bar's end, so it goes to the right of it instead.
  const endcapRight = amountAt !== null && amountAt < 26;

  const spoken =
    valueText ??
    (amount === null
      ? `Amount ${UNAVAILABLE}.`
      : cap === null
        ? `${formatUnits(amount)} STRK against no cap.`
        : crossing
          ? `${formatUnits(amount)} STRK against a limit of ${formatUnits(cap)} STRK — over by ${formatUnits(amount - cap)} STRK.`
          : `${formatUnits(amount)} STRK against a limit of ${formatUnits(cap)} STRK — within it.`);

  return (
    <figure className={`cordonline ${modifier} ${className}`} style={style}>
      {headline || headRight ? (
        <figcaption className="cordonline__head">
          <span>{headline}</span>
          {headRight ? <span className="num">{headRight}</span> : null}
        </figcaption>
      ) : null}

      {/* A meter has to have a value. When the amount could not be read there is
          no value to give, so this is not a meter — it is an image of an empty
          track that says why. Announcing a meter with no `aria-valuenow` would
          be worse than either. */}
      <div
        className="cordonline__track"
        {...(amount !== null
          ? {
              role: "meter" as const,
              "aria-valuemin": 0,
              "aria-valuemax": Number(formatUnits(scaleTop, 18, 2).replace(/,/g, "")),
              "aria-valuenow": Number(formatUnits(amount, 18, 2).replace(/,/g, "")),
              "aria-valuetext": spoken,
            }
          : { role: "img" as const })}
        aria-label={
          amount === null ? spoken : typeof headline === "string" ? headline : "Limit"
        }
      >
        {capAt !== null ? (
          <>
            <div className="cordonline__zone cordonline__zone--permit">
              <span>{permitLabel}</span>
            </div>
            <div className="cordonline__zone cordonline__zone--forbid">
              <span>{forbidLabel}</span>
            </div>
          </>
        ) : null}

        {/* Lane 2. A track with no readable amount is striped and carries no bar
            at all, rather than a bar of length zero. */}
        {readable ? (
          twoEdged ? (
            <div className="cordonline__bar cordonline__bar--scoped" />
          ) : (
            <>
              {spentAt !== null ? (
                <>
                  <div
                    className="cordonline__bar cordonline__bar--banded"
                    style={{ width: percent(spentAt) }}
                  />
                  <div className="cordonline__pending" />
                </>
              ) : (
                <div className="cordonline__bar" />
              )}
              {crossing ? <div className="cordonline__over" /> : null}
            </>
          )
        ) : (
          <div className="cordonline__unreadable" />
        )}

        {capAt !== null ? (
          <div className={`cordonline__line${flip ? " cordonline__line--flip" : ""}`}>
            {capLabel && size !== "mini" ? <b className="cordonline__cap">{capLabel}</b> : null}
          </div>
        ) : null}

        {cap2At !== null ? (
          <div
            className="cordonline__line cordonline__line--flip"
            style={{ left: percent(cap2At) } as CSSProperties}
          >
            {cap2Label ? <b className="cordonline__cap">{cap2Label}</b> : null}
          </div>
        ) : null}

        {/* Lane 4. */}
        {readable && size !== "mini" ? (
          <span
            className={`cordonline__endcap${crossing ? "" : " cordonline__endcap--within"}${
              endcapRight ? " cordonline__endcap--right" : ""
            }`}
          >
            {endcapLabel ?? (amount === null ? "" : `${formatUnits(amount)} →`)}
          </span>
        ) : null}
      </div>

      {ticks && ticks.length ? (
        <div className="cordonline__scale" aria-hidden="true">
          {ticks.map((tick, index) => (
            <span key={`${tick}-${index}`}>{tick}</span>
          ))}
        </div>
      ) : null}

      {foot || verdict ? (
        <div className="cordonline__foot">
          <span>{foot}</span>
          {verdict ? (
            <span className={`cordonline__verdict cordonline__verdict--${verdict.tone}`}>
              {verdict.label}
            </span>
          ) : null}
        </div>
      ) : null}

      {!readable ? (
        <p className="note pt-hair">
          The amount for this limit is <Unavailable />, so the track is drawn empty rather than
          full.
        </p>
      ) : null}
    </figure>
  );
}
