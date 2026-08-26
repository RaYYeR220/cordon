"use client";

import { useState } from "react";

import {
  formatActions,
  normalizeError,
  validateActions,
  voyagerTxUrl,
  type ActionProblem,
  type Strk20Action,
  type Strk20NormalizedError,
  type Strk20SubmitResult,
} from "@/lib/strk20";
import { Button, ErrorDetail, Json, Pill, Row } from "./ui";

export type ActionField = {
  name: string;
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
};

export type SubmitFn = (
  actions: Strk20Action[],
  onSubmitted: (transactionHash: string) => void
) => Promise<
  { ok: true; result: Strk20SubmitResult } | { ok: false; error: Strk20NormalizedError }
>;

export function ActionCard({
  title,
  description,
  fields,
  build,
  submit,
  blocked,
  chainId,
}: {
  title: string;
  description: string;
  fields: ActionField[];
  /** Builds the action array. Throws with a readable message on bad input. */
  build: () => Strk20Action[];
  /** Null while submitting is impossible; the card then only builds. */
  submit: SubmitFn | null;
  /** Why submitting is impossible, rendered next to the disabled button. */
  blocked: string | null;
  chainId: string;
}) {
  const [actions, setActions] = useState<Strk20Action[] | null>(null);
  const [problems, setProblems] = useState<ActionProblem[]>([]);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingHash, setPendingHash] = useState<string | null>(null);
  const [result, setResult] = useState<Strk20SubmitResult | null>(null);
  const [error, setError] = useState<Strk20NormalizedError | null>(null);

  const onBuild = () => {
    setResult(null);
    setError(null);
    setPendingHash(null);
    try {
      const built = build();
      setActions(built);
      setProblems(validateActions(built));
      setBuildError(null);
    } catch (caught) {
      setActions(null);
      setProblems([]);
      setBuildError(normalizeError(caught).message);
    }
  };

  const onSubmit = async () => {
    if (!actions || !submit) return;
    setSubmitting(true);
    setResult(null);
    setError(null);
    setPendingHash(null);
    try {
      const outcome = await submit(actions, setPendingHash);
      if (outcome.ok) setResult(outcome.result);
      else setError(outcome.error);
    } catch (caught) {
      // submit() is not supposed to throw; if it does, show what it threw.
      setError(normalizeError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const submitDisabled = !actions || problems.length > 0 || submitting || !submit;

  return (
    <div className="space-y-3 rounded border border-neutral-800 bg-neutral-900/40 p-4">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-1 text-xs text-neutral-400">{description}</p>
      </div>

      {fields.length ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {fields.map((field) => (
            <label key={field.name} className="block text-xs">
              <span className="text-neutral-400">{field.label}</span>
              <input
                className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 font-mono text-xs outline-none focus:border-neutral-500"
                value={field.value}
                placeholder={field.placeholder}
                onChange={(event) => field.onChange(event.target.value)}
                spellCheck={false}
              />
            </label>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onBuild}>Build action array</Button>
        <Button onClick={onSubmit} disabled={submitDisabled} variant="primary">
          {submitting ? "Submitting…" : "Submit"}
        </Button>
        {blocked ? <span className="text-xs text-amber-400">{blocked}</span> : null}
      </div>

      {buildError ? (
        <div className="rounded border border-red-900/60 bg-red-950/30 p-2 text-xs text-red-300">
          {buildError}
        </div>
      ) : null}

      {actions ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-neutral-400">
            <span>Exact payload sent to the wallet</span>
            {problems.length === 0 ? (
              <Pill tone="ok">passes local checks</Pill>
            ) : (
              <Pill tone="bad">
                {problems.length} problem{problems.length === 1 ? "" : "s"}
              </Pill>
            )}
          </div>
          <pre className="max-h-80 overflow-auto rounded bg-neutral-950 p-3 font-mono text-xs text-neutral-300">
            {formatActions(actions)}
          </pre>
          {problems.map((problem) => (
            <div
              key={problem.code}
              className="rounded border border-red-900/60 bg-red-950/30 p-2 text-xs text-red-300"
            >
              <span className="font-mono">{problem.code}</span> — {problem.message}
            </div>
          ))}
        </div>
      ) : null}

      {pendingHash && !result ? (
        <Row label="submitted">
          <TxLink hash={pendingHash} chainId={chainId} />
        </Row>
      ) : null}

      {result ? (
        <div className="space-y-2">
          <Row label="transaction">
            <TxLink hash={result.transactionHash} chainId={chainId} />
          </Row>
          <Row label="status">
            {result.status === "succeeded" ? (
              <Pill tone="ok">succeeded</Pill>
            ) : result.status === "reverted" ? (
              <Pill tone="bad">reverted</Pill>
            ) : (
              <Pill tone="warn">{result.status}</Pill>
            )}
          </Row>
          <Row label="execution / finality">
            {result.executionStatus ?? "unavailable"} / {result.finalityStatus ?? "unavailable"}
          </Row>
          <Row label="actual fee">{result.actualFee ?? "unavailable"}</Row>
          <Row label="events">{result.eventCount ?? "unavailable"}</Row>
          {result.error ? <ErrorDetail error={result.error} /> : null}
        </div>
      ) : null}

      {error ? <ErrorDetail error={error} /> : null}
      {result ? (
        <details>
          <summary className="cursor-pointer text-xs text-neutral-400">Raw result</summary>
          <div className="mt-2">
            <Json value={result} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

function TxLink({ hash, chainId }: { hash: string; chainId: string }) {
  return (
    <a
      className="underline hover:text-neutral-200"
      href={voyagerTxUrl(hash, chainId)}
      target="_blank"
      rel="noreferrer"
    >
      {hash} ↗
    </a>
  );
}
