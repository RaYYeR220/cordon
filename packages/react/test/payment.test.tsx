/**
 * The payment state machine, end to end.
 *
 * The wallet is the one thing faked here: `connectWallet` hands back an account whose
 * `strk20InvokeTransaction` the test controls. Everything else is the real path — the real
 * pre-flight against the fake node, real STARK-curve signing with a real subject key, the real
 * action array, the real refusal decoding.
 *
 * What these assert, in order of how much they matter:
 *
 * 1. A predicted refusal stops before the wallet is ever asked, so the pool's fee is not spent
 *    learning something that could be worked out for free.
 * 2. `refused` is not `failed`. A gate that refused and a node that was unreachable are different
 *    outcomes and reach different terminal states.
 * 3. Every step of the machine is observable, because on STRK20 they take minutes each.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConnectWallet,
  CordonProvider,
  GatedPaymentButton,
  type UseGatedPaymentOptions,
} from "../src/index.js";
import {
  GATE,
  ISSUER_REGISTRY,
  ONE_STRK,
  PAYEE,
  POLICY_REGISTRY,
  REVOCATION_REGISTRY,
  TOKEN,
  defaultChainState,
  makeCredential,
  makeRpc,
  payeeKey,
  revertReason,
  subjectKey,
  type ChainState,
} from "./fixtures.js";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("../src/strk20/wallet.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/strk20/wallet.js")>();
  const fakeWallet = {
    name: "Ready",
    icon: "",
    features: { "standard:disconnect": { disconnect: async () => undefined } },
  };
  return {
    ...actual,
    createWalletStore: () => ({}),
    watchWallets: (_store: unknown, onChange: (wallets: unknown[]) => void) => {
      onChange([fakeWallet]);
      return () => undefined;
    },
    selectableWallets: (wallets: unknown[]) => wallets,
    connectWallet: async () => ({
      ok: true,
      connection: {
        wallet: fakeWallet,
        account: {
          strk20Balances: async () => [],
          strk20InvokeTransaction: mocks.invoke,
        },
        name: "Ready",
        icon: "",
        address: "0x0abcdef",
        chainId: "0x534e5f4d41494e",
        specVersions: ["0.10.2"],
        walletApiVersions: ["0.9.0"],
        hasAccountsPermission: true,
      },
    }),
    disconnectWallet: async () => true,
  };
});

const NOTE_ID = "0x6e6f74655f30";

function Harness({
  chain,
  ...options
}: { chain: ChainState } & UseGatedPaymentOptions & { force?: boolean }): ReactNode {
  const rpc = makeRpc(chain);
  return (
    <CordonProvider
      provider={rpc}
      storage={null}
      config={{
        gateAddress: GATE,
        token: TOKEN,
        registries: {
          issuerRegistry: ISSUER_REGISTRY,
          revocationRegistry: REVOCATION_REGISTRY,
          policyRegistry: POLICY_REGISTRY,
        },
      }}
    >
      <ConnectWallet />
      <GatedPaymentButton
        payee={PAYEE}
        policyId="ACCREDITED"
        credential={makeCredential()}
        subjectPrivateKey={subjectKey.privateKey}
        noteId={NOTE_ID}
        {...options}
      />
    </CordonProvider>
  );
}

async function connectAndPay(): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Ready" }));
  await waitFor(() => expect(screen.getByText("STRK20 ready")).toBeInTheDocument());
  await waitFor(() => expect(screen.getByRole("button", { name: "Pay" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Pay" }));
}

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue({ transaction_hash: "0x0feed1" });
});

describe("a payment the pre-flight can already tell will be refused", () => {
  it("names the rule and never asks the wallet", async () => {
    render(<Harness chain={defaultChainState()} amount={500n * ONE_STRK} />);
    await connectAndPay();

    await waitFor(() => expect(screen.getByText("CORDON_OVER_CAP")).toBeInTheDocument());
    expect(screen.getByText(/no fee was charged/)).toBeInTheDocument();
    // The whole point: the wallet was never asked to prove and submit a transaction that could
    // only revert.
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("submits anyway when the revert is the point", async () => {
    const chain = defaultChainState();
    chain.receipt = {
      execution_status: "REVERTED",
      finality_status: "ACCEPTED_ON_L2",
      revert_reason: revertReason("CORDON_OVER_CAP"),
      events: [],
    };
    render(<Harness chain={chain} amount={500n * ONE_STRK} force />);
    await connectAndPay();

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("CORDON_OVER_CAP")).toBeInTheDocument());
    // Now it is an on-chain fact, not a prediction, and it has a link to prove it.
    expect(screen.getAllByText(/The transaction reverted whole/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/no fee was charged/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Voyager/ })).toHaveAttribute(
      "href",
      "https://voyager.online/tx/0x0feed1",
    );
  });

  it("builds the three-action array the pool requires", async () => {
    const chain = defaultChainState();
    render(<Harness chain={chain} amount={10n * ONE_STRK} />);
    await connectAndPay();

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    const actions = mocks.invoke.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    expect(actions.map((action) => action["type"])).toEqual(["withdraw", "transfer", "invoke"]);
    // The wallet substitutes these literals; hex-encoding either one breaks the substitution.
    expect(actions[1]?.["amount"]).toBe("OPEN");
    const calldata = actions[2]?.["calldata"] as string[];
    expect(calldata).toContain("${poolAddress}");
    expect(calldata).toContain("${openNoteIds[0]}");
  });
});

describe("a payment that settles", () => {
  it("reaches confirmed and links the transaction", async () => {
    render(<Harness chain={defaultChainState()} amount={10n * ONE_STRK} />);
    await connectAndPay();

    await waitFor(() => expect(screen.getByText("settled")).toBeInTheDocument());
    expect(screen.getByText(/the policy check is a public fact/)).toBeInTheDocument();
    // No refusal anywhere: the alert region is present but empty.
    expect(screen.getAllByRole("alert").every((node) => node.textContent === "")).toBe(true);
  });
});

describe("a refusal that only the chain could know about", () => {
  const CASES = [
    ["CORDON_NONCE_USED", /already spent/],
    ["CORDON_REVOKED", /revoked/],
    ["CORDON_OVER_VELOCITY", /limit for this period/],
  ] as const;

  for (const [code, expected] of CASES) {
    it(`surfaces ${code} from the receipt`, async () => {
      const chain = defaultChainState();
      chain.receipt = {
        execution_status: "REVERTED",
        finality_status: "ACCEPTED_ON_L2",
        revert_reason: revertReason(code),
        events: [],
      };
      render(<Harness chain={chain} amount={10n * ONE_STRK} />);
      await connectAndPay();

      await waitFor(() => expect(screen.getByText(code)).toBeInTheDocument());
      expect(screen.getByText(expected)).toBeInTheDocument();
    });
  }
});

describe("everything that is not a refusal", () => {
  it("reports a declined wallet prompt as failed, not refused", async () => {
    mocks.invoke.mockRejectedValue(
      Object.assign(new Error("User refused the operation"), { code: 113 }),
    );
    render(<Harness chain={defaultChainState()} amount={10n * ONE_STRK} />);
    await connectAndPay();

    await waitFor(() =>
      expect(screen.getByText(/User refused the operation/)).toBeInTheDocument(),
    );
    // No CORDON code invented for something the gate never saw.
    expect(screen.queryByText(/^CORDON_/)).not.toBeInTheDocument();
  });

  it("reports a receipt that never arrived as unconfirmed, not as a failure", async () => {
    const chain = defaultChainState();
    chain.receiptError = new Error("waitForTransaction timed out after 400 retries");
    render(<Harness chain={chain} amount={10n * ONE_STRK} />);
    await connectAndPay();

    await waitFor(() =>
      expect(screen.getByText(/may still land/)).toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: /Voyager/ })).toBeInTheDocument();
  });
});

describe("the context every signature is bound to", () => {
  it("refuses to sign against a pool the gate does not serve", async () => {
    const chain = defaultChainState();
    // A plausible-looking address in the config that is not the one the gate was constructed
    // against. Every signature made against it would be refused with CORDON_BAD_POOL — after the
    // user had paid for the transaction.
    chain.pool = "0x0555555555555555555555555555555555555555555555555555555555555555";
    render(<Harness chain={chain} amount={10n * ONE_STRK} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Ready" }));
    await waitFor(() => expect(screen.getByText("STRK20 ready")).toBeInTheDocument());

    await waitFor(() =>
      expect(screen.getByText(/CORDON_BAD_POOL/)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Pay" })).toBeDisabled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("blocks when the gate will not say which pool it serves", async () => {
    const chain = defaultChainState();
    chain.poolError = new Error("CONTRACT_NOT_FOUND");
    render(<Harness chain={chain} amount={10n * ONE_STRK} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Ready" }));
    await waitFor(() => expect(screen.getByText("STRK20 ready")).toBeInTheDocument());

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pay" })).toBeDisabled(),
    );
    expect(screen.getByText(/could not read privacy_pool/)).toBeInTheDocument();
  });
});

describe("the note id the subject has to sign over", () => {
  it("blocks the payment rather than signing a placeholder that would be refused", async () => {
    render(<Harness chain={defaultChainState()} amount={10n * ONE_STRK} noteId={null} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Ready" }));
    await waitFor(() => expect(screen.getByText("STRK20 ready")).toBeInTheDocument());

    expect(screen.getByRole("button", { name: "Pay" })).toBeDisabled();
    expect(screen.getByText(/CORDON_BAD_SUBJECT_SIG/)).toBeInTheDocument();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("needs none on the fund leg, which reserves no note", async () => {
    render(
      <Harness
        chain={defaultChainState()}
        leg="fund"
        amount={10n * ONE_STRK}
        noteId={null}
        payeeSubjectKey={payeeKey.publicKey}
        payeeClaimPolicyId="ACCREDITED"
        expiresAt={Math.floor(Date.now() / 1000) + 3600}
      />,
    );
    await connectAndPay();

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    const actions = mocks.invoke.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    // withdraw -> invoke, with no open note: nothing comes back in this transaction.
    expect(actions.map((action) => action["type"])).toEqual(["withdraw", "invoke"]);
  });

  it("blocks a fund that names no payee, which anyone could then claim", async () => {
    render(
      <Harness
        chain={defaultChainState()}
        leg="fund"
        amount={10n * ONE_STRK}
        noteId={null}
        payeeClaimPolicyId="ACCREDITED"
        expiresAt={Math.floor(Date.now() / 1000) + 3600}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Ready" }));
    await waitFor(() => expect(screen.getByText("STRK20 ready")).toBeInTheDocument());

    expect(screen.getByRole("button", { name: "Pay" })).toBeDisabled();
    expect(screen.getByText(/Name the payee's pseudonym/)).toBeInTheDocument();
  });
});
