/**
 * Render helpers: a `<CordonProvider>` wired to the fake node, with wallet discovery off.
 *
 * Discovery is off by default because it is the one thing in the package that talks to the
 * browser's wallet registry, and every component has to behave when nothing answers it. Tests that
 * need a connection mock `connectWallet` instead — see `payment.test.tsx`.
 */

import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { CordonProvider } from "../src/index.js";
import { GATE, ISSUER_REGISTRY, POLICY_REGISTRY, REVOCATION_REGISTRY, TOKEN } from "./fixtures.js";
import type { makeRpc } from "./fixtures.js";

export interface HarnessOptions extends Omit<RenderOptions, "wrapper"> {
  rpc: ReturnType<typeof makeRpc>;
  /** Pin the registries instead of letting the provider read them off the gate. */
  pinRegistries?: boolean;
  discoverWallets?: boolean;
}

export function renderWithCordon(ui: ReactElement, options: HarnessOptions): RenderResult {
  const { rpc, pinRegistries = false, discoverWallets = false, ...rest } = options;

  function Wrapper({ children }: { children: ReactNode }): ReactNode {
    return (
      <CordonProvider
        provider={rpc}
        discoverWallets={discoverWallets}
        storage={null}
        config={{
          gateAddress: GATE,
          token: TOKEN,
          ...(pinRegistries
            ? {
                registries: {
                  issuerRegistry: ISSUER_REGISTRY,
                  revocationRegistry: REVOCATION_REGISTRY,
                  policyRegistry: POLICY_REGISTRY,
                },
              }
            : {}),
        }}
      >
        {children}
      </CordonProvider>
    );
  }

  return render(ui, { wrapper: Wrapper, ...rest });
}
