/**
 * The pseudonym is one thing per session, not one per hook.
 *
 * Every screen that touches Cordon calls `useCordonCredential`, and until the subject key lived on
 * the provider each of them got its own empty copy. That is invisible on the screen where the key
 * is derived and fatal on the next one: the payment hook reports `NO_SUBJECT_KEY` and there is no
 * way at all to authorise a settlement. So this file pins the sharing rather than trusting it.
 */

import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { generateSubjectKeypair } from "@cordon/sdk";
import type { ReactNode } from "react";

import { CordonProvider, useCordonCredential } from "../src/index.js";
import { GATE, TOKEN, defaultChainState, makeRpc } from "./fixtures.js";

/** Two independent consumers, exactly as two screens of one app would be. */
function Deriver(): ReactNode {
  const credential = useCordonCredential();
  return (
    <button type="button" onClick={() => credential.generateSubject()}>
      derive
    </button>
  );
}

function Reader(): ReactNode {
  const credential = useCordonCredential();
  return <p data-testid="reader">{credential.subject?.publicKey ?? "none"}</p>;
}

function Slotted(): ReactNode {
  const credential = useCordonCredential({ slot: "payee" });
  return <p data-testid="slotted">{credential.subject?.publicKey ?? "none"}</p>;
}

function renderTree(children: ReactNode): void {
  const rpc = makeRpc(defaultChainState());
  render(
    <CordonProvider provider={rpc} discoverWallets={false} storage={null} config={{ gateAddress: GATE, token: TOKEN }}>
      {children}
    </CordonProvider>,
  );
}

describe("the subject pseudonym", () => {
  it("is visible to every hook in the tree once one of them holds it", () => {
    renderTree(
      <>
        <Deriver />
        <Reader />
      </>,
    );

    expect(screen.getByTestId("reader")).toHaveTextContent("none");
    act(() => {
      screen.getByText("derive").click();
    });
    expect(screen.getByTestId("reader").textContent).toMatch(/^0x[0-9a-f]+$/);
  });

  it("stays inside its slot, so two flows can hold different pseudonyms", () => {
    renderTree(
      <>
        <Deriver />
        <Reader />
        <Slotted />
      </>,
    );

    act(() => {
      screen.getByText("derive").click();
    });
    expect(screen.getByTestId("reader").textContent).toMatch(/^0x/);
    expect(screen.getByTestId("slotted")).toHaveTextContent("none");
  });

  it("is not written to storage unless the integrator asks for it", () => {
    // The default has to stay off: the key is re-derivable from a wallet signature on any device,
    // so persisting it adds a stealable secret and buys a click.
    const written: string[] = [];
    const storage = {
      getItem: () => null,
      setItem: (key: string) => void written.push(key),
      removeItem: () => undefined,
    };
    const keypair = generateSubjectKeypair();

    function Persisting(): ReactNode {
      const credential = useCordonCredential();
      return (
        <button type="button" onClick={() => credential.setSubject(keypair)}>
          set
        </button>
      );
    }

    render(
      <CordonProvider
        provider={makeRpc(defaultChainState())}
        discoverWallets={false}
        storage={storage}
        config={{ gateAddress: GATE, token: TOKEN }}
      >
        <Persisting />
      </CordonProvider>,
    );
    act(() => {
      screen.getByText("set").click();
    });

    expect(written.filter((key) => key.endsWith(":subject"))).toEqual([]);
  });
});
