/**
 * App configuration.
 *
 * The network constants themselves live in `@cordon/react/strk20`, because they are protocol facts
 * the published package has to know too. What stays here is the one thing that cannot: reading
 * this app's environment. A library that reaches for `process.env` behaves differently inside Next,
 * Vite and a test runner, so the package takes its configuration as an argument and this module is
 * what supplies it.
 */

import {
  DEFAULT_POOL_ADDRESS,
  DEFAULT_RPC_URL,
  SN_MAIN,
  STRK_TOKEN,
  type Address,
} from "@cordon/react/strk20";

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
