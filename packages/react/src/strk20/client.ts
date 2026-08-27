/**
 * Submitting STRK20 transactions and reading back what happened.
 */

import { num } from "starknet";
import { validateActions, type Strk20Action } from "@cordon/sdk";

import { WAIT_RETRIES, WAIT_RETRY_INTERVAL_MS } from "./config.js";
import { normalizeError } from "./errors.js";
import type { EventProvider } from "./events.js";
import type { ReadProvider } from "./registries.js";
import type { Strk20NormalizedError, Strk20SubmitResult } from "./types.js";

/** The subset of `WalletAccountV6` this module needs. */
export type Strk20Submitter = {
  strk20InvokeTransaction: (actions: Strk20Action[]) => Promise<{ transaction_hash: string }>;
};

/** The one provider method the submit path needs beyond the reads. */
export interface TransactionWaiter {
  waitForTransaction(
    transactionHash: string,
    options?: { retries?: number; retryInterval?: number },
  ): Promise<unknown>;
}

/**
 * Everything this package asks of a provider.
 *
 * Declared structurally rather than as `RpcProvider` so a host app can hand `<CordonProvider>` the
 * provider it already has — including one wrapped in its own retry or caching layer — instead of
 * ending up with two connections to the same node.
 */
export interface CordonRpc extends ReadProvider, EventProvider, TransactionWaiter {}

export type SubmitOptions = {
  /** Called as soon as the wallet returns a hash, before confirmation. */
  onSubmitted?: (transactionHash: string) => void;
  /** Skip the local pre-flight check. Off by default. */
  skipValidation?: boolean;
  retries?: number;
  retryIntervalMs?: number;
};

export type SubmitOutcome =
  | { ok: true; result: Strk20SubmitResult }
  | { ok: false; error: Strk20NormalizedError; transactionHash: string | null };

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

/**
 * Pull the parts of a receipt worth reporting on.
 *
 * The receipt is a union of several spec shapes across RPC versions, so it is read defensively: a
 * field that cannot be found is reported as null rather than defaulted.
 */
export function readReceipt(receipt: unknown): {
  executionStatus: string | null;
  finalityStatus: string | null;
  actualFee: string | null;
  eventCount: number | null;
  revertReason: string | null;
} {
  const root =
    typeof receipt === "object" && receipt !== null
      ? ((receipt as { value?: unknown }).value ?? receipt)
      : null;
  if (typeof root !== "object" || root === null) {
    return {
      executionStatus: null,
      finalityStatus: null,
      actualFee: null,
      eventCount: null,
      revertReason: null,
    };
  }
  const record = root as Record<string, unknown>;

  const fee = record["actual_fee"];
  let actualFee: string | null = null;
  const rawFee =
    typeof fee === "object" && fee !== null ? (fee as { amount?: unknown }).amount : fee;
  if (typeof rawFee === "string" || typeof rawFee === "number" || typeof rawFee === "bigint") {
    try {
      actualFee = num.toBigInt(rawFee).toString();
    } catch {
      actualFee = String(rawFee);
    }
  }

  return {
    executionStatus: readString(record, "execution_status"),
    finalityStatus: readString(record, "finality_status"),
    actualFee,
    eventCount: Array.isArray(record["events"]) ? record["events"].length : null,
    revertReason: readString(record, "revert_reason"),
  };
}

/**
 * Hand an action array to the wallet, then wait for the receipt.
 *
 * The wallet generates a STARK proof before it can even submit, and the proof is verified
 * on-chain afterwards, so both halves are slow — the wait budget is deliberately generous
 * (400 x 3s by default) and a timeout is reported as `unconfirmed`, never as a failure: the
 * transaction may well land later.
 */
export async function submitActions(
  submitter: Strk20Submitter,
  provider: TransactionWaiter,
  actions: Strk20Action[],
  options: SubmitOptions = {},
): Promise<SubmitOutcome> {
  if (!options.skipValidation) {
    const problems = validateActions(actions);
    if (problems.length) {
      return {
        ok: false,
        transactionHash: null,
        error: normalizeError(
          new Error(
            `Action array rejected before submission: ${problems
              .map((problem) => `${problem.code}: ${problem.message}`)
              .join(" ")}`,
          ),
        ),
      };
    }
  }

  let transactionHash: string;
  try {
    const submitted = await submitter.strk20InvokeTransaction(actions);
    transactionHash = submitted.transaction_hash;
  } catch (error) {
    return { ok: false, transactionHash: null, error: normalizeError(error) };
  }

  options.onSubmitted?.(transactionHash);

  try {
    const receipt = await provider.waitForTransaction(transactionHash, {
      retries: options.retries ?? WAIT_RETRIES,
      retryInterval: options.retryIntervalMs ?? WAIT_RETRY_INTERVAL_MS,
    });
    const parsed = readReceipt(receipt);
    const reverted = parsed.executionStatus === "REVERTED";

    return {
      ok: true,
      result: {
        transactionHash,
        status: reverted ? "reverted" : "succeeded",
        error: reverted
          ? normalizeError(
              new Error(
                parsed.revertReason ?? "Transaction reverted without a reason in the receipt.",
              ),
            )
          : null,
        executionStatus: parsed.executionStatus,
        finalityStatus: parsed.finalityStatus,
        actualFee: parsed.actualFee,
        eventCount: parsed.eventCount,
      },
    };
  } catch (error) {
    return {
      ok: true,
      result: {
        transactionHash,
        status: "unconfirmed",
        error: normalizeError(error),
        executionStatus: null,
        finalityStatus: null,
        actualFee: null,
        eventCount: null,
      },
    };
  }
}
