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
 * **Every authorisation names the note it may land in, and the wallet is asked for it.** The
 * subject signs a binding to one resolved open note, which is what makes a leaked authorisation
 * worthless — and authorisations do leak, because Starknet publishes reverted transactions with
 * their full calldata and a revert does not burn the nonce. So a claim that fails for an ordinary
 * reason would otherwise broadcast a live, redirectable authorisation to the whole chain.
 *
 * The note id is not knowable in advance, so the SDK's `prepare*` flow asks the wallet: prepare
 * once to learn the id, sign bound to it, prepare again, and verify the id did not move. This hook
 * drives that, which means the two failure modes get their own states rather than being flattened
 * into "something went wrong":
 *
 * - `prepare-failed` — the wallet cannot resolve calldata at prepare time, so a bound
 *   authorisation is impossible with it. A dead end, and the honest answer is a different wallet.
 * - `note-drift` — another transaction landed on the same channel between the two prepares, so the
 *   note moved. **This is the system working.** It failed closed instead of paying the wrong
 *   party, and the fix is simply to try again.
 *
 * Neither ever falls back to an unbound authorisation. The SDK has exactly one way to sign one,
 * `acceptAnyNoteAndAllowRedirection`, and no option, prop or default in this package reaches it.
 * A failed prepare is a condition to report, not a reason to weaken what the subject signs.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import {
  NoteDriftError,
  NotePreparationError,
  decodeRefusal,
  decodeRefusalFromError,
  describeBinding,
  prepareClaim,
  prepareDirect,
  prepareFund,
  prepareRefund,
  preflight as runPreflight,
  toBigInt,
  toFelt,
  type Credential,
  type Felt,
  type FeltLike,
  type GateAuthorization,
  type Preflight,
  type PreparedGateTransaction,
  type Refusal,
  type Settlement,
  type Strk20Action,
  type Strk20Prepare,
} from "@cordon/sdk";

import { useCordonContext } from "../context/CordonProvider.js";
import {
  localError,
  readEpochSpend,
  readIssuerActive,
  readIssuerPublicKey,
  readPolicy,
  readRevoked,
  readSettlement,
  submitPreparedCall,
  supportsPreparedInvoke,
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
  /** Reading chain state and running the pre-flight. Nothing signed yet. */
  | "building"
  /**
   * The prepare-twice flow. The wallet is resolving the note id and proving the transaction, which
   * is the slowest part of a STRK20 payment and can take minutes.
   */
  | "preparing"
  /** Handed to the wallet to submit, which is asking the user to approve. */
  | "awaiting-signature"
  /** The wallet returned a hash. On chain, not yet final. */
  | "submitted"
  /** Executed successfully. The value moved. */
  | "confirmed"
  /** A rule refused it. The transaction reverted and nothing moved. */
  | "refused"
  /**
   * The open note moved between the two prepares, so the signed binding no longer matches.
   *
   * Not a failure — the system failing *closed*. Submitting anyway would have reverted with
   * `CORDON_NOTE_MISMATCH`, or, without a binding, paid the wrong party. Call `pay()` again to
   * sign for the new note.
   */
  | "note-drift"
  /**
   * The wallet cannot resolve calldata at prepare time, so a bound authorisation is impossible.
   * A dead end rather than a retry: the answer is a wallet that implements `strk20PrepareInvoke`.
   */
  | "prepare-failed"
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
    | "NO_PREPARE_SUPPORT"
    | "NO_SETTLEMENT_ID"
    | "NO_EXPIRY"
    | "NO_GATE_CONTEXT"
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
   * Optional deadline on the authorisation, in unix seconds.
   *
   * A bound authorisation does not need one — it can only ever fill the note it names — so this is
   * belt and braces for a caller who wants the signature to lapse as well.
   */
  validUntil?: number;
  /**
   * Names the escrow. Required for `claim` and `refund`.
   *
   * Optional on `fund`, and best left alone: the SDK generates a random one, which matters because
   * a settlement id is single-use forever and is the only handle in the event log. A predictable
   * one can be burned ahead of you by a stranger, and ties the funding to the claim to whatever
   * business record it came from. An invoice number is refused outright.
   */
  settlementId?: FeltLike | null;
  /** The pseudonym allowed to claim the escrow. Required for `fund`. */
  payeeSubjectKey?: FeltLike | null;
  /** The policy that payee will have to satisfy. Required for `fund`. */
  payeeClaimPolicyId?: FeltLike | null;
  /** Unix seconds after which only a refund is possible. Required for `fund`. */
  expiresAt?: FeltLike | null;
  /** Override the nonce. A fresh random one is used per attempt otherwise. */
  nonce?: FeltLike | null;
  /** The ERC20 to settle. Defaults to the provider's configured token. */
  token?: string;
  /** Called once a refusal is known, whether predicted or on chain. */
  onRefused?: (refusal: Refusal, transactionHash: string | null) => void;
  /**
   * Called once the transaction executed.
   *
   * The authorisation comes with it because some of what a caller needs is only in there and only
   * for one leg: a `Fund` generates its settlement id inside the SDK, and that id is the payee's
   * only handle on the escrow. Reading it back off the hook's state afterwards races the next
   * payment, which would silently lose it.
   */
  onConfirmed?: (result: Strk20SubmitResult, authorization: GateAuthorization) => void;
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
  /** The signed authorisation, once there is one. Carries the binding, the amount and the hashes. */
  authorization: GateAuthorization | null;
  /**
   * What the authorisation committed to about its destination, in one sentence.
   *
   * Straight from the SDK's `describeBinding`, so a confirmation screen says the same thing the
   * signed message does — including, for an unbound authorisation, that it can be redirected.
   */
  bindingDescription: string | null;
  /** The open note this payment is bound to. Zero on a `fund`, which fills none. */
  noteId: Felt | null;
  /**
   * Set when the note moved between prepares. Carries both ids so a UI can explain the retry
   * rather than showing a dead end.
   */
  drift: { signedNoteId: Felt; preparedNoteId: Felt } | null;
  /** Everything missing before this can be attempted. Empty means ready. */
  blockers: PaymentBlocker[];
  ready: boolean;
  pay: (options?: PayOptions) => Promise<void>;
  reset: () => void;
}

export function useGatedPayment(options: UseGatedPaymentOptions = {}): UseGatedPayment {
  const { config, provider, connection, capability, registries, gateContext, recordRefusal } =
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
  const [authorization, setAuthorization] = useState<GateAuthorization | null>(null);
  const [noteId, setNoteId] = useState<Felt | null>(null);
  const [drift, setDrift] = useState<{ signedNoteId: Felt; preparedNoteId: Felt } | null>(null);

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
    if (gateContext && !gateContext.available) {
      add("NO_GATE_CONTEXT", gateContext.error.message);
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
    if ((leg === "claim" || leg === "refund") && !options.settlementId) {
      add("NO_SETTLEMENT_ID", "Name the settlement.");
    }
    if (leg === "fund") {
      // The settlement id is deliberately not required: the SDK generates a random one, and a
      // guessable id is a real hazard rather than a convenience.
      if (!options.payeeSubjectKey) {
        add(
          "NO_PAYEE",
          "Name the payee's pseudonym. A settlement with no named payee could be claimed by " +
            "anyone holding a credential the claim policy accepts.",
        );
      }
      if (!options.payeeClaimPolicyId) {
        add("NO_POLICY_ID", "Choose the policy the payee will have to satisfy to claim.");
      }
      if (!options.expiresAt) {
        add("NO_EXPIRY", "Set when the claim window closes and the refund window opens.");
      }
    }
    // Every leg is prepared before it is submitted, including a fund, which is prepared once.
    if (connection && !supportsPreparedInvoke(connection.account)) {
      add(
        "NO_PREPARE_SUPPORT",
        "This wallet does not implement strk20PrepareInvoke, so the note a payment is allowed to " +
          "land in cannot be known before signing. Cordon will not sign an authorisation that " +
          "any note can satisfy, because a reverted transaction publishes its calldata and " +
          "anyone could redirect it. Use a wallet that supports prepared invokes.",
      );
    }
    return found;
  }, [connection, capability, registries, gateContext, leg, options]);

  const reset = useCallback((): void => {
    setStatus("idle");
    setRefusal(null);
    setPredicted(false);
    setPreflightResult(null);
    setError(null);
    setTransactionHash(null);
    setResult(null);
    setActions(null);
    setAuthorization(null);
    setNoteId(null);
    setDrift(null);
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
        // Every signature is bound to the chain id, the gate and the pool the gate was built
        // against. All three are read from the chain rather than taken from configuration, so a
        // mismatch stops here instead of becoming a revert the user paid for.
        if (!gateContext) {
          fail(localError("The gate's context is still being read. Try again in a moment."));
          return;
        }
        if (!gateContext.available) {
          fail(gateContext.error);
          return;
        }
        const context = gateContext.value;

        const gate = config.gateAddress;
        const registryAddresses = registries?.available ? registries.value : null;
        const nonce = current.nonce ?? undefined;
        const subjectKey = current.subjectPrivateKey as FeltLike;

        // On the later legs the amount and the policy come from the stored settlement, which is
        // where the gate takes them from too. Nothing the caller passes can override them.
        let settlement: Settlement | null = null;
        if (currentLeg === "claim" || currentLeg === "refund") {
          const reading = await readSettlement(provider, gate, current.settlementId as FeltLike);
          if (!reading.available) {
            fail(reading.error);
            return;
          }
          settlement = reading.value;
        }

        const amount = settlement ? settlement.amount : (current.amount ?? 0n);
        const policyId = settlement
          ? currentLeg === "claim"
            ? settlement.payeeClaimPolicyId
            : settlement.payerPolicyId
          : toFelt(current.policyId ?? 0);

        // Pre-flight. Every check that cannot be run is reported as skipped rather than assumed to
        // pass, so a green light here means "nothing we could check would refuse this", never
        // "this will definitely settle".
        if (current.credential && registryAddresses) {
          const flight = await buildPreflight({
            credential: current.credential,
            policyId,
            amount,
            token: currentToken,
            gate,
            provider,
            registries: registryAddresses,
          });
          setPreflightResult(flight);
          if (flight.refusal && !payOptions.force) {
            refuse(flight.refusal, null, true, policyId);
            return;
          }
        }

        // Sign and prepare. The SDK runs both prepares: probe the wallet for the note id this
        // transaction will fill, sign an authorisation bound to exactly that note, prepare again,
        // and verify the id did not move. What comes back is a resolved call and its proof.
        //
        // The key is the subject's own STARK-curve key, never the wallet's: the pseudonym is what
        // velocity and replay protection are keyed by, and binding it to an address would undo the
        // privacy the pool provides.
        //
        // The builders read the amount and the terms back off the authorisation, so what was
        // signed and what is sent are the same values by construction. There is nowhere for a
        // second, different number to come from.
        if (!supportsPreparedInvoke(connection.account)) {
          setStatus("prepare-failed");
          setError(
            localError(
              "This wallet does not implement strk20PrepareInvoke, so the note this payment may " +
                "land in cannot be known before signing. Cordon does not sign an authorisation " +
                "that any note can satisfy.",
            ),
          );
          return;
        }
        const account = connection.account;
        const prepare: Strk20Prepare = (toPrepare) =>
          account.strk20PrepareInvoke(toPrepare) as ReturnType<Strk20Prepare>;
        const validUntil = current.validUntil;

        setStatus("preparing");
        let prepared: PreparedGateTransaction<GateAuthorization>;
        if (currentLeg === "direct") {
          prepared = await prepareDirect(
            {
              prepare,
              context,
              token: currentToken,
              policyId,
              credential: current.credential as Credential,
              amount,
              payee: current.payee as string,
              ...(nonce !== undefined ? { nonce } : {}),
              ...(validUntil !== undefined ? { validUntil } : {}),
            },
            subjectKey,
          );
        } else if (currentLeg === "fund") {
          prepared = await prepareFund(
            {
              prepare,
              context,
              token: currentToken,
              policyId,
              credential: current.credential as Credential,
              amount,
              payeeSubjectKey: current.payeeSubjectKey as FeltLike,
              payeeClaimPolicyId: current.payeeClaimPolicyId as FeltLike,
              expiresAt: current.expiresAt as FeltLike,
              ...(current.settlementId ? { settlementId: current.settlementId } : {}),
              ...(nonce !== undefined ? { nonce } : {}),
              ...(validUntil !== undefined ? { validUntil } : {}),
            },
            subjectKey,
          );
        } else if (currentLeg === "claim") {
          prepared = await prepareClaim(
            {
              prepare,
              context,
              settlement: settlement as Settlement,
              settlementId: current.settlementId as FeltLike,
              credential: current.credential as Credential,
              recipient: current.recipient as string,
              ...(nonce !== undefined ? { nonce } : {}),
              ...(validUntil !== undefined ? { validUntil } : {}),
            },
            subjectKey,
          );
        } else {
          prepared = await prepareRefund(
            {
              prepare,
              context,
              settlement: settlement as Settlement,
              settlementId: current.settlementId as FeltLike,
              recipient: current.recipient as string,
              ...(nonce !== undefined ? { nonce } : {}),
              ...(validUntil !== undefined ? { validUntil } : {}),
            },
            subjectKey,
          );
        }

        setActions(prepared.actions);
        setAuthorization(prepared.authorization);
        setNoteId(prepared.noteId);

        setStatus("awaiting-signature");
        const outcome = await submitPreparedCall(
          account,
          provider,
          { call: prepared.call, proof: prepared.proof },
          {
            onSubmitted: (hash) => {
              setTransactionHash(hash);
              setStatus("submitted");
            },
          },
        );


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
        current.onConfirmed?.(outcome.result, prepared.authorization);
      } catch (caught) {
        // The two prepare failures are conditions with their own answers, so they get their own
        // states rather than being flattened into "something went wrong".
        if (caught instanceof NoteDriftError) {
          // The note moved between prepares. This is the system failing closed: submitting would
          // have reverted with CORDON_NOTE_MISMATCH, or, unbound, paid the wrong party. Calling
          // pay() again signs for the new note.
          setDrift({ signedNoteId: caught.signedNoteId, preparedNoteId: caught.preparedNoteId });
          setError(localError(caught.message));
          setStatus("note-drift");
          return;
        }
        if (caught instanceof NotePreparationError) {
          // The wallet could not tell us which note this will fill. There is no safe way on from
          // here — signing an unbound authorisation is the one thing this package will not do.
          setError(localError(caught.message));
          setStatus("prepare-failed");
          return;
        }

        // Anything else thrown while assembling — a malformed felt, a rejected prompt — is
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
    [connection, config, provider, registries, gateContext, fail, refuse],
  );

  return {
    status,
    busy:
      status === "building" ||
      status === "preparing" ||
      status === "awaiting-signature" ||
      status === "submitted",
    refusal,
    predicted,
    preflight: preflightResult,
    error,
    transactionHash,
    voyagerUrl: transactionHash ? voyagerTxUrl(transactionHash, config.chainId) : null,
    result,
    actions,
    authorization,
    bindingDescription: authorization ? describeBinding(authorization.binding) : null,
    noteId,
    drift,
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
  token: string;
  gate: string;
  provider: Parameters<typeof readPolicy>[0];
  registries: { issuerRegistry: string; revocationRegistry: string; policyRegistry: string };
}): Promise<Preflight> {
  const { credential, policyId, amount, token, gate, provider, registries } = params;

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

  const [issuerKey, issuerActive, revoked] = await Promise.all([
    readIssuerPublicKey(provider, registries.issuerRegistry, credential.issuerId),
    readIssuerActive(provider, registries.issuerRegistry, credential.issuerId),
    readRevoked(
      provider,
      registries.revocationRegistry,
      credential.issuerId,
      credential.credentialId,
    ),
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

  // Two of the gate's checks are deliberately not pre-flighted.
  //
  // The **nonce**, because each attempt signs a fresh 128-bit random one: `CORDON_NONCE_USED` is
  // unreachable by construction, and reading a nonce that does not exist yet answers nothing.
  //
  // The **unaccounted balance**, because the gate measures it *after* the pool has transferred, and
  // a pre-flight runs before. It reads zero right up until the moment it matters, so feeding it in
  // would predict `CORDON_UNDERFUNDED` for every payment that was going to succeed. The withdraw
  // action funds the gate with exactly the signed amount, so the real check is satisfied by
  // construction. `readUnaccountedBalance` is exported for callers inspecting a gate directly.
  return runPreflight({
    policy,
    credential,
    amount,
    token,
    ...(issuerKey.available ? { issuerPublicKey: issuerKey.value } : {}),
    ...(issuerActive.available ? { issuerActive: issuerActive.value } : {}),
    ...(revoked.available
      ? { revokedCredentialIds: revoked.value ? [credential.credentialId] : [] }
      : {}),
    ...(epochSpend !== undefined ? { epochSpend } : {}),
  });
}
