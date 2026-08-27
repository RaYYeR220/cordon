/**
 * The gate's enforcement order, as a ladder a reader can watch run.
 *
 * Nothing here is typed out by hand. The rungs are built from `allRefusals()`
 * in `@cordon/sdk`, which carries the gate's own step numbers — the ones in the
 * enforcement table in `contracts/README.md` — so the ladder is the contract's
 * order or it is nothing. Several refusals share a step, because one check can
 * fail more than one way, and they are shown together on that step rather than
 * pulled apart into rungs the gate does not have.
 *
 * The final rung is not a refusal at all: it is the step where the gate books
 * the spend and emits `PolicyPassed`. It matters that it is drawn, because it
 * is the only rung whose absence a payer can feel.
 *
 * The count is never written down in copy. Ask `STEP_COUNT`, so the ladder
 * cannot claim the gate performs a number of checks it does not.
 */

import { allRefusals, type Refusal } from "@cordon/sdk";

/** One rung: a step of the gate's pipeline, and every way it can refuse. */
export type Step = {
  /** The gate's own step number. */
  number: number;
  /** The refusals this step can raise, in the SDK's order. Empty on the final rung. */
  refusals: readonly Refusal[];
  /** The code shown on the rung. Null on the final rung, which raises nothing. */
  code: string | null;
  /** What the step does, for a reader who does not read panic codes. */
  title: string;
};

function buildSteps(): Step[] {
  const byNumber = new Map<number, Refusal[]>();

  for (const refusal of allRefusals()) {
    if (refusal.source !== "gate" || refusal.step === undefined) continue;
    const bucket = byNumber.get(refusal.step);
    if (bucket) bucket.push(refusal);
    else byNumber.set(refusal.step, [refusal]);
  }

  const steps: Step[] = [...byNumber.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([number, refusals]) => ({
      number,
      refusals,
      code: refusals[0]?.code ?? null,
      title: refusals[0]?.title ?? "",
    }));

  const last = steps.length ? steps[steps.length - 1]!.number : 0;
  steps.push({
    number: last + 1,
    refusals: [],
    code: null,
    title: "Book the spend and emit PolicyPassed",
  });

  return steps;
}

export const STEPS: readonly Step[] = buildSteps();

/** How many steps the gate actually runs. Never hard-code this in copy. */
export const STEP_COUNT = STEPS.length;

/** Where a code sits in the gate's pipeline, or null for one raised elsewhere. */
export function stepOf(code: string | null | undefined): number | null {
  if (!code) return null;
  const found = STEPS.find((step) => step.refusals.some((refusal) => refusal.code === code));
  return found ? found.number : null;
}

/** What a rung is showing at a given point in a run. */
export type StepState = "waiting" | "passed" | "failed" | "not-reached";

export type ResolvedStep = Step & {
  state: StepState;
  /** The value this step was evaluated against, when there is one worth printing. */
  value: string | null;
  /** The code that actually fired, when this step is the one that panicked. */
  firedCode: string | null;
};

/**
 * Resolve the ladder against a verdict.
 *
 * `ran` is how many rungs the run has stepped through, which is what makes the
 * sequence watchable rather than a result that simply appears. Everything past
 * a failure is `not-reached` — never "passed", never blank. The gate genuinely
 * stopped, and a step that was never evaluated must not read as one that
 * cleared.
 */
export function resolveSteps(
  ran: number,
  failedAt: number | null,
  options: { values?: Readonly<Record<number, string>>; firedCode?: string | null } = {}
): ResolvedStep[] {
  const { values = {}, firedCode = null } = options;

  return STEPS.map((step) => {
    let state: StepState;
    if (failedAt !== null && step.number > failedAt) state = "not-reached";
    else if (step.number > ran) state = "waiting";
    else if (failedAt !== null && step.number === failedAt) state = "failed";
    else state = "passed";

    return {
      ...step,
      state,
      value: values[step.number] ?? null,
      firedCode: state === "failed" ? firedCode : null,
    };
  });
}

export const STEP_RESULT_LABEL: Record<StepState, string> = {
  waiting: "",
  passed: "Pass",
  failed: "Panic",
  "not-reached": "Not reached",
};

/** Where the gate stopped, said without inventing a total. */
export function describeStop(step: number | null): string {
  return step === null
    ? "Refused outside the gate's settlement pipeline. Nothing settled."
    : `Step ${step} of ${STEP_COUNT}. Nothing settled.`;
}
