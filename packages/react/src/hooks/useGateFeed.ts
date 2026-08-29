"use client";

/**
 * `useGateFeed` — the gate's public record of what it allowed, and what it refused.
 *
 * The two halves come from different places, and the hook does not pretend otherwise.
 *
 * **Passes** are on-chain events. `PolicyPassed` is emitted on every leg that clears a policy and
 * names the policy, the pseudonym, the token, the amount and the epoch. Anyone can read them.
 *
 * **Refusals** are not events and cannot be. A refusal panics, the panic reverts the whole pool
 * transaction, and a reverted transaction emits nothing — which is exactly what makes this a gate
 * rather than a report written afterwards. A refusal survives only as the receipt of the
 * transaction that hit it. So the feed shows the refusals this session watched happen, journalled
 * by `useGatedPayment`, and every entry carries its `origin` so a reader can tell which half of
 * the record they are looking at.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Refusal } from "@cordon/sdk";

import { useCordonContext } from "../context/CordonProvider.js";
import {
  readGateEvents,
  voyagerTxUrl,
  type GateEvent,
  type GateEventName,
  type Strk20NormalizedError,
} from "../strk20/index.js";

/** One row of the feed. */
export type GateFeedEntry =
  | {
      id: string;
      verdict: "pass";
      /** Read from the chain, so anyone can verify it. */
      origin: "chain";
      event: GateEvent;
      transactionHash: string;
      voyagerUrl: string;
      /** Block number, or null when the node did not report one. */
      blockNumber: number | null;
      at: number | null;
    }
  | {
      id: string;
      verdict: "refused";
      /** Observed in this browser session; a revert emits no event to read back later. */
      origin: "session";
      refusal: Refusal;
      policyId: string | null;
      transactionHash: string | null;
      voyagerUrl: string | null;
      blockNumber: null;
      at: number;
    };

export type GateFeedStatus = "loading" | "ready" | "unavailable";

export interface UseGateFeedOptions {
  /** Which gate events to read. Defaults to all four. */
  kinds?: readonly GateEventName[];
  /** Most rows to keep. Defaults to 25. */
  limit?: number;
  /** Re-read on this interval, in milliseconds. Defaults to 15000; pass 0 to poll never. */
  pollMs?: number;
  /**
   * Earliest block to read from. Defaults to a window back from the chain head.
   *
   * Pin it to the gate's deploy block when you know it: the range is then exact and the read is
   * one page rather than several.
   */
  fromBlock?: number;
  /** Blocks to look back from the head when `fromBlock` is not given. */
  lookbackBlocks?: number;
  /** Leave the session's own refusals out and show only what the chain says. */
  chainOnly?: boolean;
}

export interface UseGateFeed {
  status: GateFeedStatus;
  /** Passes and refusals merged, newest first. */
  entries: GateFeedEntry[];
  /** Just the on-chain passes. */
  passes: GateFeedEntry[];
  /** Just this session's refusals. */
  refusals: GateFeedEntry[];
  error: Strk20NormalizedError | null;
  refresh: () => Promise<void>;
  loading: boolean;
}

export function useGateFeed(options: UseGateFeedOptions = {}): UseGateFeed {
  const { provider, config, refusals: sessionRefusals } = useCordonContext();
  const { kinds, limit = 25, pollMs = 15000, fromBlock, lookbackBlocks, chainOnly = false } = options;

  const [events, setEvents] = useState<GateEvent[] | null>(null);
  const [error, setError] = useState<Strk20NormalizedError | null>(null);
  const [loading, setLoading] = useState(false);

  const kindsKey = kinds ? kinds.join(",") : "";

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const reading = await readGateEvents(provider, config.gateAddress, {
        limit,
        ...(kindsKey ? { kinds: kindsKey.split(",") as GateEventName[] } : {}),
        ...(fromBlock !== undefined ? { fromBlock } : {}),
        ...(lookbackBlocks !== undefined ? { lookbackBlocks } : {}),
      });
      if (reading.available) {
        setEvents(reading.value);
        setError(null);
      } else {
        // Keep whatever was already read. A feed that empties itself on one bad poll looks like
        // "the gate stopped working", which is the opposite of what happened.
        setError(reading.error);
      }
    } finally {
      setLoading(false);
    }
  }, [provider, config.gateAddress, limit, kindsKey, fromBlock, lookbackBlocks]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!pollMs || pollMs <= 0) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [pollMs, refresh]);

  const passes = useMemo<GateFeedEntry[]>(
    () =>
      (events ?? []).map((event, index) => ({
        id: `${event.transactionHash || "event"}:${event.kind}:${index}`,
        verdict: "pass" as const,
        origin: "chain" as const,
        event,
        transactionHash: event.transactionHash,
        voyagerUrl: voyagerTxUrl(event.transactionHash, config.chainId),
        blockNumber: event.blockNumber,
        at: null,
      })),
    [events, config.chainId],
  );

  const refused = useMemo<GateFeedEntry[]>(
    () =>
      chainOnly
        ? []
        : sessionRefusals.map((entry, index) => ({
            id: `${entry.transactionHash ?? "local"}:${entry.refusal.code}:${entry.at}:${index}`,
            verdict: "refused" as const,
            origin: "session" as const,
            refusal: entry.refusal,
            policyId: entry.policyId,
            transactionHash: entry.transactionHash,
            voyagerUrl: entry.transactionHash
              ? voyagerTxUrl(entry.transactionHash, config.chainId)
              : null,
            blockNumber: null,
            at: entry.at,
          })),
    [sessionRefusals, chainOnly, config.chainId],
  );

  const entries = useMemo<GateFeedEntry[]>(() => {
    // Session refusals are the newest thing this page knows about, so they lead. On-chain passes
    // arrive newest-first already and keep that order beneath them.
    return [...refused, ...passes].slice(0, limit);
  }, [refused, passes, limit]);

  const status: GateFeedStatus =
    events === null ? (error ? "unavailable" : "loading") : "ready";

  return { status, entries, passes, refusals: refused, error, refresh, loading };
}
