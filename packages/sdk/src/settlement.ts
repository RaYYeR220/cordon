/**
 * Two-step settlement: what the gate is holding, and what can still be done with it.
 *
 * A payer cannot vouch for a payee. The gate never sees who the `transfer(OPEN)` credits, and a
 * note id comes from a channel key it cannot recompute, so no single transaction can bind a payee
 * credential to the address that actually receives the money. `Fund` → `Claim` is the sound answer:
 * the payer clears their policy and parks the value for a **named** payee, and that payee
 * authenticates themselves, with their own key, in their own transaction, at the moment they take
 * it. `Refund` closes the loop once the window shuts.
 *
 * This module models the record the gate keeps between those legs, so an app can read a settlement
 * and say what is possible right now instead of finding out by reverting.
 */

import { toBigInt, toFelt, type Felt, type FeltLike } from "./felt.js";
import { randomFelt } from "./random.js";
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
  /**
   * The pseudonym the payer named as the payee, and the only one that can claim it.
   *
   * Without this a settlement would have no payee at all — only a *policy* — and any holder of a
   * credential that policy accepts could take somebody else's money.
   */
  payeeSubjectKey: Felt;
  /** The policy the payer satisfied when funding. Bound into the refund signature. */
  payerPolicyId: Felt;
  /** The policy the named payee has to satisfy to take the value. */
  payeeClaimPolicyId: Felt;
  /** Unix seconds. A claim must land before this; a refund cannot land before it. */
  expiresAt: number;
  status: SettlementStatus;
}

/** Thrown when a settlement record or a settlement id is malformed. */
export class SettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementError";
  }
}

/**
 * A fresh settlement id: 128 bits from the platform CSPRNG.
 *
 * **Settlement ids must be unguessable, and this is the only supported way to make one.** Funding
 * is permissionless and an id is single-use forever, so a predictable id — an invoice number, an
 * order reference, a counter — can be burned ahead of you by a stranger for the price of one unit,
 * after which your own funding transaction reverts with `CORDON_SETTLEMENT_EXISTS`. It is also the
 * only handle that appears in the event log, so a guessable one is a correlation key that ties a
 * funding to a claim to a business record.
 */
export function randomSettlementId(): Felt {
  return randomFelt(16);
}

/**
 * Refuse a settlement id that looks guessable.
 *
 * Anything below 2^64 is a counter, a timestamp or a small integer; anything that decodes as
 * printable ASCII is a human-chosen handle. Both are squattable. This is deliberately a hard
 * failure rather than a warning: the failure mode it prevents costs the payer their money and
 * shows up as an unexplained revert much later.
 */
export function assertUnguessableSettlementId(settlementId: FeltLike): Felt {
  const felt = toFelt(settlementId);
  const value = toBigInt(felt);

  if (value === 0n) {
    throw new SettlementError("settlement id zero is reserved; the gate refuses it outright");
  }
  if (value < 1n << 64n) {
    throw new SettlementError(
      `settlement id ${felt} has under 64 bits of entropy, so a stranger can burn it ahead of ` +
        "you and strand the payment. Use randomSettlementId().",
    );
  }
  if (isPrintableAscii(value)) {
    throw new SettlementError(
      `settlement id ${felt} decodes as text, so it is a chosen handle rather than a random id ` +
        "— guessable, and a correlation key in the event log. Use randomSettlementId().",
    );
  }
  return felt;
}

function isPrintableAscii(value: bigint): boolean {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  if (hex.length > 62) return false;
  for (let index = 0; index < hex.length; index += 2) {
    const code = Number.parseInt(hex.slice(index, index + 2), 16);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/** Read a status back from its variant index. */
export function settlementStatusFromFelt(value: FeltLike): SettlementStatus {
  const index = Number(toBigInt(value));
  const status = STATUS_BY_INDEX[index];
  if (status === undefined) throw new SettlementError(`unknown settlement status ${index}`);
  return status;
}

/** Read a settlement back out of the eight felts `get_settlement` returned. */
export function settlementFromCalldata(calldata: readonly FeltLike[]): Settlement {
  if (calldata.length !== 8) {
    throw new SettlementError(`a settlement is 8 felts, got ${calldata.length}`);
  }
  const at = (index: number): FeltLike => calldata[index] as FeltLike;
  return {
    token: toFelt(at(0)),
    amount: toBigInt(at(1)),
    payerSubjectKey: toFelt(at(2)),
    payeeSubjectKey: toFelt(at(3)),
    payerPolicyId: toFelt(at(4)),
    payeeClaimPolicyId: toFelt(at(5)),
    expiresAt: Number(toBigInt(at(6))),
    status: settlementStatusFromFelt(at(7)),
  };
}

/** The settlement as the eight felts Cairo's positional `Serde` expects. */
export function settlementCalldata(settlement: Settlement): Felt[] {
  return [
    settlement.token,
    toFelt(settlement.amount),
    settlement.payerSubjectKey,
    settlement.payeeSubjectKey,
    settlement.payerPolicyId,
    settlement.payeeClaimPolicyId,
    toFelt(settlement.expiresAt),
    toFelt(SETTLEMENT_STATUS_VARIANT[settlement.status]),
  ];
}

/** What each party can do with a settlement at a given moment. */
export interface SettlementOptions {
  /** True when the named payee could claim right now. */
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
 * Only the settlement's own state is judged here — its status, its window, and, when a claimant is
 * named, whether they are the payee. The claimant's credential and limits are a separate question,
 * answered by `preflight` against the settlement's `payeeClaimPolicyId`.
 */
export function settlementOptions(
  settlement: Settlement,
  options: { now?: number; claimantSubjectKey?: FeltLike } = {},
): SettlementOptions {
  const now = options.now ?? Math.floor(Date.now() / 1000);
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
  const wrongPayee =
    options.claimantSubjectKey !== undefined &&
    toBigInt(options.claimantSubjectKey) !== toBigInt(settlement.payeeSubjectKey)
      ? refusal("CORDON_NOT_THE_PAYEE")
      : null;

  const claimRefusal =
    statusRefusal ?? wrongPayee ?? (open ? null : refusal("CORDON_CLAIM_EXPIRED"));
  const refundRefusal = statusRefusal ?? (open ? refusal("CORDON_REFUND_TOO_EARLY") : null);

  return {
    claimable: claimRefusal === null,
    claimRefusal,
    refundable: refundRefusal === null,
    refundRefusal,
    secondsUntilExpiry: settlement.expiresAt - now,
  };
}
