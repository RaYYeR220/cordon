/**
 * Reads against the four Cordon contracts.
 *
 * Every function here returns a {@link Reading}: either a value, or an explicit "unavailable" with
 * the node's own words attached. Nothing falls back to a zero balance, an empty policy or an
 * assumed-good revocation status, because each of those would turn a failed read into a false
 * reassurance — and this is a package whose entire job is telling a user what will happen before
 * they pay for it.
 *
 * The one read with a sharp edge is `get_policy`, which *panics* with `CORDON_NO_POLICY` rather
 * than returning an empty struct. {@link readPolicy} keeps that distinction: a policy that was
 * never published is not the same as a node that would not answer.
 */

import { hash, num } from "starknet";
import {
  policyFromCalldata,
  settlementFromCalldata,
  toFelt,
  type Address,
  type Felt,
  type FeltLike,
  type Policy,
  type Settlement,
} from "@cordon/sdk";

import type { CordonRegistries } from "./config.js";
import { available, unavailable, type ReadProvider } from "./balances.js";
import { localError } from "./errors.js";
import type { Reading, Strk20NormalizedError } from "./types.js";

export type { ReadProvider } from "./balances.js";

async function call(
  provider: ReadProvider,
  contractAddress: Address,
  entrypoint: string,
  calldata: FeltLike[] = [],
): Promise<Reading<string[]>> {
  try {
    const result = await provider.callContract({
      contractAddress,
      entrypoint,
      calldata: calldata.map((item) => toFelt(item)),
    });
    return available([...result]);
  } catch (error) {
    return unavailable(error);
  }
}

/**
 * Assert a fixed-width result.
 *
 * Only used where the width is a property of *this* module's read rather than of a contract
 * struct. Struct widths are the SDK's business: `Policy` grew a field the day a token allowlist
 * was added, and a length check duplicated here would have rejected a policy the SDK could read
 * perfectly well.
 */
function expect(reading: Reading<string[]>, count: number, what: string): Reading<string[]> {
  if (!reading.available) return reading;
  if (reading.value.length !== count) {
    return unavailable(
      localError(`${what} returned ${reading.value.length} felts, expected ${count}`),
    );
  }
  return reading;
}

function felt(reading: Reading<string[]>, index = 0): Reading<Felt> {
  if (!reading.available) return reading;
  const raw = reading.value[index];
  if (raw === undefined) return unavailable(localError("the call returned an empty result"));
  return available(toFelt(raw));
}

function bool(reading: Reading<string[]>): Reading<boolean> {
  const value = felt(reading);
  return value.available ? available(num.toBigInt(value.value) !== 0n) : value;
}

function big(reading: Reading<string[]>): Reading<bigint> {
  const value = felt(reading);
  return value.available ? available(num.toBigInt(value.value)) : value;
}

/**
 * A policy read, which has three outcomes rather than two.
 *
 * `missing` is not a failure: it means the registry answered clearly that nothing is published
 * under this id. A UI should say "no such policy", not "could not reach the node".
 */
export type PolicyReading =
  | { available: true; value: Policy }
  | { available: false; missing: boolean; error: Strk20NormalizedError };

/**
 * Read a published policy.
 *
 * `get_policy` panics with `CORDON_NO_POLICY` for an id that was never published, so a revert
 * carrying that code is reported as `missing` and anything else as a plain unavailable.
 */
export async function readPolicy(
  provider: ReadProvider,
  policyRegistry: Address,
  policyId: FeltLike,
): Promise<PolicyReading> {
  const raw = await call(provider, policyRegistry, "get_policy", [policyId]);
  if (!raw.available) {
    const missing =
      raw.error.panicCodes.includes("CORDON_NO_POLICY") ||
      raw.error.message.includes("CORDON_NO_POLICY");
    return { available: false, missing, error: raw.error };
  }
  try {
    return { available: true, value: policyFromCalldata(raw.value) };
  } catch (error) {
    return { available: false, missing: false, error: localError((error as Error).message) };
  }
}

/** Whether anything has ever been published under this id, retired or not. */
export async function readPolicyExists(
  provider: ReadProvider,
  policyRegistry: Address,
  policyId: FeltLike,
): Promise<Reading<boolean>> {
  return bool(await call(provider, policyRegistry, "policy_exists", [policyId]));
}

/** The issuer's attesting public key. Zero means unknown or deactivated — never "fine". */
export async function readIssuerPublicKey(
  provider: ReadProvider,
  issuerRegistry: Address,
  issuerId: FeltLike,
): Promise<Reading<Felt>> {
  return felt(await call(provider, issuerRegistry, "issuer_public_key", [issuerId]));
}

/** Whether the issuer is registered and still allowed to attest. */
export async function readIssuerActive(
  provider: ReadProvider,
  issuerRegistry: Address,
  issuerId: FeltLike,
): Promise<Reading<boolean>> {
  return bool(await call(provider, issuerRegistry, "is_issuer_active", [issuerId]));
}

/** Whether this issuer has withdrawn this credential id. */
export async function readRevoked(
  provider: ReadProvider,
  revocationRegistry: Address,
  issuerId: FeltLike,
  credentialId: FeltLike,
): Promise<Reading<boolean>> {
  return bool(await call(provider, revocationRegistry, "is_revoked", [issuerId, credentialId]));
}

/** The three registry addresses the gate itself trusts. */
export async function readRegistries(
  provider: ReadProvider,
  gate: Address,
): Promise<Reading<CordonRegistries>> {
  const raw = expect(await call(provider, gate, "registries"), 3, "registries");
  if (!raw.available) return raw;
  const [issuer, revocation, policy] = raw.value as [string, string, string];
  try {
    return available({
      issuerRegistry: toFelt(issuer),
      revocationRegistry: toFelt(revocation),
      policyRegistry: toFelt(policy),
    });
  } catch (error) {
    // A node that answers with something that is not a field element leaves the registries
    // unknown. Throwing here would take the render tree down with it.
    return unavailable(localError(`the gate returned unreadable registry addresses: ${(error as Error).message}`));
  }
}

/** The epoch index a settlement would be booked into right now. Zero without a velocity limit. */
export async function readCurrentEpoch(
  provider: ReadProvider,
  gate: Address,
  policyId: FeltLike,
): Promise<Reading<bigint>> {
  return big(await call(provider, gate, "current_epoch", [policyId]));
}

/** Value already booked against a subject inside one epoch of one policy. */
export async function readEpochSpend(
  provider: ReadProvider,
  gate: Address,
  subjectPublicKey: FeltLike,
  policyId: FeltLike,
  epochIndex: FeltLike,
): Promise<Reading<bigint>> {
  return big(
    await call(provider, gate, "epoch_spend", [subjectPublicKey, policyId, epochIndex]),
  );
}

/** Whether this `(subject_public_key, nonce)` pair has already settled, on any leg. */
export async function readNonceUsed(
  provider: ReadProvider,
  gate: Address,
  subjectPublicKey: FeltLike,
  nonce: FeltLike,
): Promise<Reading<boolean>> {
  return bool(await call(provider, gate, "is_nonce_used", [subjectPublicKey, nonce]));
}

/** The settlement booked under an id. Reads back with status `None` when there is none. */
export async function readSettlement(
  provider: ReadProvider,
  gate: Address,
  settlementId: FeltLike,
): Promise<Reading<Settlement>> {
  const raw = await call(provider, gate, "get_settlement", [settlementId]);
  if (!raw.available) return raw;
  try {
    return available(settlementFromCalldata(raw.value));
  } catch (error) {
    return unavailable(localError((error as Error).message));
  }
}

/** Value the gate owes to settlements that are still open, in one token. */
export async function readCommittedBalance(
  provider: ReadProvider,
  gate: Address,
  token: Address,
): Promise<Reading<bigint>> {
  return big(await call(provider, gate, "committed_balance", [token]));
}

/** The entrypoint selector for a contract function, for callers assembling their own reads. */
export function selector(name: string): string {
  return hash.getSelectorFromName(name);
}
