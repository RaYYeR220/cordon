/**
 * The unavailable states.
 *
 * These are the tests that matter most. A component that renders a zero balance for an unreadable
 * balance, or "not revoked" for an unreadable revocation registry, is not merely wrong — it is
 * confidently wrong in the user's favour, which is the failure mode a compliance gate cannot have.
 *
 * Each case here breaks exactly one read and asserts the UI says so.
 */

import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PassportCard, PolicyBadge, SpendMeter, GateFeed } from "../src/index.js";
import {
  defaultChainState,
  makeCredential,
  makeRpc,
  policyPassedEvent,
  subjectKey,
} from "./fixtures.js";
import { CredentialHarness } from "./credential-harness.js";
import { renderWithCordon } from "./harness.js";

describe("a policy that cannot be read", () => {
  it("says unavailable, not empty, when the node refuses to answer", async () => {
    const state = defaultChainState();
    state.policyError = new Error("fetch failed: ECONNREFUSED");
    renderWithCordon(<PolicyBadge policyId="ACCREDITED" />, {
      rpc: makeRpc(state),
      pinRegistries: true,
    });

    await waitFor(() => expect(screen.getByText("unavailable")).toBeInTheDocument());
    expect(screen.getByText(/Its contents are unknown, not empty/)).toBeInTheDocument();
    // The rule list must not appear at all: an empty list would read as "this policy has no rules".
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("distinguishes a policy that was never published from a node that would not answer", async () => {
    const state = defaultChainState();
    state.policy = null; // the registry answers, with CORDON_NO_POLICY
    renderWithCordon(<PolicyBadge policyId="ACCREDITED" />, {
      rpc: makeRpc(state),
      pinRegistries: true,
    });

    await waitFor(() => expect(screen.getByText("not published")).toBeInTheDocument());
    expect(screen.getByText(/Nothing is published under this policy id/)).toBeInTheDocument();
  });

  it("reports a retired policy as its own state rather than as healthy", async () => {
    const state = defaultChainState();
    state.policy = { ...state.policy!, active: false };
    renderWithCordon(<PolicyBadge policyId="ACCREDITED" />, {
      rpc: makeRpc(state),
      pinRegistries: true,
    });

    await waitFor(() => expect(screen.getByText("retired")).toBeInTheDocument());
  });

  it("stays unavailable when the gate's own registry addresses cannot be read", async () => {
    const state = defaultChainState();
    state.registriesError = new Error("CONTRACT_NOT_FOUND");
    renderWithCordon(<PolicyBadge policyId="ACCREDITED" />, { rpc: makeRpc(state) });

    await waitFor(() => expect(screen.getByText("unavailable")).toBeInTheDocument());
  });
});

describe("a velocity counter that cannot be read", () => {
  it("shows an unavailable meter rather than a full allowance", async () => {
    const state = defaultChainState();
    state.epochSpend = null;
    renderWithCordon(
      <SpendMeter policyId="ACCREDITED" subjectPublicKey={subjectKey.publicKey} pollMs={0} />,
      { rpc: makeRpc(state), pinRegistries: true },
    );

    await waitFor(() => expect(screen.getAllByRole("meter").length).toBeGreaterThan(0));
    const meters = screen.getAllByRole("meter");
    const velocity = meters[meters.length - 1]!;

    // No `aria-valuenow` at all: an unread counter has no value, and zero would mean "nothing
    // spent, everything still available".
    expect(velocity).not.toHaveAttribute("aria-valuenow");
    expect(velocity).toHaveAttribute("aria-valuetext", expect.stringContaining("unavailable"));
    expect(
      screen.getByText(/how much of this period is already spent is unknown/),
    ).toBeInTheDocument();
  });

  it("renders a real reading when the counter answers", async () => {
    renderWithCordon(
      <SpendMeter policyId="ACCREDITED" subjectPublicKey={subjectKey.publicKey} pollMs={0} />,
      { rpc: makeRpc(defaultChainState()), pinRegistries: true },
    );

    await waitFor(() => expect(screen.getAllByRole("meter").length).toBe(2));
    const velocity = screen.getAllByRole("meter")[1]!;
    expect(velocity).toHaveAttribute("aria-valuetext", "10 of 500 used");
  });

  it("says so when no subject pseudonym was supplied to read a counter for", async () => {
    renderWithCordon(<SpendMeter policyId="ACCREDITED" pollMs={0} />, {
      rpc: makeRpc(defaultChainState()),
      pinRegistries: true,
    });

    await waitFor(() =>
      expect(screen.getByText(/Supply a subject pseudonym/)).toBeInTheDocument(),
    );
  });

  it("warns when the amount is over the cap, before anything is signed", async () => {
    renderWithCordon(
      <SpendMeter
        policyId="ACCREDITED"
        subjectPublicKey={subjectKey.publicKey}
        amount={10n ** 18n * 500n}
        pollMs={0}
      />,
      { rpc: makeRpc(defaultChainState()), pinRegistries: true },
    );

    await waitFor(() => expect(screen.getByText(/CORDON_OVER_CAP/)).toBeInTheDocument());
  });
});

describe("a credential whose revocation status cannot be read", () => {
  it("renders with no credential at all, and says exactly that", async () => {
    const state = defaultChainState();
    state.revoked = null;
    renderWithCordon(<PassportCard />, { rpc: makeRpc(state), pinRegistries: true });

    await waitFor(() => expect(screen.getByText("no credential")).toBeInTheDocument());
  });

  it("never renders 'not revoked' for a registry that did not answer", async () => {
    const state = defaultChainState();
    state.revoked = null;

    renderWithCordon(<CredentialHarness credential={makeCredential()} />, {
      rpc: makeRpc(state),
      pinRegistries: true,
    });

    await waitFor(() => expect(screen.getByText("standing unknown")).toBeInTheDocument());
    expect(screen.getByText(/genuinely unknown/)).toBeInTheDocument();
    // The "Revoked" field shows unavailable, never "no".
    expect(screen.getByText("Revoked").nextElementSibling).toHaveTextContent("unavailable");
  });

  it("reports a genuinely valid credential as valid once every check has run", async () => {
    renderWithCordon(<CredentialHarness credential={makeCredential()} />, {
      rpc: makeRpc(defaultChainState()),
      pinRegistries: true,
    });

    await waitFor(() => expect(screen.getByText("valid")).toBeInTheDocument());
    expect(screen.getByText("Revoked").nextElementSibling).toHaveTextContent("no");
  });

  it("refuses an expired credential with the gate's own code", async () => {
    renderWithCordon(
      <CredentialHarness
        credential={makeCredential({ expiresAt: Math.floor(Date.now() / 1000) - 60 })}
      />,
      { rpc: makeRpc(defaultChainState()), pinRegistries: true },
    );

    await waitFor(() => expect(screen.getByText("would be refused")).toBeInTheDocument());
    expect(screen.getByText("CORDON_EXPIRED")).toBeInTheDocument();
  });

  it("refuses a credential whose issuer has been deactivated", async () => {
    const state = defaultChainState();
    state.issuerActive = false;
    renderWithCordon(<CredentialHarness credential={makeCredential()} />, {
      rpc: makeRpc(state),
      pinRegistries: true,
    });

    await waitFor(() => expect(screen.getByText("would be refused")).toBeInTheDocument());
    expect(screen.getByText("CORDON_BAD_ISSUER")).toBeInTheDocument();
  });

  it("refuses a credential the issuer has revoked", async () => {
    const state = defaultChainState();
    state.revoked = true;
    renderWithCordon(<CredentialHarness credential={makeCredential()} />, {
      rpc: makeRpc(state),
      pinRegistries: true,
    });

    await waitFor(() => expect(screen.getByText("CORDON_REVOKED")).toBeInTheDocument());
  });
});

describe("a gate feed that cannot be read", () => {
  it("says the feed is unread rather than showing an empty gate", async () => {
    const state = defaultChainState();
    state.eventsError = new Error("TOO_MANY_BLOCKS_BACK");
    renderWithCordon(<GateFeed pollMs={0} />, { rpc: makeRpc(state), pinRegistries: true });

    await waitFor(() =>
      expect(screen.getByText(/it is an unread one/)).toBeInTheDocument(),
    );
  });

  it("renders passes read from the chain, labelled as on-chain", async () => {
    const state = defaultChainState();
    state.events = [policyPassedEvent({ amount: 5n * 10n ** 18n })];
    renderWithCordon(<GateFeed pollMs={0} />, { rpc: makeRpc(state), pinRegistries: true });

    await waitFor(() => expect(screen.getByText("passed")).toBeInTheDocument());
    expect(screen.getByText(/ACCREDITED · 5/)).toBeInTheDocument();
    expect(screen.getByText("block 1234")).toBeInTheDocument();
  });

  it("explains why refusals are not read from events", async () => {
    renderWithCordon(<GateFeed pollMs={0} />, {
      rpc: makeRpc(defaultChainState()),
      pinRegistries: true,
    });
    await waitFor(() =>
      expect(screen.getByText(/reverts its whole transaction and emits nothing/)).toBeInTheDocument(),
    );
  });
});
