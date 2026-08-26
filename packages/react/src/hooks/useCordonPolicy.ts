"use client";

/**
 * `useCordonPolicy` — read a published rule set, and how much of it a subject has left.
 *
 * A policy is immutable once published, so this is a cheap read that rarely changes. The velocity
 * counter beside it is not: it is keyed by `(subject_public_key, policy_id, epoch_index)` and moves
 * every time that subject settles, which is what `<SpendMeter>` renders.
 *
 * Three outcomes, not two. `missing` means the registry answered clearly that nothing is published
 * under this id — a different fact from `unavailable`, which means the node would not answer at
 * all. Collapsing them would tell a user their policy does not exist when their RPC is down.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  currentEpoch as localEpoch,
  describePolicy,
  epochResetsAt as localEpochResetsAt,
  feltToShortString,
  toFelt,
  type Felt,
  type FeltLike,
  type Policy,
} from "@cordon/sdk";

import { useCordonContext } from "../context/CordonProvider.js";
import {
  readCurrentEpoch,
  readEpochSpend,
  readPolicy,
  type Strk20NormalizedError,
} from "../strk20/index.js";

export type PolicyStatus =
  /** No policy id was given. */
  | "idle"
  /** The read is in flight. */
  | "loading"
  /** Published and readable. */
  | "ready"
  /** The registry says nothing is published under this id, or it was retired. */
  | "missing"
  /** The node would not answer. The policy's contents are unknown, not empty. */
  | "unavailable";

export interface UseCordonPolicyOptions {
  /**
   * Read the velocity counter for this pseudonym as well. Without it the meter shows the policy's
   * limits but not how much of them is spent, and says so.
   */
  subjectPublicKey?: FeltLike | null;
  /** Re-read the velocity counter on this interval, in milliseconds. Off when omitted. */
  pollMs?: number;
}

export interface UseCordonPolicy {
  status: PolicyStatus;
  policyId: Felt | null;
  /** The policy id as a short string when it encodes one, e.g. `ACCREDITED_EU`. */
  label: string | null;
  policy: Policy | null;
  /** The policy in plain sentences, one rule per line. Empty until it is read. */
  description: string[];
  error: Strk20NormalizedError | null;

  /** The epoch the gate would book a settlement into now, read from the gate. */
  epoch: bigint | null;
  /** What this subject has already moved in that epoch. Null when it could not be read. */
  epochSpend: bigint | null;
  /** What is left in this epoch, or null with no velocity limit or no reading. */
  remainingThisEpoch: bigint | null;
  /** Unix seconds at which the epoch rolls over, or null without a velocity limit. */
  epochResetsAt: number | null;
  /** True only when both the policy and this subject's spend were actually read. */
  velocityAvailable: boolean;

  refresh: () => Promise<void>;
  loading: boolean;
}

export function useCordonPolicy(
  policyId: FeltLike | null | undefined,
  options: UseCordonPolicyOptions = {},
): UseCordonPolicy {
  const { provider, config, registries } = useCordonContext();
  const { subjectPublicKey, pollMs } = options;

  const id = useMemo<Felt | null>(() => {
    if (policyId === null || policyId === undefined || policyId === "") return null;
    try {
      return toFelt(policyId);
    } catch {
      return null;
    }
  }, [policyId]);

  const [policy, setPolicy] = useState<Policy | null>(null);
  const [status, setStatus] = useState<PolicyStatus>("idle");
  const [error, setError] = useState<Strk20NormalizedError | null>(null);
  const [epoch, setEpoch] = useState<bigint | null>(null);
  const [epochSpend, setEpochSpend] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);

  const policyRegistry = registries?.available ? registries.value.policyRegistry : null;

  const refresh = useCallback(async (): Promise<void> => {
    if (!id) {
      setStatus("idle");
      setPolicy(null);
      return;
    }
    if (!policyRegistry) {
      // The registries are still being read off the gate, or that read failed. Either way the
      // policy's contents are unknown; nothing here invents an empty one.
      setStatus(registries && !registries.available ? "unavailable" : "loading");
      if (registries && !registries.available) setError(registries.error);
      return;
    }

    setLoading(true);
    try {
      const reading = await readPolicy(provider, policyRegistry, id);
      if (!reading.available) {
        setPolicy(null);
        setError(reading.error);
        setStatus(reading.missing ? "missing" : "unavailable");
        return;
      }
      setPolicy(reading.value);
      setError(null);
      setStatus("ready");

      // Velocity is a separate question and a separate failure. A policy that read fine stays
      // readable even when the counter beside it does not.
      const epochReading = await readCurrentEpoch(provider, config.gateAddress, id);
      const epochIndex = epochReading.available ? epochReading.value : null;
      setEpoch(epochIndex);

      if (subjectPublicKey === null || subjectPublicKey === undefined || epochIndex === null) {
        setEpochSpend(null);
        return;
      }
      const spend = await readEpochSpend(
        provider,
        config.gateAddress,
        subjectPublicKey,
        id,
        epochIndex,
      );
      setEpochSpend(spend.available ? spend.value : null);
    } finally {
      setLoading(false);
    }
  }, [id, policyRegistry, registries, provider, config.gateAddress, subjectPublicKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!pollMs || pollMs <= 0) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [pollMs, refresh]);

  const remainingThisEpoch = useMemo<bigint | null>(() => {
    if (!policy || policy.epochLength === 0n || epochSpend === null) return null;
    return policy.maxPerEpoch > epochSpend ? policy.maxPerEpoch - epochSpend : 0n;
  }, [policy, epochSpend]);

  const epochResetsAt = useMemo<number | null>(() => {
    if (!policy || policy.epochLength === 0n) return null;
    // The gate's epoch index is authoritative; derive the boundary from it when we have it, and
    // fall back to the local clock only when we do not.
    if (epoch !== null) return Number((epoch + 1n) * policy.epochLength);
    void localEpoch;
    return localEpochResetsAt(policy);
  }, [policy, epoch]);

  return {
    status,
    policyId: id,
    label: id ? (feltToShortString(id) ?? id) : null,
    policy,
    description: policy ? describePolicy(policy) : [],
    error,
    epoch,
    epochSpend,
    remainingThisEpoch,
    epochResetsAt,
    velocityAvailable: policy !== null && policy.epochLength > 0n && epochSpend !== null,
    refresh,
    loading,
  };
}
