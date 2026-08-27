"use client";

import { useEffect, useMemo, useState } from "react";
import { RpcProvider } from "starknet";

import { loadConfig, normalizeError, type Strk20NormalizedError } from "@/lib/strk20";

/**
 * The head of the chain, for the masthead's block and clock.
 *
 * A record needs a date on it, and in live mode that date has to come from the
 * chain rather than from the browser: the point of the whole product is that
 * what it prints was read from somewhere anyone else can read too. A failed
 * read stays null, and the masthead prints `unavailable` for it.
 */
export type ChainHead = {
  block: number | null;
  at: number | null;
  error: Strk20NormalizedError | null;
  loading: boolean;
};

export function useChainHead(enabled: boolean, pollMs = 30_000): ChainHead {
  const config = useMemo(() => loadConfig(), []);
  const [head, setHead] = useState<ChainHead>({
    block: null,
    at: null,
    error: null,
    loading: enabled,
  });

  useEffect(() => {
    if (!enabled) {
      setHead({ block: null, at: null, error: null, loading: false });
      return;
    }

    const provider = new RpcProvider({ nodeUrl: config.rpcUrl });
    let cancelled = false;

    const read = async () => {
      try {
        const block = await provider.getBlockLatestAccepted();
        if (cancelled) return;
        setHead({
          block: typeof block.block_number === "number" ? block.block_number : null,
          at: null,
          error: null,
          loading: false,
        });
      } catch (error) {
        if (cancelled) return;
        setHead({ block: null, at: null, error: normalizeError(error), loading: false });
      }
    };

    void read();
    const timer = pollMs > 0 ? window.setInterval(() => void read(), pollMs) : null;
    return () => {
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [enabled, config.rpcUrl, pollMs]);

  return head;
}
