"use client";

/**
 * The handful of shapes every Cordon component is built from.
 *
 * They are exported because a consumer replacing one of our components still wants the badge and
 * the field list to match, and because `cx` is what makes `className` compose predictably: every
 * component's own classes come first, the caller's last, so the caller wins on equal specificity.
 */

import type { ReactNode } from "react";

/** Join class names, dropping anything empty. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** The three things a Cordon verdict can be. There is no fourth, and no default to "fine". */
export type Verdict = "pass" | "refuse" | "warn" | "unknown";

export interface BadgeProps {
  verdict?: Verdict;
  children: ReactNode;
  className?: string;
  /** Extra context for a screen reader, when the visible label is a bare code. */
  srLabel?: string;
}

/**
 * A verdict pill.
 *
 * The dot is decorative. The word beside it is what carries the meaning, so nothing here depends
 * on distinguishing green from red.
 */
export function Badge({ verdict = "unknown", children, className, srLabel }: BadgeProps): ReactNode {
  return (
    <span className={cx("cordon-badge", `cordon-badge--${verdict}`, className)}>
      <span className="cordon-badge__dot" aria-hidden="true" />
      {srLabel ? <span className="cordon-visually-hidden">{srLabel}: </span> : null}
      {children}
    </span>
  );
}

export interface FieldsProps {
  /** `[label, value]` pairs. A value of `null` renders as an explicit "unavailable". */
  entries: Array<[label: string, value: ReactNode]>;
  className?: string;
}

/** A description list. Two columns, labels muted, values selectable. */
export function Fields({ entries, className }: FieldsProps): ReactNode {
  return (
    <dl className={cx("cordon-fields", className)}>
      {entries.map(([label, value]) => (
        <div key={label} style={{ display: "contents" }}>
          <dt>{label}</dt>
          <dd>{value ?? <Unavailable />}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * What renders wherever a value could not be read.
 *
 * Deliberately a component rather than a string: it is the single place that decides how "we do
 * not know" looks, and having it exist at all is what stops a zero being rendered instead.
 */
export function Unavailable({ reason }: { reason?: string | null }): ReactNode {
  return (
    <span className="cordon-note" title={reason ?? undefined}>
      unavailable
    </span>
  );
}

export interface HeadingProps {
  /** Which heading level to render, so the component slots into the host's document outline. */
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  id?: string;
  className?: string;
  children: ReactNode;
}

/**
 * A heading at whatever level the surrounding page needs.
 *
 * Components that hard-code `<h3>` break the outline of every page that embeds them, which is one
 * of the most common ways a component library fails a screen-reader user.
 */
export function Heading({ level = 3, id, className, children }: HeadingProps): ReactNode {
  const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
  return (
    <Tag id={id} className={cx("cordon-title", className)}>
      {children}
    </Tag>
  );
}
