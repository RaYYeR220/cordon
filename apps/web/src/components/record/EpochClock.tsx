import type { CSSProperties } from "react";

import { formatClock, formatUnits } from "@/lib/record/format";

/**
 * The velocity budget's window, printed.
 *
 * A cordon line says how much of an allowance is gone. This says *when* it
 * comes back — which is the fact a refused payer actually needs, because a
 * velocity budget does not reset on the next block. It resets when the epoch
 * rolls over and at no other moment, and the gate reads the counter from
 * storage rather than from the caller.
 */

export type EpochMark = { at: number; amount: bigint };

export function EpochClock({
  openedAt,
  closesAt,
  now,
  marks,
  className = "",
}: {
  openedAt: number;
  closesAt: number;
  now: number;
  marks: readonly EpochMark[];
  className?: string;
}) {
  const span = Math.max(1, closesAt - openedAt);
  const at = (unix: number) => `${(((unix - openedAt) / span) * 100).toFixed(3)}%`;
  const elapsed = Math.min(100, Math.max(0, ((now - openedAt) / span) * 100));

  const quarters = [0, 0.25, 0.5, 0.75, 1].map((fraction) =>
    formatClock(openedAt + fraction * span).slice(0, 5)
  );

  return (
    <div className={className}>
      <div className="clock__track">
        <div className="clock__elapsed" style={{ width: `${elapsed.toFixed(3)}%` }} />
        {marks.map((mark) => (
          <div
            key={`${mark.at}`}
            className="clock__mark"
            style={{ left: at(mark.at) } as CSSProperties}
          >
            <b>{formatUnits(mark.amount)}</b>
          </div>
        ))}
        <div className="clock__now" style={{ left: at(now) } as CSSProperties}>
          <b>Now {formatClock(now)}</b>
        </div>
      </div>
      <div className="cordonline__scale" aria-hidden="true">
        {quarters.map((quarter, index) => (
          <span key={`${quarter}-${index}`}>{quarter}</span>
        ))}
      </div>
    </div>
  );
}
