/**
 * Wallet capability probe.
 *
 * The STRK20 methods are optional: a wallet can speak the wallet API in full and still not
 * implement them. Today only Ready does — Braavos answers `wallet_strk20Balances` with "Not
 * implemented". So this package never assumes; it asks, using the one STRK20 method that is
 * read-only and free.
 *
 * `wallet_strk20Balances` is the right probe because it signs nothing, submits nothing and costs
 * nothing, and its success payload is the shielded balance list the app needs anyway.
 */

import { chainName } from "./config.js";
import { isNotImplemented, isUserRefusal, normalizeError } from "./errors.js";
import { parseBalances } from "./balances.js";
import type { ConnectedWallet } from "./wallet.js";
import type { Strk20Capability } from "./types.js";

export async function probeStrk20Support(
  connection: ConnectedWallet,
): Promise<Strk20Capability> {
  const base = {
    walletName: connection.name,
    chainId: connection.chainId,
    specVersions: connection.specVersions,
    walletApiVersions: connection.walletApiVersions,
  };

  const network = chainName(connection.chainId);
  if (!network) {
    return {
      ...base,
      status: "wrong-chain",
      reason:
        `No STRK20 privacy pool is deployed on chain ${connection.chainId}. ` +
        "Switch the wallet to mainnet before probing.",
      probe: { method: "wallet_strk20Balances", performed: false, durationMs: 0 },
      balances: null,
      error: null,
    };
  }

  const startedAt = Date.now();
  try {
    const raw = await connection.account.strk20Balances([]);
    const durationMs = Date.now() - startedAt;
    const balances = parseBalances(raw);

    if (!balances) {
      const error = normalizeError(
        new Error(
          `${connection.name} answered wallet_strk20Balances with a shape we cannot read: ` +
            JSON.stringify(raw),
        ),
      );
      return {
        ...base,
        status: "error",
        reason:
          `${connection.name} answered the probe, but not with a balance list. ` +
          "Treating STRK20 support as unknown.",
        probe: { method: "wallet_strk20Balances", performed: true, durationMs },
        balances: null,
        error,
      };
    }

    return {
      ...base,
      status: "supported",
      reason:
        `${connection.name} implements the STRK20 wallet methods on ${network} ` +
        `(${balances.length} shielded ${balances.length === 1 ? "balance" : "balances"}).`,
      probe: { method: "wallet_strk20Balances", performed: true, durationMs },
      balances,
      error: null,
    };
  } catch (caught) {
    const durationMs = Date.now() - startedAt;
    const error = normalizeError(caught);
    const probe = { method: "wallet_strk20Balances" as const, performed: true, durationMs };

    if (isNotImplemented(error)) {
      return {
        ...base,
        status: "not-implemented",
        reason:
          `${connection.name} does not implement the STRK20 wallet methods. ` +
          "A gated private payment needs a wallet that does — Ready is the only one shipping " +
          "them today.",
        probe,
        balances: null,
        error,
      };
    }

    if (isUserRefusal(error)) {
      return {
        ...base,
        status: "declined",
        reason:
          `${connection.name} was asked but the request was declined, so STRK20 support is ` +
          "unknown.",
        probe,
        balances: null,
        error,
      };
    }

    return {
      ...base,
      status: "error",
      reason: `The probe failed against ${connection.name}. STRK20 support is unknown.`,
      probe,
      balances: null,
      error,
    };
  }
}

/** Whether a gated private payment can be attempted at all. */
export function canSubmitPrivateActions(capability: Strk20Capability | null): boolean {
  return capability?.status === "supported";
}
