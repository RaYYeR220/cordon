"use client";

/**
 * `useGatedPayment` — build, sign, submit and follow one leg of a gated payment.
 *
 * The whole state machine is surfaced, including the one most payment hooks hide: **refused**. A
 * Cordon refusal is not an error, it is the product working. The gate panics, the pool transaction
 * reverts whole, the value stays shielded, and a specific `CORDON_*` code says which rule fired.
 * That deserves its own terminal state, distinct from "the node was unreachable" (`failed`) and
 * from "we stopped waiting" (`unconfirmed`).
 *
 * Two things are worth knowing before wiring this up.
 *
 * **The pre-flight is free and the transaction is not.** Before anything is signed, the same rules
 * the gate enforces are run locally against the policy, the credential and the epoch counter. If
 * one of them would refuse, the hook stops and reports the refusal without spending the pool's
 * 6 STRK fee. Pass `force` to submit anyway — which is what you want when the refusal itself is
 * the thing you are demonstrating.
 *
 * **The subject signs a resolved note id, and only the wallet knows it.** `${openNoteIds[0]}` is
 * substituted by the wallet while it assembles the transaction, but the gate hashes the felt it
 * actually received, so the subject's signature has to cover the resolved value. This package
 * cannot invent it: supply `noteId` for the `direct`, `claim` and `refund` legs. Without it the
 * hook reports itself blocked rather than signing something that would come back as
 * `CORDON_BAD_SUBJECT_SIG`. The `fund` leg reserves no note and needs nothing.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import {
  FUND_NOTE_ID,
  authorizeAction,
  buildClaimActions,
  buildDirectActions,
  buildFundActions,
  buildRefundActions,
  decodeRefusal,
  decodeRefusalFromError,
  preflight as runPreflight,
  randomNonce,
  signAction,
  toBigInt,
  toFelt,
  type Credential,
  type Felt,
  type FeltLike,
  type Preflight,
  type Refusal,
  type Strk20Action,
} from "@cordon/sdk";

import { useCordonContext } from "../context/CordonProvider.js";
import {
  readEpochSpend,
  readIssuerActive,
  readIssuerPublicKey,
  readNonceUsed,
  readPolicy,
  readRevoked,
  readSettlement,
  submitActions,
  voyagerTxUrl,
  type Strk20NormalizedError,
  type Strk20SubmitResult,
} from "../strk20/index.js";

/** Which leg of `privacy_invoke` to run. */
export type PaymentLeg = "direct" | "fund" | "claim" | "refund";

/**
 * Where a payment is.
 *
 * `refused` and `failed` are deliberately different words. A refusal is the gate doing its job and
 * naming a rule; a failure is everything else — a declined wallet prompt, an unreachable node, a
 * malformed action array.
 */
export type PaymentStatus =
  | "idle"
  /** Reading chain state, running the pre-flight, signing the authorisation locally. */
  | "building"
  /** Handed to the wallet, which is proving and asking the user to approve. */
  | "awaiting-signature"
  /** The wallet returned a hash. On chain, not yet final. */
  | "submitted"
  /** Executed successfully. The value moved. */
  | "confirmed"
  /** A rule refused it. The transaction reverted and nothing moved. */
  | "refused"
  /** Something outside the gate went wrong. */
  | "failed"
  /** Stopped waiting for the receipt. It may still land. */
  | "unconfirmed";

/** Why a payment cannot be attempted yet. One per missing precondition. */
export interface PaymentBlocker {
  code:
    | "NO_WALLET"
    | "NO_STRK20_SUPPORT"
    | "NO_CREDENTIAL"
    | "NO_SUBJECT_KEY"
    | "NO_POLICY_ID"
    | "NO_AMOUNT"
    | "NO_PAYEE"
    | "NO_RECIPIENT"
    | "NO_NOTE_ID"
    | "NO_SETTLEMENT_ID"
    | "NO_REGISTRIES";
  message: string;
}

export interface UseGatedPaymentOptions {
  /** Defaults to `direct`: gated value straight into the payee's note, in one transaction. */
  leg?: PaymentLeg;
  /** The published rule set to settle under. Required for `direct` and `fund`. */
  policyId?: FeltLike | null;
  /** Value to move, in the token's base units. Required for `direct` and `fund`. */
  amount?: bigint | null;
  /** The pool user the resulting open note is credited to. Required for `direct`. */
  payee?: string | null;
  /** Who a claimed or refunded note is credited to. Required for `claim` and `refund`. */
  recipient?: string | null;
  /** The issuer-signed credential to present. */
  credential?: Credential | null;
  /** The secret behind `credential.subjectPublicKey`. Signs the authorisation, locally. */
  subjectPrivateKey?: FeltLike | null;
  /**
   * The **resolved** open-note id the subject signs over. A literal, or a function that resolves
   * one at build time. Not needed on the `fund` leg.
   */
  noteId?: FeltLike | (() => FeltLike | Promise<FeltLike>) | null;
  /** Names the escrow. Required for `fund`, `claim` and `refund`. */
  settlementId?: FeltLike | null;
  /** The policy a claimant will have to satisfy. Required for `fund`. */
  payeeClaimPolicyId?: FeltLike | null;
  /** Unix seconds after which only a refund is possible. Required for `fund`. */
  expiresAt?: FeltLike | null;
  /** Override the nonce. A fresh random one is used per attempt otherwise. */
  nonce?: FeltLike | null;
  /** The ERC20 to settle. Defaults to the provider's configured token. */
  token?: string;
  /** Called once a refusal is known, whether predicted or on chain. */
  onRefused?: (refusal: Refusal, transactionHash: string | null) => void;
  onConfirmed?: (result: Strk20SubmitResult) => void;
}

export interface PayOptions {
  /**
   * Submit even when the pre-flight predicted a refusal.
   *
   * The pool's fee is charged regardless of the outcome, so this is off by default. Turn it on
   * when the revert is the point — proving on chain that the gate refused is a stronger claim
   * than predicting it off chain.
   */
  force?: boolean;
}

export interface UseGatedPayment {
  status: PaymentStatus;
  /** True while the payment is in a state that is still moving. */
  busy: boolean;
  /** The rule that refused this payment, predicted or on chain. */
  refusal: Refusal | null;
  /** True when `refusal` came from the local pre-flight rather than from a revert. */
  predicted: boolean;
  /** What the pre-flight worked out, including checks it could not run. */
  preflight: Preflight | null;
  /** Anything that went wrong outside the gate. */
  error: Strk20NormalizedError | null;
  transactionHash: string | null;
  /** Voyager link for `transactionHash`, on the configured chain. */
  voyagerUrl: string | null;
  /** The receipt, once there is one. */
  result: Strk20SubmitResult | null;
  /** The action array as it went to the wallet, placeholders intact. For display and debugging. */
  actions: Strk20Action[] | null;
  /** Everything missing before this can be attempted. Empty means ready. */
  blockers: PaymentBlocker[];
  ready: boolean;
  pay: (options?: PayOptions) => Promise<void>;
  reset: () => void;
}

function resolveAsync<T>(value: T | (() => T | Promise<T>)): Promise<T> {
  return Promise.resolve(typeof value === "function" ? (value as () => T | Promise<T>)() : value);
}

export function useGatedPayment(options: UseGatedPaymentOptions = {}): UseGatedPayment {
  const { config, provider, connection, capability, registries, recordRefusal } =
    useCordonContext();

  const leg = options.leg ?? "direct";

  const [status, setStatus] = useState<PaymentStatus>("idle");
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [predicted, setPredicted] = useState(false);
  const [preflightResult, setPreflightResult] = useState<Preflight | null>(null);
  const [error, setError] = useState<Strk20NormalizedError | null>(null);
  const [transactionHash, setTransactionHash] = useState<string | null>(null);
  const [result, setResult] = useState<Strk20SubmitResult | null>(null);
  const [actions, setActions] = useState<Strk20Action[] | null>(null);

  // The options object is rebuilt on every render by most callers, so `pay` reads the latest
  // through a ref instead of being re-created — otherwise a click handler captured one render ago
  // would pay with stale inputs.
  const latest = useRef(options);
  latest.current = options;

  const blockers = useMemo<PaymentBlocker[]>(() => {
    const found: PaymentBlocker[] = [];
    const add = (code: PaymentBlocker["code"], message: string): void => {
      found.push({ code, message });
    };

    if (!connection) add("NO_WALLET", "Connect a wallet first.");
    else if (capability && capability.status !== "supported") {
      add("NO_STRK20_SUPPORT", capability.reason);
    }
    if (registries && !registries.available) {
      add(
        "NO_REGISTRIES",
        "The gate's registry addresses could not be read, so no credential or policy check can " +
          "be made against them.",
      );
    }

    const needsPolicy = leg === "direct" || leg === "fund";
    const needsCredential = leg === "direct" || leg === "fund" || leg === "claim";

    if (needsPolicy && !options.policyId) add("NO_POLICY_ID", "Choose a policy to settle under.");
    if (needsCredential && !options.credential) {
      add("NO_CREDENTIAL", "Load the credential this policy asks for.");
    }
    if (!options.subjectPrivateKey) {
      add(
        "NO_SUBJECT_KEY",
        "The subject key that authorises this settlement is not available. Derive it from the " +
          "wallet, or supply one.",
      );
    }
    if ((leg === "direct" || leg === "fund") && (options.amount ?? 0n) <= 0n) {
      add("NO_AMOUNT", "Enter an amount above zero.");
    }
    if (leg === "direct" && !options.payee) add("NO_PAYEE", "Name the payee.");
    if ((leg === "claim" || leg === "refund") && !options.recipient) {
      add("NO_RECIPIENT", "Name the address the note is credited to.");
    }
    if (leg !== "direct" && leg !== "fund" && !options.settlementId) {
      add("NO_SETTLEMENT_ID", "Name the settlement.");
    }
    if (leg === "fund" && !options.settlementId) {
      add("NO_SETTLEMENT_ID", "Choose a settlement id. It is single-use, forever.");
    }
    if (leg !== "fund" && (options.noteId === null || options.noteId === undefined)) {
      add(
        "NO_NOTE_ID",
        "The subject signs the resolved open-note id, which only the wallet knows while it " +
          "assembles the transaction. Supply `noteId`; signing the placeholder instead would " +
          "come back from the gate as CORDON_BAD_SUBJECT_SIG.",
      );
    }
    return found;
  }, [connection, capability, registries, leg, options]);

  const reset = useCallback((): void => {
    setStatus("idle");
    setRefusal(null);
    setPredicted(false);
    setPreflightResult(null);
    setError(null);
    setTransactionHash(null);
    setResult(null);
    setActions(null);
  }, []);

  const fail = useCallback((normalized: Strk20NormalizedError): void => {
    setError(normalized);
    setStatus("failed");
  }, []);

  const refuse = useCallback(
    (found: Refusal, hash: string | null, fromPreflight: boolean, policyId: string | null) => {
      setRefusal(found);
      setPredicted(fromPreflight);
      setStatus("refused");
      recordRefusal({ refusal: found, transactionHash: hash, policyId });
      latest.current.onRefused?.(found, hash);
    },
    [recordRefusal],
  );

  const pay = useCallback(
    async (payOptions: PayOptions = {}): Promise<void> => {
      const current = latest.current;
      const currentLeg = current.leg ?? "direct";
      const currentToken = current.token ?? config.token;

      if (!connection) {
        fail({
          source: "unknown",
          code: null,
          name: null,
          message: "No wallet is connected.",
          revertReason: null,
          panicCodes: [],
          data: null,
        });
        return;
      }

      setStatus("building");
      setRefusal(null);
      setPredicted(false);
      setError(null);
      setTransactionHash(null);
      setResult(null);

      try {
        const nonce = current.nonce !== null && current.nonce !== undefined
          ? toFelt(current.nonce)
          : randomNonce();
        const gate = config.gateAddress;
        const registryAddresses = registries?.available ? registries.value : null;

        // The amount the subject signs over has to be the amount the gate will see. On the later
        // legs that is the stored settlement's amount, not anything the caller passes.
        let amount: bigint;
        let policyId: Felt;
        let noteId: Felt;

        if (currentLeg === "direct" || currentLeg === "fund") {
          amount = current.amount ?? 0n;
          policyId = toFelt(current.policyId ?? 0);
          noteId =
            currentLeg === "fund"
              ? FUND_NOTE_ID
              : toFelt(await resolveAsync(current.noteId as FeltLike));
        } else {
          const settlement = await readSettlement(
            provider,
            gate,
            current.settlementId as FeltLike,
          );
          if (!settlement.available) {
            fail(settlement.error);
            return;
          }
          amount = settlement.value.amount;
          policyId =
            currentLeg === "claim"
              ? settlement.value.payeeClaimPolicyId
              : settlement.value.payerPolicyId;
          noteId = toFelt(await resolveAsync(current.noteId as FeltLike));
        }

        // Pre-flight. Every check that cannot be run is reported as skipped rather than assumed to
        // pass, so a green light here means "nothing we could check would refuse this", never
        // "this will definitely settle".
        let flight: Preflight | null = null;
        if (current.credential && registryAddresses && (currentLeg === "direct" || currentLeg === "fund")) {
          flight = await buildPreflight({
            credential: current.credential,
            policyId,
            amount,
            gate,
            nonce,
            provider,
            registries: registryAddresses,
          });
          setPreflightResult(flight);
          if (flight.refusal && !payOptions.force) {
            refuse(flight.refusal, null, true, policyId);
            return;
          }
        }

        // Sign the authorisation. This is the subject's own STARK-curve key, not the wallet's:
        // the pseudonym is what velocity and replay protection are keyed by, and binding it to a
        // wallet address would undo the privacy the pool provides.
        const signingParams = {
          chainId: config.chainId,
          gate,
          policyId,
          noteId,
          token: currentToken,
          amount,
          nonce,
        };
        const subjectKey = current.subjectPrivateKey as FeltLike;

        let built: Strk20Action[];
        if (currentLeg === "direct") {
          built = buildDirectActions({
            gate,
            token: currentToken,
            amount,
            payee: current.payee as string,
            payer: authorizeAction(
              { ...signingParams, credential: current.credential as Credential },
              subjectKey,
            ),
          });
        } else if (currentLeg === "fund") {
          built = buildFundActions({
            gate,
            token: currentToken,
            amount,
            payer: authorizeAction(
              { ...signingParams, credential: current.credential as Credential },
              subjectKey,
            ),
            settlementId: current.settlementId as FeltLike,
            payeeClaimPolicyId: current.payeeClaimPolicyId as FeltLike,
            expiresAt: current.expiresAt as FeltLike,
          });
        } else if (currentLeg === "claim") {
          built = buildClaimActions({
            gate,
            token: currentToken,
            settlementId: current.settlementId as FeltLike,
            credential: current.credential as Credential,
            signature: signAction(signingParams, subjectKey),
            nonce,
            recipient: current.recipient as string,
          });
        } else {
          built = buildRefundActions({
            gate,
            token: currentToken,
            settlementId: current.settlementId as FeltLike,
            signature: signAction(signingParams, subjectKey),
            nonce,
            recipient: current.recipient as string,
          });
        }
        setActions(built);

        setStatus("awaiting-signature");
        const outcome = await submitActions(connection.account, provider, built, {
          onSubmitted: (hash) => {
            setTransactionHash(hash);
            setStatus("submitted");
          },
        });

        if (!outcome.ok) {
          // A wallet or node error can still carry a Cordon panic code — a node that simulates
          // before submitting reports the revert reason here rather than in a receipt.
          const decoded = decodeRefusalFromError(outcome.error);
          if (decoded.code !== "UNKNOWN") {
            refuse(decoded, outcome.transactionHash, false, policyId);
            return;
          }
          setTransactionHash(outcome.transactionHash);
          fail(outcome.error);
          return;
        }

        setResult(outcome.result);
        setTransactionHash(outcome.result.transactionHash);

        if (outcome.result.status === "reverted") {
          const reason =
            outcome.result.error?.revertReason ?? outcome.result.error?.message ?? "";
          refuse(decodeRefusal(reason), outcome.result.transactionHash, false, policyId);
          return;
        }
        if (outcome.result.status === "unconfirmed") {
          setStatus("unconfirmed");
          return;
        }
        setStatus("confirmed");
        current.onConfirmed?.(outcome.result);
      } catch (caught) {
        // Anything thrown while assembling — a malformed felt, a resolver that rejected — is
        // reported as a failure with its own message. It is never swallowed into a false refusal.
        const decoded = decodeRefusalFromError(caught);
        if (decoded.code !== "UNKNOWN") {
          refuse(decoded, null, false, null);
          return;
        }
        fail({
          source: "unknown",
          code: null,
          name: null,
          message: caught instanceof Error ? caught.message : String(caught),
          revertReason: null,
          panicCodes: [],
          data: null,
        });
      }
    },
    [connection, config, provider, registries, fail, refuse],
  );

  return {
    status,
    busy: status === "building" || status === "awaiting-signature" || status === "submitted",
    refusal,
    predicted,
    preflight: preflightResult,
    error,
    transactionHash,
    voyagerUrl: transactionHash ? voyagerTxUrl(transactionHash, config.chainId) : null,
    result,
    actions,
    blockers,
    ready: blockers.length === 0,
    pay,
    reset,
  };
}

/** Gather what the gate will see, then ask the SDK what it would decide. */
async function buildPreflight(params: {
  credential: Credential;
  policyId: Felt;
  amount: bigint;
  gate: string;
  nonce: Felt;
  provider: Parameters<typeof readPolicy>[0];
  registries: { issuerRegistry: string; revocationRegistry: string; policyRegistry: string };
}): Promise<Preflight> {
  const { credential, policyId, amount, gate, nonce, provider, registries } = params;

  const policyReading = await readPolicy(provider, registries.policyRegistry, policyId);
  if (!policyReading.available) {
    // Without the policy there is nothing to pre-flight against. Report it as a skipped check
    // rather than as a pass.
    return {
      allowed: false,
      refusals: [],
      refusal: null,
      skipped: ["the policy itself could not be read"],
      remainingThisEpoch: null,
      epochResetsAt: null,
    };
  }
  const policy = policyReading.value;

  const [issuerKey, issuerActive, revoked, nonceUsed] = await Promise.all([
    readIssuerPublicKey(provider, registries.issuerRegistry, credential.issuerId),
    readIssuerActive(provider, registries.issuerRegistry, credential.issuerId),
    readRevoked(
      provider,
      registries.revocationRegistry,
      credential.issuerId,
      credential.credentialId,
    ),
    readNonceUsed(provider, gate, credential.subjectPublicKey, nonce),
  ]);

  let epochSpend: bigint | undefined;
  if (policy.epochLength > 0n) {
    const epochIndex = toBigInt(Math.floor(Date.now() / 1000)) / policy.epochLength;
    const spend = await readEpochSpend(
      provider,
      gate,
      credential.subjectPublicKey,
      policyId,
      epochIndex,
    );
    if (spend.available) epochSpend = spend.value;
  }

  return runPreflight({
    policy,
    credential,
    amount,
    ...(issuerKey.available ? { issuerPublicKey: issuerKey.value } : {}),
    ...(issuerActive.available ? { issuerActive: issuerActive.value } : {}),
    ...(revoked.available
      ? { revokedCredentialIds: revoked.value ? [credential.credentialId] : [] }
      : {}),
    ...(nonceUsed.available ? { nonceUsed: nonceUsed.value } : {}),
    ...(epochSpend !== undefined ? { epochSpend } : {}),
  });
}
