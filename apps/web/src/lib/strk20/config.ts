/**
 * Network constants. Everything here is either a protocol fact or an env
 * override; nothing is inferred at runtime.
 */

import type { Address } from "./types";

export const SN_MAIN = "0x534e5f4d41494e";
export const SN_SEPOLIA = "0x534e5f5345504f4c4941";

/**
 * Default read RPC. Cartridge answers spec 0.10.2 consistently.
 * `https://rpc.starknet.lava.build` is a load-balanced mixed pool that
 * intermittently answers 0.8.1, which breaks 0.10-style calls mid-session.
 */
export const DEFAULT_RPC_URL = "https://api.cartridge.gg/x/starknet/mainnet";

/** STRK20 privacy pool on mainnet. */
export const DEFAULT_POOL_ADDRESS: Address =
  "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";

/** STRK on mainnet — the fee token and the token this shell moves. */
export const STRK_TOKEN: Address =
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

export const STRK_DECIMALS = 18;

/**
 * The pool charges a flat fee per `apply_actions`, once per transaction, taken
 * from an already-shielded balance. A private action is impossible without it,
 * so the UI has to state it up front.
 */
export const POOL_FEE_STRK = 6n;
export const POOL_FEE_WEI = POOL_FEE_STRK * 10n ** BigInt(STRK_DECIMALS);

/**
 * Chains where a privacy pool exists. Anything else means the STRK20 methods
 * cannot work, whatever the wallet claims.
 */
export const STRK20_CHAINS: Record<string, string> = {
  [SN_MAIN]: "mainnet",
  [SN_SEPOLIA]: "sepolia",
};

export function chainName(chainId: string | null): string | null {
  if (!chainId) return null;
  return STRK20_CHAINS[chainId.toLowerCase()] ?? null;
}

/**
 * Proof verification runs on-chain, so a STRK20 transaction takes far longer to
 * confirm than an ordinary invoke. 400 x 3s ~= 20 minutes.
 */
export const WAIT_RETRIES = 400;
export const WAIT_RETRY_INTERVAL_MS = 3000;

export type Strk20Config = {
  rpcUrl: string;
  poolAddress: Address;
  /** Cordon's PolicyGate anonymizer, or null while it is not deployed yet. */
  gateAddress: Address | null;
  token: Address;
  chainId: string;
};

function readEnv(name: string): string | undefined {
  // Next inlines NEXT_PUBLIC_* at build time, so these must be literal lookups.
  const table: Record<string, string | undefined> = {
    NEXT_PUBLIC_STARKNET_RPC_URL: process.env.NEXT_PUBLIC_STARKNET_RPC_URL,
    NEXT_PUBLIC_STRK20_POOL_ADDRESS: process.env.NEXT_PUBLIC_STRK20_POOL_ADDRESS,
    NEXT_PUBLIC_CORDON_GATE_ADDRESS: process.env.NEXT_PUBLIC_CORDON_GATE_ADDRESS,
  };
  const value = table[name];
  return value && value.trim() ? value.trim() : undefined;
}

export function loadConfig(): Strk20Config {
  return {
    rpcUrl: readEnv("NEXT_PUBLIC_STARKNET_RPC_URL") ?? DEFAULT_RPC_URL,
    poolAddress: readEnv("NEXT_PUBLIC_STRK20_POOL_ADDRESS") ?? DEFAULT_POOL_ADDRESS,
    gateAddress: readEnv("NEXT_PUBLIC_CORDON_GATE_ADDRESS") ?? null,
    token: STRK_TOKEN,
    chainId: SN_MAIN,
  };
}

export function voyagerTxUrl(txHash: string, chainId: string = SN_MAIN): string {
  const host = chainId.toLowerCase() === SN_SEPOLIA ? "sepolia.voyager.online" : "voyager.online";
  return `https://${host}/tx/${txHash}`;
}

export function voyagerContractUrl(address: string, chainId: string = SN_MAIN): string {
  const host = chainId.toLowerCase() === SN_SEPOLIA ? "sepolia.voyager.online" : "voyager.online";
  return `https://${host}/contract/${address}`;
}
