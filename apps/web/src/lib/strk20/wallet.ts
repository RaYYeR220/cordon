/**
 * Wallet discovery, connection and teardown. No React, no DOM rendering — this
 * module only talks to the wallet-standard registry and to Starknet.js.
 */

import { createStore, type Store } from "@starknet-io/get-starknet-discovery";
import type { WalletWithStarknetFeatures } from "@starknet-io/get-starknet-wallet-standard/features";
import { RpcProvider, WalletAccountV6, validateAndParseAddress, walletV6 } from "starknet";

import { normalizeError } from "./errors";
import type { Strk20NormalizedError } from "./types";

export type DiscoveredWallet = WalletWithStarknetFeatures;

export type ConnectedWallet = {
  /** The wallet-standard object the user picked. */
  wallet: DiscoveredWallet;
  /** Starknet.js account bound to that wallet, carrying the STRK20 methods. */
  account: WalletAccountV6;
  name: string;
  icon: string;
  address: string;
  chainId: string;
  /** `wallet_supportedSpecs` — node spec versions the wallet speaks. */
  specVersions: string[];
  /** `wallet_supportedWalletApi` — wallet-API versions the wallet speaks. */
  walletApiVersions: string[];
  /** True when the wallet granted the ACCOUNTS permission. */
  hasAccountsPermission: boolean;
};

/**
 * Open the wallet-standard registry.
 *
 * `eip1193Adapters: []` is load-bearing. The default adapter list bridges
 * EIP-6963 providers into the registry, which makes MetaMask's Starknet Snap
 * get probed on every discovery pass and spams its unlock popup. Passing an
 * empty list keeps discovery to wallets that registered as Starknet wallets.
 * This is also why the app does not use starknetkit's `connect()`: it bundles
 * get-starknet-core, which does the same probing.
 */
export function createWalletStore(): Store {
  return createStore({ eip1193Adapters: [] });
}

/** Subscribe to the registry. Returns an unsubscribe function. */
export function watchWallets(
  store: Store,
  onChange: (wallets: DiscoveredWallet[]) => void
): () => void {
  onChange(store.getWallets().slice());
  return store.subscribe((wallets) => onChange(wallets.slice()));
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Wallets worth offering. MetaMask is filtered out: its Starknet support goes
 * through a Snap that has no STRK20 methods and interrupts the flow with an
 * unlock prompt.
 */
export function selectableWallets(wallets: readonly DiscoveredWallet[]): DiscoveredWallet[] {
  return wallets.filter((wallet) => !normalizeName(wallet.name).includes("metamask"));
}

async function readOptional<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    // Optional metadata. A wallet that does not answer is not a failure to
    // connect, and the capability probe reports what is missing.
    return fallback;
  }
}

export type ConnectOutcome =
  | { ok: true; connection: ConnectedWallet }
  | { ok: false; error: Strk20NormalizedError };

/**
 * Connect to a discovered wallet and build the `WalletAccountV6` the STRK20
 * methods hang off. The RPC provider is ours, not the wallet's: the wallet's own
 * provider is fixed at connect time and can point at a different network.
 */
export async function connectWallet(
  wallet: DiscoveredWallet,
  options: { rpcUrl: string }
): Promise<ConnectOutcome> {
  try {
    const provider = new RpcProvider({ nodeUrl: options.rpcUrl });
    const account = await WalletAccountV6.connect(provider, wallet);

    const accounts = await walletV6.requestAccounts(wallet);
    const first = Array.isArray(accounts) ? accounts[0] : undefined;
    if (typeof first !== "string") {
      return {
        ok: false,
        error: normalizeError(
          new Error(
            `${wallet.name} returned no account for wallet_requestAccounts, so it cannot be used.`
          )
        ),
      };
    }
    const address = validateAndParseAddress(first);

    const permissions = await readOptional(() => walletV6.getPermissions(wallet), [] as string[]);
    const hasAccountsPermission = permissions.some(
      (permission) => String(permission).toLowerCase() === "accounts"
    );

    const chainId = String(await walletV6.requestChainId(wallet));
    const specVersions = await readOptional(
      async () => (await walletV6.supportedSpecs(wallet)).map(String),
      []
    );
    const walletApiVersions = await readOptional(
      async () => (await walletV6.supportedWalletApi(wallet)).map(String),
      []
    );

    return {
      ok: true,
      connection: {
        wallet,
        account,
        name: wallet.name,
        icon: wallet.icon,
        address,
        chainId,
        specVersions,
        walletApiVersions,
        hasAccountsPermission,
      },
    };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

/**
 * Ask the wallet to drop the session through `standard:disconnect`. Wallets are
 * free to ignore it, so the caller must clear its own state regardless — the
 * boolean says whether the wallet acknowledged, not whether the UI should reset.
 */
export async function disconnectWallet(wallet: DiscoveredWallet): Promise<boolean> {
  try {
    await wallet.features["standard:disconnect"].disconnect();
    return true;
  } catch {
    return false;
  }
}
