/**
 * The three facts every authorisation is bound to, read from the chain rather than from a config
 * file.
 *
 * `chain_id`, `gate_address` and `pool_address` are all inside the signed message, and all three
 * have to match what the transaction actually executes against. Two of them are easy to get wrong
 * from configuration:
 *
 * - **`chainId`** must be the chain the transaction will run on. A default of `SN_MAIN` in a config
 *   that is really pointing at Sepolia produces signatures that verify nowhere.
 * - **`poolAddress`** must equal `PolicyGate::privacy_pool()`, the address fixed in the gate's
 *   constructor. The gate checks the calldata against its stored pool *and* the caller against it,
 *   so a config that names a different pool is refused twice over — after the user has paid for the
 *   transaction.
 *
 * So the supported way to build a context is {@link fetchGateContext}, which asks the gate. A
 * context assembled by hand is available for tests, and {@link assertGateContext} exists to check
 * one against the chain before it is trusted.
 */

import { feltEquals, toAddress, toFelt, type Address, type Felt } from "./felt.js";

/** What an authorisation is bound to. */
export interface GateContext {
  /** The chain the transaction will execute on, e.g. `SN_MAIN`. */
  chainId: Felt;
  /** The `PolicyGate` deployment being called. Not the pool, not a registry. */
  gate: Address;
  /** The privacy pool the gate was constructed against. */
  pool: Address;
}

/** Thrown when a context cannot be built, or disagrees with the chain. */
export class GateContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateContextError";
  }
}

/**
 * The slice of a Starknet provider this SDK needs.
 *
 * Structural rather than a concrete import, so the package stays free of a dependency on any one
 * provider implementation. `starknet`'s `RpcProvider` satisfies it as-is.
 */
export interface GateReader {
  /** The chain id, as a felt or short string. */
  getChainId(): Promise<string>;
  /** A read-only contract call. */
  callContract(call: {
    contractAddress: string;
    entrypoint: string;
    calldata?: string[];
  }): Promise<string[] | { result: string[] }>;
}

/**
 * Build a context from values you already have.
 *
 * Prefer {@link fetchGateContext}. This exists for tests and for callers who have already read the
 * pool from the chain themselves.
 */
export function createGateContext(input: {
  chainId: string;
  gate: Address;
  pool: Address;
}): GateContext {
  return {
    chainId: toFelt(input.chainId),
    gate: toAddress(input.gate, "gate"),
    pool: toAddress(input.pool, "pool"),
  };
}

/**
 * Read the context from the chain: the provider's chain id, and the gate's own `privacy_pool()`.
 *
 * Pass `expectedPool` to cross-check what you have configured against what the gate actually says.
 * A mismatch throws here, loudly and before anything is signed, rather than becoming a
 * `CORDON_BAD_POOL` revert the user pays for.
 */
export async function fetchGateContext(
  reader: GateReader,
  gate: Address,
  options: { expectedPool?: Address } = {},
): Promise<GateContext> {
  const gateAddress = toAddress(gate, "gate");

  const chainId = await reader.getChainId();
  if (typeof chainId !== "string" || chainId.trim() === "") {
    throw new GateContextError(`the provider returned no chain id (got ${JSON.stringify(chainId)})`);
  }

  let raw: string[] | { result: string[] };
  try {
    raw = await reader.callContract({
      contractAddress: gateAddress,
      entrypoint: "privacy_pool",
      calldata: [],
    });
  } catch (cause) {
    throw new GateContextError(
      `could not read privacy_pool() from the gate at ${gateAddress}: ` +
        `${cause instanceof Error ? cause.message : String(cause)}. ` +
        "Check the address is a deployed PolicyGate on this chain.",
    );
  }

  const result = Array.isArray(raw) ? raw : raw.result;
  const pool = result?.[0];
  if (typeof pool !== "string") {
    throw new GateContextError(
      `privacy_pool() at ${gateAddress} returned nothing; that address is not a PolicyGate`,
    );
  }
  if (feltEquals(pool, 0)) {
    throw new GateContextError(
      `privacy_pool() at ${gateAddress} answered zero, which no deployed gate does`,
    );
  }

  if (options.expectedPool !== undefined && !feltEquals(pool, options.expectedPool)) {
    throw new GateContextError(
      `the gate at ${gateAddress} serves pool ${toAddress(pool, "pool")}, but this application is ` +
        `configured for ${toAddress(options.expectedPool, "expectedPool")}. Every authorisation ` +
        "signed against the configured value would be refused with CORDON_BAD_POOL. Fix the " +
        "configuration rather than signing.",
    );
  }

  return createGateContext({ chainId, gate: gateAddress, pool });
}

/**
 * Check a context you already hold against the chain.
 *
 * Use it at startup, or whenever a wallet reports a network change: a context built for one chain
 * silently produces unverifiable signatures on another.
 */
export async function assertGateContext(
  reader: GateReader,
  context: GateContext,
): Promise<GateContext> {
  const live = await fetchGateContext(reader, context.gate, { expectedPool: context.pool });
  if (!feltEquals(live.chainId, context.chainId)) {
    throw new GateContextError(
      `this context is bound to chain ${context.chainId} but the provider is on ${live.chainId}. ` +
        "Signatures made against the wrong chain id are refused with CORDON_BAD_SUBJECT_SIG.",
    );
  }
  return live;
}
