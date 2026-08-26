/**
 * Network constants and the shape of a Cordon configuration.
 *
 * Everything here is a protocol fact, not an inference. Nothing reads an environment variable:
 * a library that reaches for `process.env` is a library that behaves differently inside Next,
 * Vite and a test runner, so the host app passes its configuration to `<CordonProvider>` instead.
 */

import type { Address } from "@cordon/sdk";

export const SN_MAIN = "0x534e5f4d41494e";
export const SN_SEPOLIA = "0x534e5f5345504f4c4941";

/**
 * Default read RPC. Cartridge answers spec 0.10.2 consistently.
 * `https://rpc.starknet.lava.build` is a load-balanced mixed pool that intermittently answers
 * 0.8.1, which breaks 0.10-style calls mid-session.
 */
export const DEFAULT_RPC_URL = "https://api.cartridge.gg/x/starknet/mainnet";

/** STRK20 privacy pool on mainnet. */
export const DEFAULT_POOL_ADDRESS: Address =
  "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";

/** STRK on mainnet — the fee token, and the token most STRK20 flows move. */
export const STRK_TOKEN: Address =
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

export const STRK_DECIMALS = 18;

/**
 * The pool charges a flat fee per `apply_actions`, once per transaction, taken from an
 * already-shielded balance. A private action is impossible without it, so a UI has to say so
 * up front rather than let the user discover it in a rejection.
 */
export const POOL_FEE_STRK = 6n;
export const POOL_FEE_WEI = POOL_FEE_STRK * 10n ** BigInt(STRK_DECIMALS);

/**
 * Chains where a privacy pool exists. Anything else means the STRK20 methods cannot work,
 * whatever the wallet claims about them.
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
 * Proof verification runs on-chain, so a STRK20 transaction takes far longer to confirm than an
 * ordinary invoke. 400 x 3s is about twenty minutes.
 */
export const WAIT_RETRIES = 400;
export const WAIT_RETRY_INTERVAL_MS = 3000;

/** The addresses of the three registries the gate reads. */
export type CordonRegistries = {
  issuerRegistry: Address;
  revocationRegistry: Address;
  policyRegistry: Address;
};

/**
 * Everything `<CordonProvider>` needs.
 *
 * Only `gate` is genuinely required: the pool and the RPC have sensible mainnet defaults, and the
 * registries can be read off the gate itself with `readRegistries`, because the gate stores the
 * three addresses it trusts. Passing them explicitly saves a round-trip and pins them.
 */
export type CordonConfig = {
  /** Read RPC. Reads go here; the wallet still submits through its own transport. */
  rpcUrl: string;
  /** The STRK20 privacy pool. */
  poolAddress: Address;
  /** Cordon's `PolicyGate` — the anonymizer value routes through. */
  gateAddress: Address;
  /** The ERC20 being gated. */
  token: Address;
  /** Decimals for `token`, for display only. */
  tokenDecimals: number;
  /** Chain the pool and gate live on. */
  chainId: string;
  /** The three registries, when the host app already knows them. */
  registries?: CordonRegistries;
};

/** The parts of a {@link CordonConfig} a caller has to supply; the rest default to mainnet. */
export type CordonConfigInput = Partial<CordonConfig> & { gateAddress: Address };

/** Fill in the mainnet defaults around whatever the host app supplied. */
export function resolveConfig(input: CordonConfigInput): CordonConfig {
  return {
    rpcUrl: input.rpcUrl ?? DEFAULT_RPC_URL,
    poolAddress: input.poolAddress ?? DEFAULT_POOL_ADDRESS,
    gateAddress: input.gateAddress,
    token: input.token ?? STRK_TOKEN,
    tokenDecimals: input.tokenDecimals ?? STRK_DECIMALS,
    chainId: input.chainId ?? SN_MAIN,
    ...(input.registries !== undefined ? { registries: input.registries } : {}),
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
