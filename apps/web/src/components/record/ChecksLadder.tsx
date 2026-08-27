import { resolveSteps, STEP_COUNT, STEP_RESULT_LABEL, type StepState } from "@/lib/record/enforcement";

/**
 * The gate's pipeline, running down in order and stopping dead.
 *
 * This is the whole product made visible. The enforcement order is fixed in
 * Cairo, and this ladder is the only place a person can watch it happen: the
 * rungs land one at a time, 240ms apart, whole — no tween, no partial state —
 * so the sequence reads as discrete mechanical verification rather than a
 * progress bar filling up.
 *
 * A rung past the failure says `Not reached`. It never says `Pass` and never
 * goes blank: the gate genuinely stopped, and a step that was never evaluated
 * must not read as one that cleared.
 *
 * Steps that can refuse more than one way say so — the gate has one check
 * there, not several, and splitting it would print a pipeline the contract does
 * not run.
 */

const STATE_CLASS: Record<StepState, string> = {
  waiting: "",
  passed: " check--ran check--passed",
  failed: " check--ran check--failed",
  "not-reached": " check--ran",
};

export function ChecksLadder({
  ran,
  failedAt,
  values = {},
  firedCode = null,
  className = "",
}: {
  /** How many rungs the run has stepped through. Pass STEP_COUNT for a settled result. */
  ran: number;
  /** The step that panicked, or null when nothing has. */
  failedAt: number | null;
  /** The value each step was evaluated against, keyed by step number. */
  values?: Readonly<Record<number, string>>;
  /** Which of a step's codes actually fired. */
  firedCode?: string | null;
  className?: string;
}) {
  const steps = resolveSteps(ran, failedAt, { values, firedCode });

  return (
    <ol className={`checks ${className}`}>
      {steps.map((step) => {
        const codes = step.refusals.map((refusal) => refusal.code);
        const shown = step.firedCode ?? step.code;
        const extra = codes.length - 1;

        return (
          <li
            key={step.number}
            className={`check${STATE_CLASS[step.state]}`}
            data-state={step.state}
            title={codes.length ? `${step.title} — ${codes.join(" · ")}` : step.title}
          >
            <span className="check__index">{String(step.number).padStart(2, "0")}</span>
            <span className="check__name">
              {shown ?? "BOOK · EMIT POLICYPASSED"}
              {extra > 0 ? (
                <span className="text-ink-3">
                  {" "}
                  +{extra}
                  <span className="sr-only">
                    {" "}
                    other ways this step can refuse: {codes.slice(1).join(", ")}
                  </span>
                </span>
              ) : null}
            </span>
            <span className="check__value">{step.value ?? ""}</span>
            <span className="check__result">
              {STEP_RESULT_LABEL[step.state]}
              <span className="sr-only">
                {step.state === "waiting"
                  ? ` — step ${step.number} of ${STEP_COUNT}, not yet run`
                  : ` — step ${step.number} of ${STEP_COUNT}, ${step.title}`}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
