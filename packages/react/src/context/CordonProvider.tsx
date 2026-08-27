"use client";

/**
 * `<CordonProvider>` — the one thing an integrator has to add.
 *
 * It owns three things no individual hook should own on its own:
 *
 * 1. **Configuration.** The gate, the pool, the token and the RPC, resolved once. Only the gate is
 *    required; the rest default to the mainnet deployment.
 * 2. **One wallet connection.** Two `<ConnectWallet>` buttons on the same page must agree about
 *    what is connected, so discovery, connection and the STRK20 capability probe live here rather
 *    than in each hook instance.
 * 3. **The session's refusal journal.** A refusal reverts its transaction, and a reverted
 *    transaction emits no event — so a refusal exists on chain only as a receipt. Payments record
 *    theirs here, which is how `<GateFeed>` can show a refusal at all.
 *
 * Nothing here touches the network during render. Wallet discovery runs in an effect, so the tree
 * renders identically on a server and on a client.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { RpcProvider } from "starknet";
import type { Refusal } from "@cordon/sdk";

import {
  connectWallet,
  createWalletStore,
  disconnectWallet,
  probeStrk20Support,
  readRegistries,
  readShieldedBalances,
  resolveConfig,
  selectableWallets,
  watchWallets,
  type ConnectedWallet,
  type CordonConfig,
  type CordonConfigInput,
  type CordonRegistries,
  type CordonRpc,
  type DiscoveredWallet,
  type Reading,
  type Strk20Balance,
  type Strk20Capability,
  type Strk20NormalizedError,
} from "../strk20/index.js";

/** Where a credential is kept between visits. `localStorage` unless you say otherwise. */
export interface CordonStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

/** One refusal this session watched happen, kept so the feed can show it. */
export interface SessionRefusal {
  refusal: Refusal;
  /** The reverted transaction, when it got far enough to have a hash. */
  transactionHash: string | null;
  /** The policy the refused payment was judged against. */
  policyId: string | null;
  /** Milliseconds since the epoch, for ordering against on-chain events. */
  at: number;
}

export interface CordonContextValue {
  config: CordonConfig;
  /** Read provider bound to `config.rpcUrl`. Reads go here; the wallet submits through its own. */
  provider: CordonRpc;
  storage: CordonStorage | null;

  /** Wallets the wallet-standard registry has announced so far. */
  wallets: DiscoveredWallet[];
  connection: ConnectedWallet | null;
  connecting: boolean;
  connectError: Strk20NormalizedError | null;
  connect: (wallet: DiscoveredWallet) => Promise<void>;
  disconnect: () => Promise<void>;

  /** What the wallet answered when asked whether it speaks STRK20. Null until probed. */
  capability: Strk20Capability | null;
  probing: boolean;
  refreshCapability: () => Promise<void>;

  /** Shielded balances, or an explicit unavailable. Null before the first read. */
  balances: Reading<Strk20Balance[]> | null;
  refreshBalances: () => Promise<void>;

  /** The registries the gate trusts, from config or read off the gate. Null before the read. */
  registries: Reading<CordonRegistries> | null;

  refusals: SessionRefusal[];
  recordRefusal: (entry: Omit<SessionRefusal, "at"> & { at?: number }) => void;
}

const CordonContext = createContext<CordonContextValue | null>(null);

export interface CordonProviderProps {
  /** Gate address at minimum; pool, token, RPC and chain default to the mainnet deployment. */
  config: CordonConfigInput;
  /**
   * Use this provider for reads instead of building one from `config.rpcUrl`.
   *
   * Pass the `RpcProvider` your app already has, so the page holds one connection to the node
   * rather than two, and so a wrapper you have put around it — retries, caching, a proxy — applies
   * to Cordon's reads as well.
   */
  provider?: CordonRpc;
  /**
   * Where credentials are persisted. Defaults to `window.localStorage` when there is one, and to
   * nothing at all on a server, so a credential is never written somewhere the app did not ask for.
   */
  storage?: CordonStorage | null;
  /** Skip wallet discovery entirely — for a host app that already has a wallet connection. */
  discoverWallets?: boolean;
  children: ReactNode;
}

export function CordonProvider({
  config: configInput,
  provider: suppliedProvider,
  storage,
  discoverWallets = true,
  children,
}: CordonProviderProps): ReactNode {
  const config = useMemo(() => resolveConfig(configInput), [configInput]);
  const provider = useMemo<CordonRpc>(
    () => suppliedProvider ?? new RpcProvider({ nodeUrl: config.rpcUrl }),
    [suppliedProvider, config.rpcUrl],
  );

  const [wallets, setWallets] = useState<DiscoveredWallet[]>([]);
  const [connection, setConnection] = useState<ConnectedWallet | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<Strk20NormalizedError | null>(null);
  const [capability, setCapability] = useState<Strk20Capability | null>(null);
  const [probing, setProbing] = useState(false);
  const [balances, setBalances] = useState<Reading<Strk20Balance[]> | null>(null);
  const [registries, setRegistries] = useState<Reading<CordonRegistries> | null>(
    config.registries ? { available: true, value: config.registries } : null,
  );
  const [refusals, setRefusals] = useState<SessionRefusal[]>([]);

  const resolvedStorage = useMemo<CordonStorage | null>(() => {
    if (storage !== undefined) return storage;
    if (typeof window === "undefined") return null;
    try {
      // Touching localStorage throws outright in some privacy modes, so prove it works first.
      window.localStorage.getItem("cordon:probe");
      return window.localStorage;
    } catch {
      return null;
    }
  }, [storage]);

  // Wallet discovery. Effect-only, so server and client render the same empty list.
  useEffect(() => {
    if (!discoverWallets || typeof window === "undefined") return;
    let store: ReturnType<typeof createWalletStore>;
    try {
      store = createWalletStore();
    } catch {
      // A registry that refuses to open is a page with no injected wallets, not an error to throw
      // into a render tree. `<ConnectWallet>` renders its own "no wallet found" state.
      return;
    }
    return watchWallets(store, (found) => setWallets(selectableWallets(found)));
  }, [discoverWallets]);

  // The gate knows its own registries, so an integrator who passes only a gate address still gets
  // credential and policy checks. Config wins when it is given: it pins them.
  useEffect(() => {
    if (config.registries) {
      setRegistries({ available: true, value: config.registries });
      return;
    }
    let cancelled = false;
    void readRegistries(provider, config.gateAddress).then((reading) => {
      if (!cancelled) setRegistries(reading);
    });
    return () => {
      cancelled = true;
    };
  }, [provider, config.gateAddress, config.registries]);

  const probe = useCallback(async (target: ConnectedWallet): Promise<void> => {
    setProbing(true);
    try {
      setCapability(await probeStrk20Support(target));
    } finally {
      setProbing(false);
    }
  }, []);

  const connect = useCallback(
    async (wallet: DiscoveredWallet): Promise<void> => {
      setConnecting(true);
      setConnectError(null);
      try {
        const outcome = await connectWallet(wallet, { rpcUrl: config.rpcUrl });
        if (!outcome.ok) {
          setConnectError(outcome.error);
          return;
        }
        setConnection(outcome.connection);
        await probe(outcome.connection);
        setBalances(await readShieldedBalances(outcome.connection.account));
      } finally {
        setConnecting(false);
      }
    },
    [config.rpcUrl, probe],
  );

  // The wallet is free to ignore `standard:disconnect`, so local state is cleared either way.
  const disconnect = useCallback(async (): Promise<void> => {
    const current = connection;
    setConnection(null);
    setCapability(null);
    setBalances(null);
    setConnectError(null);
    if (current) await disconnectWallet(current.wallet);
  }, [connection]);

  const refreshCapability = useCallback(async (): Promise<void> => {
    if (connection) await probe(connection);
  }, [connection, probe]);

  const refreshBalances = useCallback(async (): Promise<void> => {
    if (!connection) return;
    setBalances(await readShieldedBalances(connection.account));
  }, [connection]);

  const recordRefusal = useCallback(
    (entry: Omit<SessionRefusal, "at"> & { at?: number }): void => {
      setRefusals((current) => [{ ...entry, at: entry.at ?? Date.now() }, ...current].slice(0, 50));
    },
    [],
  );

  // Keep the identity of the context stable across renders that changed nothing, so a consumer
  // rendering a live meter does not re-render on every unrelated state change.
  const value = useMemo<CordonContextValue>(
    () => ({
      config,
      provider,
      storage: resolvedStorage,
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
      registries,
      refusals,
      recordRefusal,
    }),
    [
      config,
      provider,
      resolvedStorage,
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
      registries,
      refusals,
      recordRefusal,
    ],
  );

  return <CordonContext.Provider value={value}>{children}</CordonContext.Provider>;
}

/**
 * The provider's value.
 *
 * Throws when there is no `<CordonProvider>` above, because every alternative is worse: a hook
 * that silently returns nulls would let a missing provider look like a wallet that is merely not
 * connected, and that is a bug an integrator would chase for an hour.
 */
export function useCordonContext(): CordonContextValue {
  const value = useContext(CordonContext);
  if (!value) {
    throw new Error(
      "Cordon hooks and components must be rendered inside <CordonProvider>. Wrap your app: " +
        '<CordonProvider config={{ gateAddress: "0x…" }}>…</CordonProvider>',
    );
  }
  return value;
}

/** The resolved configuration on its own, for a component that only needs an address. */
export function useCordonConfig(): CordonConfig {
  return useCordonContext().config;
}

/** A ref that always holds the latest value, for callbacks that must not re-create on every change. */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
