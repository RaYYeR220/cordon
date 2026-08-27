"use client";

/**
 * Which record is on the page: the seeded sample, or the chain.
 *
 * The two are never blended and never ambiguous. Sample mode is the default,
 * because a judge arrives with no wallet and still has to be able to read the
 * whole product; every screen rendered from it carries a SAMPLE RECORD stamp
 * and prints sample transaction hashes rather than linking them, since a link
 * to a transaction that does not exist is worse than no link.
 *
 * Live mode is offered only when a `PolicyGate` address is configured for this
 * build. Without one there is nothing to read, and offering a switch that
 * leads to a page of `unavailable` would be a worse answer than saying so.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type RecordMode = "sample" | "live";

type RecordSource = {
  mode: RecordMode;
  live: boolean;
  /** True when this build has a gate address to read. */
  gateConfigured: boolean;
  setMode: (mode: RecordMode) => void;
};

const Context = createContext<RecordSource | null>(null);

const STORAGE_KEY = "cordon:record-mode";

export function RecordSourceProvider({
  gateConfigured,
  children,
}: {
  gateConfigured: boolean;
  children: ReactNode;
}) {
  // Always "sample" for the first paint so the server and the client agree; a
  // stored preference is applied in an effect.
  const [mode, setModeState] = useState<RecordMode>("sample");

  useEffect(() => {
    if (!gateConfigured) return;
    const frame = window.requestAnimationFrame(() => {
      try {
        if (window.localStorage.getItem(STORAGE_KEY) === "live") setModeState("live");
      } catch {
        // A browser that refuses storage simply gets the default.
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [gateConfigured]);

  const setMode = useCallback(
    (next: RecordMode) => {
      if (next === "live" && !gateConfigured) return;
      setModeState(next);
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Not being able to remember the choice does not stop making it.
      }
    },
    [gateConfigured]
  );

  const value = useMemo<RecordSource>(
    () => ({ mode, live: mode === "live", gateConfigured, setMode }),
    [mode, gateConfigured, setMode]
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useRecordSource(): RecordSource {
  const value = useContext(Context);
  if (!value) throw new Error("useRecordSource must be used inside <RecordSourceProvider>");
  return value;
}
