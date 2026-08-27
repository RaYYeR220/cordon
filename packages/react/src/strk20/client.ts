/**
 * Submitting STRK20 transactions and reading back what happened.
 *
 * Two routes, and which one a payment takes is not a style choice.
 *
 * `submitActions` hands an action array to the wallet, which proves it, adds its own fee action
 * and submits. That is the route for a plain STRK20 operation.
 *
 * A **gated** payment cannot use it. The subject signs the note its value is allowed to land in,
 * and only the wallet knows that id — so the SDK prepares the transaction first to learn it, signs
 * bound to it, prepares again, and what comes back is a resolved call plus a proof.
 * `submitPreparedCall` sends that. The wallet adds no fee action in this mode, so the submitting
 * account pays the fee itself.
 */

import { num } from "starknet";
import { validateActions, type Strk20Action } from "@cordon/sdk";

import { WAIT_RETRIES, WAIT_RETRY_INTERVAL_MS } from "./config.js";
import { normalizeError } from "./errors.js";
import type { EventProvider } from "./events.js";
import type { ReadProvider } from "./registries.js";
import type { Strk20NormalizedError, Strk20SubmitResult } from "./types.js";

/** The subset of `WalletAccountV6` the wallet-submits route needs. */
export type Strk20Submitter = {
  strk20InvokeTransaction: (actions: Strk20Action[]) => Promise<{ transaction_hash: string }>;
};

/**
 * The subset of `WalletAccountV6` the bound-authorisation route needs.
 *
 * `strk20PrepareInvoke` is optional on a wallet. Without it the resolved note id cannot be known
 * before signing, and there is no safe way to proceed. The answer is to report that, never to sign
 * an unbound authorisation instead.
 */
export type Strk20Preparer = {
  strk20PrepareInvoke: (
    actions: Strk20Action[],
    simulate?: boolean,
  ) => Promise<{ call: unknown; proof?: unknown }>;
  executeWithProof: (call: unknown, proof?: unknown) => Promise<{ transaction_hash: string }>;
};

/**
 * Whether this wallet can do the prepare-twice flow at all.
 *
 * A structural check rather than a call, because asking costs a proof. A wallet missing either
 * half cannot carry a bound authorisation, and that is a state to render, not to work around.
 */
export function supportsPreparedInvoke(account: unknown): account is Strk20Preparer {
  if (typeof account !== "object" || account === null) return false;
  const candidate = account as Record<string, unknown>;
  return (
    typeof candidate["strk20PrepareInvoke"] === "function" &&
    typeof candidate["executeWithProof"] === "function"
  );
}

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
 *
 * `getChainId` is here because an authorisation's signature covers the chain id, and a configured
 * default that disagrees with the node produces signatures that verify nowhere. It is asked for
 * rather than assumed.
 */
export interface CordonRpc extends ReadProvider, EventProvider, TransactionWaiter {
  getChainId(): Promise<string>;
}

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
  return waitForOutcome(provider, transactionHash, options);
}

/**
 * Submit a call the wallet already prepared and proved.
 *
 * This is the tail of the prepare-twice flow: the note id is settled, the subject's signature is
 * bound to it, and the proof in hand is the one for exactly these actions. Re-deriving the
 * transaction here would defeat the point, so the resolved call goes out untouched.
 *
 * The wait budget matches `submitActions` — proof verification happens on chain, so a timeout is
 * reported as `unconfirmed` rather than as a failure.
 */
export async function submitPreparedCall(
  submitter: Strk20Preparer,
  provider: TransactionWaiter,
  prepared: { call: unknown; proof?: unknown },
  options: Omit<SubmitOptions, "skipValidation"> = {},
): Promise<SubmitOutcome> {
  let transactionHash: string;
  try {
    const submitted = await submitter.executeWithProof(prepared.call, prepared.proof);
    transactionHash = submitted.transaction_hash;
  } catch (error) {
    return { ok: false, transactionHash: null, error: normalizeError(error) };
  }

  options.onSubmitted?.(transactionHash);
  return waitForOutcome(provider, transactionHash, options);
}

/**
 * Wait for a receipt and reduce it to an outcome.
 *
 * Shared by both submit routes so a reverted gated payment and a reverted plain action report
 * their revert reason identically — the refusal decoder upstream sees one shape.
 */
async function waitForOutcome(
  provider: TransactionWaiter,
  transactionHash: string,
  options: { retries?: number; retryIntervalMs?: number },
): Promise<SubmitOutcome> {
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
