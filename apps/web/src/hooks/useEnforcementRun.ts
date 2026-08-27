"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { STEP_COUNT } from "@/lib/record/enforcement";

/**
 * The enforcement sequence, made watchable.
 *
 * Enforcement is the one thing about this product that is otherwise invisible:
 * it happens inside a Cairo contract in a few milliseconds and leaves a reverted
 * transaction behind. This drives it at human speed instead.
 *
 * Three movements, and they are deliberately different in character:
 *
 *  1. **The steps.** One rung every 240ms, landing whole. There is no tween and
 *     no partial rung, because a check either ran or it did not — the sequence
 *     has to read as discrete mechanical verification, not as a bar filling up.
 *  2. **The bar.** 900ms to drive the amount to the cordon line, and it stops
 *     dead there. No bounce and no settle: a limit is not springy.
 *  3. **The refusal.** A hard cut, no easing at all. A revert is not a
 *     transition.
 *
 * Under `prefers-reduced-motion` the whole thing settles to its final state
 * immediately. Nothing is withheld — the reader sees the same verdict, they
 * simply are not made to wait for it.
 */

export const STEP_INTERVAL_MS = 240;
export const DRIVE_MS = 900;

export type RunPhase = "idle" | "stepping" | "driving" | "settled";

export type EnforcementRun = {
  phase: RunPhase;
  /** How many steps have landed. */
  ran: number;
  /** True once the bar should be at its final width. */
  driving: boolean;
  /** True once the verdict may be shown. */
  settled: boolean;
  run: () => void;
  reset: () => void;
};

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useEnforcementRun({
  /** The step that panics, or null when the payment clears every one. */
  stopAt,
  /** Start the sequence as soon as this changes. */
  autoRunKey,
}: {
  stopAt: number | null;
  autoRunKey?: string;
}): EnforcementRun {
  const total = stopAt ?? STEP_COUNT;

  const [phase, setPhase] = useState<RunPhase>("idle");
  const [ran, setRan] = useState(0);
  const timers = useRef<number[]>([]);

  const clear = useCallback(() => {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current = [];
  }, []);

  const reset = useCallback(() => {
    clear();
    setRan(0);
    setPhase("idle");
  }, [clear]);

  const run = useCallback(() => {
    clear();

    if (prefersReducedMotion()) {
      setRan(total);
      setPhase("settled");
      return;
    }

    setRan(0);
    setPhase("stepping");

    for (let step = 1; step <= total; step += 1) {
      timers.current.push(
        window.setTimeout(() => setRan(step), step * STEP_INTERVAL_MS)
      );
    }

    const afterSteps = total * STEP_INTERVAL_MS;
    timers.current.push(window.setTimeout(() => setPhase("driving"), afterSteps));
    timers.current.push(window.setTimeout(() => setPhase("settled"), afterSteps + DRIVE_MS));
  }, [clear, total]);

  // A new verdict is a new run: the amount changed, so what the reader is
  // watching is a different question with a different answer.
  useEffect(() => {
    run();
    return clear;
    // `run` is stable per `total`; `autoRunKey` is what a caller changes to ask
    // for a fresh sequence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRunKey, total]);

  useEffect(() => clear, [clear]);

  return {
    phase,
    ran,
    driving: phase === "driving" || phase === "settled",
    settled: phase === "settled",
    run,
    reset,
  };
}
