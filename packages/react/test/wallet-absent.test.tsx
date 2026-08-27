/**
 * Nothing throws when there is no wallet.
 *
 * A page can be server-rendered, opened in a browser with no Starknet extension, or opened in one
 * whose wallet does not implement the STRK20 methods at all. In every one of those cases the
 * components have to render something honest rather than take the host app's tree down with them,
 * so every component is mounted here with no wallet, no connection and no capability.
 */

import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import {
  ConnectWallet,
  GateFeed,
  GatedPaymentButton,
  PassportCard,
  PolicyBadge,
  RefusalNotice,
  SpendMeter,
} from "../src/index.js";
import { defaultChainState, makeRpc } from "./fixtures.js";
import { renderWithCordon } from "./harness.js";

const COMPONENTS: Array<[string, () => ReactElement]> = [
  ["ConnectWallet", () => <ConnectWallet />],
  ["PassportCard", () => <PassportCard />],
  ["PolicyBadge", () => <PolicyBadge policyId="ACCREDITED" />],
  ["SpendMeter", () => <SpendMeter policyId="ACCREDITED" pollMs={0} />],
  ["GatedPaymentButton", () => <GatedPaymentButton policyId="ACCREDITED" amount={1n} />],
  ["RefusalNotice", () => <RefusalNotice refusal={null} />],
  ["GateFeed", () => <GateFeed pollMs={0} />],
];

describe("with no wallet present", () => {
  for (const [name, element] of COMPONENTS) {
    it(`${name} mounts without throwing`, async () => {
      expect(() =>
        renderWithCordon(element(), { rpc: makeRpc(defaultChainState()), pinRegistries: true }),
      ).not.toThrow();
      // Let the effects settle too: a throw inside one is just as fatal as a throw in render.
      await waitFor(() => expect(document.body).toBeInTheDocument());
    });
  }

  it("ConnectWallet explains that no wallet announced itself", () => {
    renderWithCordon(<ConnectWallet />, {
      rpc: makeRpc(defaultChainState()),
      pinRegistries: true,
    });

    expect(screen.getByText("no wallet found")).toBeInTheDocument();
    expect(screen.getByText(/No Starknet wallet announced itself/)).toBeInTheDocument();
    // No dead connect button to press.
    expect(screen.queryByRole("button", { name: /Disconnect/ })).not.toBeInTheDocument();
  });

  it("GatedPaymentButton disables itself and names every missing precondition", () => {
    renderWithCordon(<GatedPaymentButton policyId="ACCREDITED" amount={1n} />, {
      rpc: makeRpc(defaultChainState()),
      pinRegistries: true,
    });

    const button = screen.getByRole("button", { name: "Pay" });
    expect(button).toBeDisabled();
    expect(screen.getByText("Connect a wallet first.")).toBeInTheDocument();
    expect(screen.getByText(/Load the credential this policy asks for/)).toBeInTheDocument();
    expect(screen.getByText(/subject key that authorises this settlement/)).toBeInTheDocument();
    expect(screen.getByText(/Name the payee/)).toBeInTheDocument();

    // Those sentences are what the button is described by, so the reason is announced and not
    // merely visible.
    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)).toHaveTextContent(
      "Connect a wallet first.",
    );
  });
});

describe("outside a provider", () => {
  it("says which provider is missing instead of failing obscurely", () => {
    // Rendering without the wrapper is the whole point of this case. A missing provider is a
    // wiring mistake, and a hook that quietly returned nulls would let it look like a wallet that
    // is merely not connected — an hour of someone's afternoon.
    expect(() => render(<PolicyBadge policyId="ACCREDITED" />)).toThrow(
      /must be rendered inside <CordonProvider>/,
    );
  });
});
