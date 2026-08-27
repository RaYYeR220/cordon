"use client";

import { useEffect, useState } from "react";

/**
 * The wall clock, as state.
 *
 * A countdown has to actually count, and reading `Date.now()` during render
 * makes a component's output depend on when React happened to run it. This
 * ticks instead, and returns `null` until the first tick — which is also what
 * the server renders, so nothing about the page depends on the server and the
 * browser agreeing about the time.
 */
export function useNow(intervalMs = 1000): number | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    const frame = window.requestAnimationFrame(tick);
    const timer = window.setInterval(tick, intervalMs);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearInterval(timer);
    };
  }, [intervalMs]);

  return now;
}
