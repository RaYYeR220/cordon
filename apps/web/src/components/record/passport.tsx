import type { CSSProperties, ReactNode } from "react";

/**
 * The two devices the Passport screen keeps, and nothing else.
 *
 * A credential is a document presented at a border, so it is worth exactly one
 * metaphor: a machine-readable zone the gate reads, and an impression from the
 * officer who read it. Neither appears on any other screen.
 */

/**
 * The machine-readable zone.
 *
 * Set in the mono face at 16px on a wide track, and it scrolls inside its own
 * container rather than pushing the page sideways. The lines are built from the
 * credential's own felts, so what is printed here is what the gate hashes.
 */
export function Mrz({
  caption,
  lines,
  refused = false,
}: {
  caption: ReactNode;
  lines: readonly string[];
  refused?: boolean;
}) {
  return (
    <div className="mrz">
      <p className="label pb-tick">{caption}</p>
      {lines.map((line, index) => (
        <p key={index} className={`mrz__line${refused ? " mrz__line--refused" : ""}`}>
          {line}
        </p>
      ))}
    </div>
  );
}

/** Pad a value into an MRZ field, filler `<` as ICAO does it. */
export function mrzField(value: string, width: number): string {
  const upper = value.toUpperCase().replace(/^0X/, "").replace(/[^A-Z0-9]/g, "<");
  return upper.slice(0, width).padEnd(width, "<");
}

/**
 * An impressed stamp.
 *
 * Rotated off true and screened with a fine diagonal, because a stamp is
 * pressed by a hand and an even one reads as a graphic rather than a mark. It
 * sits in a dashed field so the page still says where an endorsement goes when
 * there is not one.
 */
export function Stamp({
  word,
  lines,
  tone = "admitted",
  style,
}: {
  word: string;
  lines: readonly string[];
  tone?: "admitted" | "revoked";
  style?: CSSProperties;
}) {
  return (
    <div className={`stamp stamp--${tone}`} style={style}>
      <strong>{word}</strong>
      {lines.map((line, index) => (
        <i key={index}>{line}</i>
      ))}
    </div>
  );
}

export function StampField({
  caption,
  height,
  children,
}: {
  caption: string;
  height: number;
  children?: ReactNode;
}) {
  return (
    <div className="stampfield" style={{ height }}>
      <span className="label absolute left-tick top-hair">{caption}</span>
      {children}
    </div>
  );
}
