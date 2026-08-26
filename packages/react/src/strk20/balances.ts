/**
 * Balance reads.
 *
 * Shielded balances come from the wallet, because only it holds the viewing key. Public balances
 * come from a plain ERC-20 call over RPC. Either can fail, and when one does the result says so —
 * {@link Reading} has no third state that quietly means zero.
 */

import { num, uint256, type ProviderInterface } from "starknet";

import { normalizeError } from "./errors.js";
import type { Address, Available, Reading, Strk20Balance, Unavailable } from "./types.js";

export type { Available, Reading, Unavailable } from "./types.js";

export function unavailable(error: unknown): Unavailable {
  return { available: false, error: normalizeError(error) };
}

export function available<T>(value: T): Available<T> {
  return { available: true, value };
}

/**
 * Coerce one entry of a `wallet_strk20Balances` response.
 *
 * The spec field is `balance`, but wallets have shipped `amount` too, so both are accepted. An
 * entry that cannot be read is dropped rather than reported as zero.
 */
export function parseBalanceEntry(entry: unknown): Strk20Balance | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as Record<string, unknown>;
  const token = record["token"] ?? record["token_address"];
  const amount = record["balance"] ?? record["amount"];
  if (typeof token !== "string") return null;
  if (typeof amount !== "string" && typeof amount !== "number" && typeof amount !== "bigint") {
    return null;
  }
  try {
    return { token: num.toHex(token), amount: num.toHex(num.toBigInt(amount)) };
  } catch {
    return null;
  }
}

export function parseBalances(raw: unknown): Strk20Balance[] | null {
  // Some wallet transports wrap the result in `{ value: ... }`.
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null && Array.isArray((raw as { value?: unknown }).value)
      ? (raw as { value: unknown[] }).value
      : null;
  if (!list) return null;
  return list.map(parseBalanceEntry).filter((entry): entry is Strk20Balance => entry !== null);
}

/** Wallet-held shielded balances. An empty token list asks for every token. */
export async function readShieldedBalances(
  account: { strk20Balances: (tokens: string[]) => Promise<unknown> },
  tokens: Address[] = [],
): Promise<Reading<Strk20Balance[]>> {
  try {
    const raw = await account.strk20Balances(tokens);
    const parsed = parseBalances(raw);
    if (!parsed) {
      return unavailable(
        new Error(`wallet_strk20Balances returned a shape we cannot read: ${JSON.stringify(raw)}`),
      );
    }
    return available(parsed);
  } catch (error) {
    return unavailable(error);
  }
}

/** Public ERC-20 balance of an address, read over RPC. */
export async function readPublicBalance(
  provider: ProviderInterface,
  token: Address,
  owner: Address,
): Promise<Reading<bigint>> {
  try {
    const result = await provider.callContract({
      contractAddress: token,
      entrypoint: "balanceOf",
      calldata: [owner],
    });
    const low = result[0];
    if (low === undefined) {
      return unavailable(new Error("balanceOf returned an empty result"));
    }
    // Cairo 1 ERC-20s return a u256 as (low, high); older ones return a single felt.
    const value =
      result[1] === undefined ? num.toBigInt(low) : uint256.uint256ToBN({ low, high: result[1] });
    return available(value);
  } catch (error) {
    return unavailable(error);
  }
}

/** Sum the entries for one token out of a shielded balance list. */
export function balanceOf(balances: readonly Strk20Balance[], token: Address): bigint {
  const target = num.toBigInt(token);
  return balances.reduce((total, entry) => {
    try {
      return num.toBigInt(entry.token) === target ? total + num.toBigInt(entry.amount) : total;
    } catch {
      return total;
    }
  }, 0n);
}
