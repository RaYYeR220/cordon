import type { ReactNode } from "react";

import { describeError, type Strk20NormalizedError } from "@/lib/strk20";

export function Panel({ title, subtitle, children }: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded border border-neutral-800 bg-neutral-900/40">
      <header className="border-b border-neutral-800 px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {subtitle ? <p className="mt-1 text-xs text-neutral-400">{subtitle}</p> : null}
      </header>
      <div className="space-y-3 px-4 py-3 text-sm">{children}</div>
    </section>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-neutral-800/60 pb-2 last:border-0 last:pb-0">
      <span className="text-neutral-400">{label}</span>
      <span className="text-right font-mono text-xs break-all">{children}</span>
    </div>
  );
}

/** Rendered wherever a value could not be read. Never stands in for a number. */
export function Unavailable({ why }: { why?: string }) {
  return (
    <span className="text-amber-400" title={why}>
      unavailable
    </span>
  );
}

export function Json({ value }: { value: unknown }) {
  return (
    <pre className="max-h-96 overflow-auto rounded bg-neutral-950 p-3 font-mono text-xs text-neutral-300">
      {JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item), 2)}
    </pre>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-xs">{children}</code>;
}

/**
 * The full truth about a failure: the JSON-RPC code and its spec name, the
 * decoded Cairo panic codes, the revert reason, and the untouched message.
 */
export function ErrorDetail({ error }: { error: Strk20NormalizedError }) {
  return (
    <div className="space-y-2 rounded border border-red-900/60 bg-red-950/30 p-3 text-xs">
      <div className="font-semibold text-red-300">{describeError(error)}</div>
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 font-mono text-neutral-300">
        <dt className="text-neutral-500">source</dt>
        <dd>{error.source}</dd>
        <dt className="text-neutral-500">code</dt>
        <dd>{error.code ?? "none"}</dd>
        <dt className="text-neutral-500">name</dt>
        <dd>{error.name ?? "unmapped"}</dd>
        {error.panicCodes.length ? (
          <>
            <dt className="text-neutral-500">panic</dt>
            <dd>{error.panicCodes.join(", ")}</dd>
          </>
        ) : null}
        {error.revertReason ? (
          <>
            <dt className="text-neutral-500">revert</dt>
            <dd className="whitespace-pre-wrap break-all">{error.revertReason}</dd>
          </>
        ) : null}
        <dt className="text-neutral-500">message</dt>
        <dd className="whitespace-pre-wrap break-all">{error.message}</dd>
      </dl>
      {error.data ? <Json value={error.data} /> : null}
    </div>
  );
}

const PILL_TONES = {
  ok: "border-emerald-800 bg-emerald-950/40 text-emerald-300",
  warn: "border-amber-800 bg-amber-950/40 text-amber-300",
  bad: "border-red-900 bg-red-950/40 text-red-300",
  idle: "border-neutral-700 bg-neutral-900 text-neutral-300",
} as const;

export function Pill({ tone, children }: { tone: keyof typeof PILL_TONES; children: ReactNode }) {
  return (
    <span className={`inline-block rounded border px-2 py-0.5 text-xs ${PILL_TONES[tone]}`}>
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  variant = "default",
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: "default" | "primary";
}) {
  const base =
    "rounded border px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40";
  const tone =
    variant === "primary"
      ? "border-emerald-700 bg-emerald-900/40 hover:bg-emerald-900/70"
      : "border-neutral-700 hover:bg-neutral-800";
  return (
    <button type="button" className={`${base} ${tone}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}
