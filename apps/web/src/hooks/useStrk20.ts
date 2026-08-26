"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RpcProvider } from "starknet";

import {
  connectWallet,
  createWalletStore,
  disconnectWallet,
  loadConfig,
  probeStrk20Support,
  readPublicBalance,
  readShieldedBalances,
  selectableWallets,
  watchWallets,
  type ConnectedWallet,
  type DiscoveredWallet,
  type Reading,
  type Strk20Balance,
  type Strk20Capability,
  type Strk20NormalizedError,
} from "@/lib/strk20";

export type Strk20State = {
  config: ReturnType<typeof loadConfig>;
  provider: RpcProvider;
  /** Wallets the wallet-standard registry has announced so far. */
  wallets: DiscoveredWallet[];
  connection: ConnectedWallet | null;
  connecting: boolean;
  connectError: Strk20NormalizedError | null;
  capability: Strk20Capability | null;
  probing: boolean;
  shielded: Reading<Strk20Balance[]> | null;
  publicBalance: Reading<bigint> | null;
  refreshing: boolean;
  connect: (wallet: DiscoveredWallet) => Promise<void>;
  disconnect: () => Promise<void>;
  refresh: () => Promise<void>;
};

export function useStrk20(): Strk20State {
  const config = useMemo(() => loadConfig(), []);
  const provider = useMemo(() => new RpcProvider({ nodeUrl: config.rpcUrl }), [config.rpcUrl]);

  const [wallets, setWallets] = useState<DiscoveredWallet[]>([]);
  const [connection, setConnection] = useState<ConnectedWallet | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<Strk20NormalizedError | null>(null);
  const [capability, setCapability] = useState<Strk20Capability | null>(null);
  const [probing, setProbing] = useState(false);
  const [shielded, setShielded] = useState<Reading<Strk20Balance[]> | null>(null);
  const [publicBalance, setPublicBalance] = useState<Reading<bigint> | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // The registry is created once on mount so wallets have time to announce
  // themselves before the user opens the picker.
  useEffect(() => {
    const store = createWalletStore();
    return watchWallets(store, (next) => setWallets(selectableWallets(next)));
  }, []);

  const loadBalances = useCallback(
    async (active: ConnectedWallet) => {
      setPublicBalance(await readPublicBalance(provider, config.token, active.address));
      setShielded(await readShieldedBalances(active.account, []));
    },
    [config.token, provider]
  );

  const connect = useCallback(
    async (wallet: DiscoveredWallet) => {
      setConnecting(true);
      setConnectError(null);
      setCapability(null);
      setShielded(null);
      setPublicBalance(null);
      try {
        const outcome = await connectWallet(wallet, { rpcUrl: config.rpcUrl });
        if (!outcome.ok) {
          setConnectError(outcome.error);
          return;
        }
        setConnection(outcome.connection);

        setProbing(true);
        const probed = await probeStrk20Support(outcome.connection);
        setCapability(probed);
        setProbing(false);

        // The probe already carries the shielded balances when it succeeds, so
        // reuse them instead of asking the wallet twice.
        if (probed.balances) setShielded({ available: true, value: probed.balances });
        else if (probed.error) setShielded({ available: false, error: probed.error });

        setPublicBalance(await readPublicBalance(provider, config.token, outcome.connection.address));
      } finally {
        setConnecting(false);
        setProbing(false);
      }
    },
    [config.rpcUrl, config.token, provider]
  );

  const disconnect = useCallback(async () => {
    if (connection) await disconnectWallet(connection.wallet);
    setConnection(null);
    setCapability(null);
    setShielded(null);
    setPublicBalance(null);
    setConnectError(null);
  }, [connection]);

  const refresh = useCallback(async () => {
    if (!connection) return;
    setRefreshing(true);
    try {
      setCapability(await probeStrk20Support(connection));
      await loadBalances(connection);
    } finally {
      setRefreshing(false);
    }
  }, [connection, loadBalances]);

  return {
    config,
    provider,
    wallets,
    connection,
    connecting,
    connectError,
    capability,
    probing,
    shielded,
    publicBalance,
    refreshing,
    connect,
    disconnect,
    refresh,
  };
}
