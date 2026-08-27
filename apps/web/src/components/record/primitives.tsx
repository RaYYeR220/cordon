import type { ReactNode } from "react";

import { UNAVAILABLE } from "@/lib/record/format";

/**
 * The shapes a public record is built from.
 *
 * There is not a card, a shadow or a rounded corner anywhere in here. Structure
 * comes from hairline rules and alignment, which is the whole bet: a document
 * that has to be believed without decoration reads as a timetable or a set of
 * results, not as a dashboard.
 */

/* ── rules ──────────────────────────────────────────────────────────────── */

export function Rule({
  weight = "ink",
  className = "",
  delay,
}: {
  weight?: "ink" | "thin" | "heavy" | "signal";
  className?: string;
  /** Milliseconds, for a stagger down the page as blocks land. */
  delay?: number;
}) {
  const modifier =
    weight === "thin"
      ? " hairline--thin"
      : weight === "heavy"
        ? " hairline--heavy"
        : weight === "signal"
          ? " hairline--signal"
          : "";
  return (
    <div
      className={`hairline${modifier} ${className}`}
      style={delay ? { animationDelay: `${delay}ms` } : undefined}
      aria-hidden="true"
    />
  );
}

/* ── section furniture ──────────────────────────────────────────────────── */

/**
 * The head of a section: a name in agate caps, a note or two beside it, and the
 * right-hand note pushed to the margin so the eye can find it in one place.
 */
export function SectionHead({
  title,
  meta,
  right,
  id,
  level = 2,
  className = "",
}: {
  title: ReactNode;
  meta?: ReactNode;
  right?: ReactNode;
  id?: string;
  level?: 2 | 3 | 4;
  className?: string;
}) {
  const Tag = `h${level}` as "h2" | "h3" | "h4";
  return (
    <div
      className={`flex flex-wrap items-baseline gap-x-gut gap-y-hair pt-gut pb-hair ${className}`}
    >
      <Tag
        id={id}
        className="font-display text-agate uppercase tracking-[var(--tracking-mega)] whitespace-nowrap"
      >
        {title}
      </Tag>
      {meta ? <span className="label">{meta}</span> : null}
      {right ? <span className="label ml-auto text-right">{right}</span> : null}
    </div>
  );
}

/* ── field rows ─────────────────────────────────────────────────────────── */

export function Rows({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <dl className={`rows ${className}`}>{children}</dl>;
}

/**
 * One field.
 *
 * `value` is `ReactNode | null`, and `null` is the point: it renders the single
 * explicit `unavailable` this product uses everywhere a value could not be
 * read. Nothing in this component can produce a zero by accident.
 */
export function Row({
  label,
  value,
  tone,
  strong = false,
  big = false,
}: {
  label: ReactNode;
  value: ReactNode | null;
  tone?: "pass" | "refuse";
  strong?: boolean;
  big?: boolean;
}) {
  const classes = [
    "v",
    big ? "v--big" : "",
    tone === "pass" ? "v--pass" : "",
    tone === "refuse" ? "v--refuse" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={`rw${strong ? " rw--strong" : ""}`}>
      <dt>{label}</dt>
      <dd className={classes}>{value === null || value === undefined ? <Unavailable /> : value}</dd>
    </div>
  );
}

/**
 * What renders wherever a value could not be read.
 *
 * A component rather than a string, so there is exactly one place that decides
 * how "we do not know" looks — and so that its existence is what stops a zero
 * being rendered in its place.
 */
export function Unavailable({ reason }: { reason?: string | null }) {
  return (
    <span className="text-ink-3 italic" title={reason ?? undefined}>
      {UNAVAILABLE}
    </span>
  );
}

/* ── tables ─────────────────────────────────────────────────────────────── */

/**
 * A wide table scrolls inside its own container. The page body never scrolls
 * sideways, on any width.
 */
export function Agate({
  children,
  caption,
  className = "",
}: {
  children: ReactNode;
  caption?: string;
  className?: string;
}) {
  return (
    <div className="scroller" tabIndex={0} role="region" aria-label={caption}>
      <table className={`agate ${className}`}>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        {children}
      </table>
    </div>
  );
}

/* ── figures ────────────────────────────────────────────────────────────── */

/**
 * A number set large enough that the page has one thing to say.
 *
 * The whole editorial effect rests on the gap between 10px metadata and a
 * figure at 96 or 216 — so this is deliberately not a stat card.
 */
export function BigFigure({
  value,
  word,
  hero = false,
  tone = "ink",
  children,
}: {
  value: string;
  word: string;
  hero?: boolean;
  tone?: "ink" | "refuse";
  children?: ReactNode;
}) {
  return (
    <div className="relative">
      <div
        className={`absolute -top-bl h-[3px] w-[calc(100%+var(--spacing-pad))] -left-pad hairline ${
          tone === "refuse" ? "hairline--signal" : ""
        }`}
        aria-hidden="true"
      />
      <p
        className={`figure__number${hero ? " figure__number--hero" : ""} ${
          tone === "refuse" ? "text-red" : ""
        }`}
      >
        {value}
      </p>
      <p className={`figure__word ${tone === "refuse" ? "text-red" : ""}`}>{word}</p>
      {children ? <div className="mt-bl text-fine leading-[18px] max-w-[46ch]">{children}</div> : null}
    </div>
  );
}

export function Stat({
  entries,
  className = "",
}: {
  entries: Array<{ label: string; value: ReactNode | null; unit?: string; tone?: "refuse" }>;
  className?: string;
}) {
  return (
    <dl className={`stat ${className}`}>
      {entries.map((entry) => (
        <div className="stat__row" key={entry.label}>
          <dt>{entry.label}</dt>
          <dd className={entry.tone === "refuse" ? "text-red" : ""}>
            {entry.value === null || entry.value === undefined ? (
              <span className="text-fine">
                <Unavailable />
              </span>
            ) : (
              <>
                {entry.value}
                {entry.unit ? <small>&thinsp;{entry.unit}</small> : null}
              </>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
