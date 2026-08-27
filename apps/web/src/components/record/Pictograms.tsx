/**
 * ISO 7010 grammar, drawn rather than downloaded.
 *
 * A prohibition sign has a fixed shape everybody already knows how to read, and
 * the whole point of the signal panel is that it needs no learning. These are
 * inline SVG so they cost no request and inherit the record's own colours.
 */

export function ProhibitedMark({ size = 84 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 88 88"
      role="img"
      aria-label="Prohibited"
      focusable="false"
    >
      {/* value entering a gate */}
      <rect x="24" y="41.5" width="26" height="5" fill="var(--color-ink)" />
      <path d="M50 34.5 L61 44 L50 53.5 Z" fill="var(--color-ink)" />
      <rect x="61" y="27" width="5" height="34" fill="var(--color-ink)" />
      {/* the prohibition */}
      <circle cx="44" cy="44" r="34" fill="none" stroke="var(--color-red)" strokeWidth="9" />
      <line x1="20" y1="20" x2="68" y2="68" stroke="var(--color-red)" strokeWidth="9" />
    </svg>
  );
}

/** Not refused — withheld. A printed prohibition rather than an alarm. */
export function NoViewingKeyMark({ size = 84 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 88 88"
      role="img"
      aria-label="No viewing key"
      focusable="false"
    >
      <path
        d="M18 44 C28 29 60 29 70 44 C60 59 28 59 18 44 Z"
        fill="none"
        stroke="var(--color-ink)"
        strokeWidth="5"
      />
      <circle cx="44" cy="44" r="7.5" fill="var(--color-ink)" />
      <circle cx="44" cy="44" r="34" fill="none" stroke="var(--color-ink)" strokeWidth="8" />
      <line x1="18" y1="18" x2="70" y2="70" stroke="var(--color-paper-2)" strokeWidth="17" />
      <line x1="20" y1="20" x2="68" y2="68" stroke="var(--color-ink)" strokeWidth="8" />
    </svg>
  );
}

/** The exclamation triangle that sits inside the signal word itself. */
export function WarningMark({ height = 34 }: { height?: number }) {
  return (
    <svg
      width={(height * 46) / 42}
      height={height}
      viewBox="0 0 46 42"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M23 2 L44 40 H2 Z"
        fill="#ffffff"
        stroke="#ffffff"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <rect x="20.5" y="13" width="5" height="15" fill="var(--color-red)" />
      <rect x="20.5" y="31" width="5" height="5" fill="var(--color-red)" />
    </svg>
  );
}
