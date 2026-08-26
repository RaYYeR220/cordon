"use client";

/**
 * `useCordonWallet` — connect a wallet, and find out whether it can do this at all.
 *
 * The capability probe is the part that matters. The STRK20 methods are optional: a wallet can
 * speak the whole wallet API and still answer `wallet_strk20Balances` with "Not implemented", which
 * is exactly what Braavos does today. A UI that assumes support and finds out at signing time has
 * already wasted the user's time, so this hook asks up front with the one STRK20 call that is
 * read-only and free, and reports the answer as a state you can render.
 */

import { useCallback, useMemo } from "react";

import { useCordonContext } from "../context/CordonProvider.js";
import {
  balanceOf,
  canSubmitPrivateActions,
  chainName,
  type ConnectedWallet,
  type DiscoveredWallet,
  type Reading,
  type Strk20Balance,
  type Strk20Capability,
  type Strk20NormalizedError,
} from "../strk20/index.js";

/** What the UI needs to know in one word. */
export type CordonWalletStatus =
  /** No wallet-standard wallet has announced itself. Nothing to connect to. */
  | "no-wallet"
  /** Wallets are available and none is connected. */
  | "disconnected"
  /** A connection attempt is in flight. */
  | "connecting"
  /** Connected, and the STRK20 probe has not answered yet. */
  | "probing"
  /** Connected, and the wallet implements the STRK20 methods. Payments can be attempted. */
  | "ready"
  /** Connected, but the wallet cannot do private actions. `capability` says why. */
  | "unsupported"
  /** The connection attempt failed. `error` carries what the wallet said. */
  | "error";

export interface UseCordonWallet {
  status: CordonWalletStatus;
  /** Wallets the registry announced, MetaMask filtered out — its Snap has no STRK20 methods. */
  wallets: DiscoveredWallet[];
  connection: ConnectedWallet | null;
  address: string | null;
  chainId: string | null;
  /** `mainnet`, `sepolia`, or null on a chain with no privacy pool. */
  network: string | null;
  capability: Strk20Capability | null;
  /** True only when the wallet actually implements the STRK20 methods on a chain with a pool. */
  canPay: boolean;
  /** One sentence explaining the current status, safe to render. Null when there is nothing to say. */
  explanation: string | null;
  error: Strk20NormalizedError | null;
  /** Shielded balances, or an explicit unavailable. Null before the first read. */
  balances: Reading<Strk20Balance[]> | null;
  /** The shielded balance of the configured token, or null when it could not be read. */
  tokenBalance: bigint | null;
  connect: (wallet: DiscoveredWallet) => Promise<void>;
  disconnect: () => Promise<void>;
  refreshCapability: () => Promise<void>;
  refreshBalances: () => Promise<void>;
}

export function useCordonWallet(): UseCordonWallet {
  const {
    config,
    wallets,
    connection,
    connecting,
    connectError,
    connect,
    disconnect,
    capability,
    probing,
    refreshCapability,
    balances,
    refreshBalances,
  } = useCordonContext();

  const status = useMemo<CordonWalletStatus>(() => {
    if (connecting) return "connecting";
    if (connectError) return "error";
    if (!connection) return wallets.length === 0 ? "no-wallet" : "disconnected";
    if (probing || !capability) return "probing";
    return capability.status === "supported" ? "ready" : "unsupported";
  }, [connecting, connectError, connection, wallets.length, probing, capability]);

  const explanation = useMemo<string | null>(() => {
    switch (status) {
      case "no-wallet":
        return (
          "No Starknet wallet announced itself to this page. A gated private payment needs a " +
          "wallet that implements the STRK20 methods — Ready is the only one shipping them today."
        );
      case "connecting":
        return "Waiting for the wallet to approve the connection.";
      case "probing":
        return "Asking the wallet whether it implements the STRK20 methods.";
      case "unsupported":
        return capability?.reason ?? null;
      case "error":
        return connectError?.message ?? null;
      default:
        return null;
    }
  }, [status, capability, connectError]);

  const tokenBalance = useMemo<bigint | null>(() => {
    if (!balances?.available) return null;
    return balanceOf(balances.value, config.token);
  }, [balances, config.token]);

  const doConnect = useCallback(
    async (wallet: DiscoveredWallet) => {
      await connect(wallet);
    },
    [connect],
  );

  return {
    status,
    wallets,
    connection,
    address: connection?.address ?? null,
    chainId: connection?.chainId ?? null,
    network: chainName(connection?.chainId ?? null),
    capability,
    canPay: canSubmitPrivateActions(capability),
    explanation,
    error: connectError,
    balances,
    tokenBalance,
    connect: doConnect,
    disconnect,
    refreshCapability,
    refreshBalances,
  };
}
