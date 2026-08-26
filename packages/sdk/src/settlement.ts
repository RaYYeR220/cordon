/**
 * Two-step settlement: what the gate is holding, and what can still be done with it.
 *
 * A payer cannot vouch for a payee. The gate never sees who the `transfer(OPEN)` credits, and a
 * note id comes from a channel key it cannot recompute, so no single transaction can bind a payee
 * credential to the address that actually receives the money. `Fund` → `Claim` is the sound answer:
 * the payer clears their policy and parks the value, and the payee authenticates themselves, with
 * their own key, in their own transaction, at the moment they take it. `Refund` closes the loop
 * once the window shuts.
 *
 * This module models the record the gate keeps between those legs, so an app can read a settlement
 * and say what is possible right now instead of finding out by reverting.
 */

import { toBigInt, toFelt, type Felt, type FeltLike } from "./felt.js";
import { refusalForCode, type Refusal } from "./refusals.js";

/**
 * Where a settlement stands.
 *
 * Four states, not a boolean: a second claim, a refund after a claim, and a claim against an id
 * nobody funded are three different mistakes, and each gets its own refusal.
 */
export type SettlementStatus = "None" | "Funded" | "Claimed" | "Refunded";

/**
 * Variant indices, in the order the Cairo enum declares them. A stored settlement is read back by
 * index, so this order is the storage format.
 */
export const SETTLEMENT_STATUS_VARIANT = {
  None: 0,
  Funded: 1,
  Claimed: 2,
  Refunded: 3,
} as const;

const STATUS_BY_INDEX: readonly SettlementStatus[] = ["None", "Funded", "Claimed", "Refunded"];

/** Value the gate is holding between a `Fund` and its `Claim` or `Refund`. */
export interface Settlement {
  /** The ERC20 held. Both later legs must name the same one. */
  token: Felt;
  /** The exact amount held, read from the record rather than from a balance. */
  amount: bigint;
  /** The pseudonym that funded it, and the only one that can refund it. */
  payerSubjectKey: Felt;
  /** The policy the payer satisfied when funding. Bound into the refund signature. */
  payerPolicyId: Felt;
  /** The policy a claimant has to satisfy to take the value. */
  payeeClaimPolicyId: Felt;
  /** Unix seconds. A claim must land before this; a refund cannot land before it. */
  expiresAt: number;
  status: SettlementStatus;
}

/** Thrown when a settlement record is malformed. */
export class SettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementError";
  }
}

/** Read a status back from its variant index. */
export function settlementStatusFromFelt(value: FeltLike): SettlementStatus {
  const index = Number(toBigInt(value));
  const status = STATUS_BY_INDEX[index];
  if (status === undefined) throw new SettlementError(`unknown settlement status ${index}`);
  return status;
}

/** Read a settlement back out of the seven felts `get_settlement` returned. */
export function settlementFromCalldata(calldata: readonly FeltLike[]): Settlement {
  if (calldata.length !== 7) {
    throw new SettlementError(`a settlement is 7 felts, got ${calldata.length}`);
  }
  const at = (index: number): FeltLike => calldata[index] as FeltLike;
  return {
    token: toFelt(at(0)),
    amount: toBigInt(at(1)),
    payerSubjectKey: toFelt(at(2)),
    payerPolicyId: toFelt(at(3)),
    payeeClaimPolicyId: toFelt(at(4)),
    expiresAt: Number(toBigInt(at(5))),
    status: settlementStatusFromFelt(at(6)),
  };
}

/** The settlement as the seven felts Cairo's positional `Serde` expects. */
export function settlementCalldata(settlement: Settlement): Felt[] {
  return [
    settlement.token,
    toFelt(settlement.amount),
    settlement.payerSubjectKey,
    settlement.payerPolicyId,
    settlement.payeeClaimPolicyId,
    toFelt(settlement.expiresAt),
    toFelt(SETTLEMENT_STATUS_VARIANT[settlement.status]),
  ];
}

/** What each party can do with a settlement at a given moment. */
export interface SettlementOptions {
  /** True when a payee could claim right now. */
  claimable: boolean;
  /** The refusal a claim would hit, or `null` when it would go through. */
  claimRefusal: Refusal | null;
  /** True when the payer could refund right now. */
  refundable: boolean;
  /** The refusal a refund would hit, or `null` when it would go through. */
  refundRefusal: Refusal | null;
  /** Seconds until the claim window closes and the refund window opens. Negative once past. */
  secondsUntilExpiry: number;
}

/**
 * What the gate would allow against this settlement right now.
 *
 * Only the settlement's own state is judged here — its status, its token and its window. The
 * claimant's credential and limits are a separate question, answered by `preflight` against the
 * settlement's `payeeClaimPolicyId`.
 */
export function settlementOptions(
  settlement: Settlement,
  now = Math.floor(Date.now() / 1000),
): SettlementOptions {
  const refusal = (code: string): Refusal | null => refusalForCode(code) ?? null;

  const statusRefusal =
    settlement.status === "None"
      ? refusal("CORDON_NO_SETTLEMENT")
      : settlement.status === "Claimed"
        ? refusal("CORDON_ALREADY_CLAIMED")
        : settlement.status === "Refunded"
          ? refusal("CORDON_ALREADY_REFUNDED")
          : null;

  const open = settlement.expiresAt > now;
  const claimRefusal = statusRefusal ?? (open ? null : refusal("CORDON_CLAIM_EXPIRED"));
  const refundRefusal = statusRefusal ?? (open ? refusal("CORDON_REFUND_TOO_EARLY") : null);

  return {
    claimable: claimRefusal === null,
    claimRefusal,
    refundable: refundRefusal === null,
    refundRefusal,
    secondsUntilExpiry: settlement.expiresAt - now,
  };
}
