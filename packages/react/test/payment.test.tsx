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
import { num } from "starknet";

import {
  GATE,
  ISSUER_REGISTRY,
  ONE_STRK,
  PAYEE,
  POLICY_REGISTRY,
  POOL,
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

/**
 * A wallet that behaves like Ready: it resolves `${openNoteIds[0]}` at prepare time and returns
 * the substituted calldata, which is the whole reason a bound authorisation is possible.
 *
 * `noteIds` is a queue. Pushing two different ids models another transaction landing on the same
 * channel between the two prepares, which is what `NoteDriftError` exists for.
 */
const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  prepare: vi.fn(),
  noteIds: [] as string[],
  /** Overrides the wallet account, for modelling a wallet missing the prepare methods. */
  account: undefined as Record<string, unknown> | undefined,
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
        account: mocks.account ?? {
          strk20Balances: async () => [],
          strk20PrepareInvoke: mocks.prepare,
          executeWithProof: mocks.execute,
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
const OTHER_NOTE_ID = "0x6e6f74655f31";
/** What sits after the invoke in the envelope. The old reader bound to exactly this. */
const TRAILING_JUNK = "0x1";

/**
 * Stand in for the wallet's `strk20PrepareInvoke`.
 *
 * The shape here is the whole point. `strk20PrepareInvoke` does **not** hand back our
 * `privacy_invoke`; it hands back the pool's own `apply_actions` transaction with our invoke
 * nested inside it, among the withdraw and transfer actions. On the real mainnet transaction the
 * gate invoke starts at index 85 of 111 felts and the note id sits at 104, with eleven unrelated
 * felts after it — so a stub that returned the bare invoke, or that let the reader take the last
 * felt, would agree with a bug rather than catch one.
 *
 * Three things this deliberately reproduces:
 *
 * - **Decoy gate addresses.** The gate appears three times in the real calldata, because it is
 *   also the withdraw recipient. Only one occurrence is followed by the right calldata length and
 *   the right token and pool, so the decoys prove the shape match is doing the work.
 * - **A decoy with the right length too**, whose token and pool slots hold something else — that
 *   is what makes the token/pool half of the match load-bearing rather than decorative.
 * - **Trailing felts after the invoke.** Reading the end of the array lands on `0x1`, which is
 *   exactly the junk the old reader bound to.
 *
 * Both placeholders are substituted, as a real wallet does — the mainnet fixture has the pool
 * resolved at index 103.
 */
function preparedFrom(actions: Array<Record<string, unknown>>, noteId: string) {
  const invoke = actions.find((action) => action["type"] === "invoke");
  const resolved = ((invoke?.["calldata"] as string[]) ?? []).map((item) => {
    if (item === "${openNoteIds[0]}") return noteId;
    if (item === "${poolAddress}") return POOL;
    return item;
  });
  const length = num.toHex(resolved.length);

  return {
    call: {
      contractAddress: POOL,
      entrypoint: "apply_actions",
      calldata: [
        // Pool actions. The gate turns up twice as a withdraw recipient, as it does on mainnet.
        "0x2",
        TOKEN,
        GATE,
        "0x53444835ec580000",
        TOKEN,
        GATE,
        "0x0",
        // A third gate occurrence, this one followed by the *right* length but the wrong token and
        // pool in the two slots before its note id. Only the full shape rules it out.
        GATE,
        length,
        ...Array.from({ length: resolved.length }, () => "0x7"),
        // The real invoke: gate, length, then the resolved calldata.
        GATE,
        length,
        ...resolved,
        // Trailing felts. `calldata.at(-1)` lands here, not on the note id.
        TRAILING_JUNK,
        "0x0",
      ],
    },
    proof: { data: ["0xproof"] },
  };
}

function Harness({
  chain,
  account,
  ...options
}: {
  chain: ChainState;
  account?: Record<string, unknown>;
} & UseGatedPaymentOptions & { force?: boolean }): ReactNode {
  const rpc = makeRpc(chain);
  mocks.account = account;
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
  mocks.prepare.mockReset();
  mocks.execute.mockReset();
  mocks.noteIds = [];
  mocks.account = undefined;
  // By default the note is stable across both prepares, which is the ordinary case.
  mocks.prepare.mockImplementation(async (actions: Array<Record<string, unknown>>) =>
    preparedFrom(actions, mocks.noteIds.shift() ?? NOTE_ID),
  );
  mocks.execute.mockResolvedValue({ transaction_hash: "0x0feed1" });
});

describe("a payment the pre-flight can already tell will be refused", () => {
  it("names the rule and never asks the wallet", async () => {
    render(<Harness chain={defaultChainState()} amount={500n * ONE_STRK} />);
    await connectAndPay();

    await waitFor(() => expect(screen.getByText("CORDON_OVER_CAP")).toBeInTheDocument());
    expect(screen.getByText(/no fee was charged/)).toBeInTheDocument();
    // The whole point: the wallet was never asked to prove and submit a transaction that could
    // only revert.
    expect(mocks.execute).not.toHaveBeenCalled();
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

    await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));
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

    await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));
    const actions = mocks.prepare.mock.calls.at(-1)?.[0] as Array<Record<string, unknown>>;
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
    mocks.execute.mockRejectedValue(
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
    expect(mocks.execute).not.toHaveBeenCalled();
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

describe("the note the authorisation is bound to", () => {
  it("signs for the note the wallet says the transaction will fill", async () => {
    render(<Harness chain={defaultChainState()} amount={10n * ONE_STRK} />);
    await connectAndPay();

    await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));
    // Two prepares: one to learn the note id, one with the real signature bound to it.
    expect(mocks.prepare).toHaveBeenCalledTimes(2);

    // Assert the binding, not a position. The note id lives inside the nested invoke, and the
    // prepared call ends with unrelated felts — reading either end is how this went wrong before.
    expect(screen.getByText(new RegExp(`Only note ${NOTE_ID}`))).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(`Only note ${TRAILING_JUNK}\b`))).not.toBeInTheDocument();

    const submitted = mocks.execute.mock.calls[0]?.[0] as { calldata: string[] };
    expect(submitted.calldata).toContain(NOTE_ID);
    expect(submitted.calldata.at(-1)).not.toBe(NOTE_ID);
  });

  it("fails closed when the note moves between the two prepares", async () => {
    // Another transaction lands on the same channel in between, so the index advances.
    mocks.noteIds = [NOTE_ID, OTHER_NOTE_ID];
    render(<Harness chain={defaultChainState()} amount={10n * ONE_STRK} />);
    await connectAndPay();

    await waitFor(() => expect(screen.getByText(/Nothing was submitted/)).toBeInTheDocument());
    expect(mocks.execute).not.toHaveBeenCalled();
    // A drift is the check working, so it offers a retry rather than a dead end.
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(screen.getByText(/This is the check working/)).toBeInTheDocument();
  });

  it("retries cleanly after a drift, signing for the note that settled", async () => {
    mocks.noteIds = [NOTE_ID, OTHER_NOTE_ID];
    render(<Harness chain={defaultChainState()} amount={10n * ONE_STRK} />);
    await connectAndPay();
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled());

    // The channel has settled on the new note, so the retry sees it from both prepares.
    mocks.prepare.mockImplementation(async (actions: Array<Record<string, unknown>>) =>
      preparedFrom(actions, OTHER_NOTE_ID),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));
    expect(screen.getByText(new RegExp(`Only note ${OTHER_NOTE_ID}`))).toBeInTheDocument();
  });

  it("is exercised against an envelope that really does hide the invoke", async () => {
    // Guards the stub itself. If a later change flattens this back to a bare invoke, or drops the
    // decoy gate addresses, the tests above would start passing for the wrong reason — they would
    // agree with the bug instead of catching it.
    render(<Harness chain={defaultChainState()} amount={10n * ONE_STRK} />);
    await connectAndPay();
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));

    const submitted = mocks.execute.mock.calls[0]?.[0] as { calldata: string[] };
    const gateOccurrences = submitted.calldata.filter(
      (felt) => BigInt(felt) === BigInt(GATE),
    ).length;
    // Four: the three mainnet has (twice as a withdraw recipient, once as the invoked contract),
    // plus the decoy carrying the right calldata length but the wrong token and pool. One more
    // than reality, on purpose — it is the one that proves the length check alone is not enough.
    expect(gateOccurrences).toBe(4);
    // The note id is buried, not at either end.
    const noteIndex = submitted.calldata.indexOf(NOTE_ID);
    expect(noteIndex).toBeGreaterThan(0);
    expect(noteIndex).toBeLessThan(submitted.calldata.length - 1);
  });

  /**
   * The regression that cost an afternoon.
   *
   * `strk20PrepareInvoke` returns the pool's transaction with our invoke nested inside, so the
   * final felt of the prepared call is not the note id — it is whatever the pool put there. A
   * reader that took the last felt bound the authorisation to that junk, and the gate refused
   * every payment with CORDON_NOTE_MISMATCH.
   *
   * The nastiest version is the one below: junk that *looks* like a note id, so a naive reader
   * fails silently rather than loudly. The only acceptable outcomes are binding the real note or
   * failing outright. Signing the junk is never one of them.
   */
  it("binds the nested note id, never the felt that happens to be last", async () => {
    // Trailing junk shaped exactly like a note id, so nothing about it looks wrong.
    const decoyNote = "0x6e6f74655f39";
    mocks.prepare.mockImplementation(async (actions: Array<Record<string, unknown>>) => {
      const prepared = preparedFrom(actions, NOTE_ID);
      prepared.call.calldata[prepared.call.calldata.length - 1] = decoyNote;
      return prepared;
    });

    render(<Harness chain={defaultChainState()} amount={10n * ONE_STRK} />);
    await connectAndPay();

    await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));
    const submitted = mocks.execute.mock.calls[0]?.[0] as { calldata: string[] };
    expect(submitted.calldata.at(-1)).toBe(decoyNote);

    // Bound to the note inside the invoke, not to the one sitting at the end of the array.
    expect(screen.getByText(new RegExp(`Only note ${NOTE_ID}`))).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(`Only note ${decoyNote}`))).not.toBeInTheDocument();
  });

  it("fails rather than guessing when the invoke is not in the prepared call at all", async () => {
    // A prepared call that is not the transaction this package built: plausible felts, no gate
    // invoke among them. There is no note id to read, and inventing one would be the same bug.
    mocks.prepare.mockImplementation(async () => ({
      call: {
        contractAddress: POOL,
        entrypoint: "apply_actions",
        calldata: ["0x2", TOKEN, "0x53444835ec580000", "0x0", NOTE_ID],
      },
      proof: { data: ["0xproof"] },
    }));

    render(<Harness chain={defaultChainState()} amount={10n * ONE_STRK} />);
    await connectAndPay();

    await waitFor(() =>
      expect(screen.getByText(/could not find this SDK's privacy_invoke/)).toBeInTheDocument(),
    );
    expect(mocks.execute).not.toHaveBeenCalled();
    // No binding was formed, so nothing claims a note.
    expect(screen.queryByText(/^Only note/)).not.toBeInTheDocument();
  });

  it("blocks a wallet with no strk20PrepareInvoke before anything is attempted", async () => {
    // Braavos-shaped: it speaks the wallet API but not the prepare half.
    const account = { strk20Balances: async () => [] };
    render(<Harness chain={defaultChainState()} amount={10n * ONE_STRK} account={account} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Ready" }));
    await waitFor(() => expect(screen.getByText("STRK20 ready")).toBeInTheDocument());

    expect(screen.getByRole("button", { name: "Pay" })).toBeDisabled();
    expect(screen.getByText(/does not implement strk20PrepareInvoke/)).toBeInTheDocument();
    expect(screen.getByText(/anyone could redirect it/)).toBeInTheDocument();
  });

  it("reports a wallet that cannot resolve the placeholder, and signs nothing", async () => {
    // A wallet that hands the placeholder straight back cannot support a bound authorisation.
    mocks.prepare.mockImplementation(async (actions: Array<Record<string, unknown>>) =>
      preparedFrom(actions, "${openNoteIds[0]}"),
    );
    render(<Harness chain={defaultChainState()} amount={10n * ONE_STRK} />);
    await connectAndPay();

    await waitFor(() =>
      expect(screen.getByText(/does not resolve calldata at prepare time/)).toBeInTheDocument(),
    );
    expect(mocks.execute).not.toHaveBeenCalled();
    // Never a quiet downgrade to an authorisation any note could satisfy.
    expect(screen.queryByText(/can be redirected/)).not.toBeInTheDocument();
  });

  it("needs none on the fund leg, which reserves no note", async () => {
    render(
      <Harness
        chain={defaultChainState()}
        leg="fund"
        amount={10n * ONE_STRK}
        payeeSubjectKey={payeeKey.publicKey}
        payeeClaimPolicyId="ACCREDITED"
        expiresAt={Math.floor(Date.now() / 1000) + 3600}
      />,
    );
    await connectAndPay();

    await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));
    const actions = mocks.prepare.mock.calls.at(-1)?.[0] as Array<Record<string, unknown>>;
    // withdraw -> invoke, with no open note: nothing comes back in this transaction.
    expect(actions.map((action) => action["type"])).toEqual(["withdraw", "invoke"]);
  });

  it("generates a random settlement id rather than letting one be chosen", async () => {
    render(
      <Harness
        chain={defaultChainState()}
        leg="fund"
        amount={10n * ONE_STRK}
        payeeSubjectKey={payeeKey.publicKey}
        payeeClaimPolicyId="ACCREDITED"
        expiresAt={Math.floor(Date.now() / 1000) + 3600}
      />,
    );
    await connectAndPay();

    await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));
    const actions = mocks.prepare.mock.calls.at(-1)?.[0] as Array<Record<string, unknown>>;
    const calldata = actions[1]?.["calldata"] as string[];
    // Somewhere in the Fund calldata is an id with real entropy. An id is single-use forever and
    // is the only handle in the event log, so a memorable one can be burned ahead of you by a
    // stranger and links the funding to the claim to whatever record it came from.
    const widest = calldata
      .filter((item) => item.startsWith("0x"))
      .reduce((best, item) => (BigInt(item) > BigInt(best) ? item : best), "0x0");
    expect(BigInt(widest)).toBeGreaterThan(1n << 64n);
  });

  it("refuses a guessable settlement id even when one is passed in", async () => {
    render(
      <Harness
        chain={defaultChainState()}
        leg="fund"
        amount={10n * ONE_STRK}
        settlementId="0x2024"
        payeeSubjectKey={payeeKey.publicKey}
        payeeClaimPolicyId="ACCREDITED"
        expiresAt={Math.floor(Date.now() / 1000) + 3600}
      />,
    );
    await connectAndPay();

    // The SDK rejects it, and the hook reports the refusal instead of submitting.
    await waitFor(() => expect(screen.getByText(/entropy|guessable|random/i)).toBeInTheDocument());
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("blocks a fund that names no payee, which anyone could then claim", async () => {
    render(
      <Harness
        chain={defaultChainState()}
        leg="fund"
        amount={10n * ONE_STRK}
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

/**
 * The one thing this package must never do.
 *
 * `acceptAnyNoteAndAllowRedirection` signs an authorisation that any note can satisfy, which a
 * stranger can lift out of a reverted transaction's calldata and redirect. It is a decision only a
 * caller can make, deliberately, with that name in their own source. No hook, prop or default here
 * may reach it — including as a fallback when a prepare fails, which is exactly when reaching for
 * it would feel most reasonable.
 */
describe("unbound authorisations", () => {
  it("are unreachable from anywhere in this package", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");

    // Vitest runs from the package root, so this walks the whole published source tree.
    const files = await collectSources(join(process.cwd(), "src"));
    expect(files.length).toBeGreaterThan(20);

    for (const file of files) {
      // Comments are stripped first: several files explain at length *why* they never reach for
      // unbound mode, and that prose is the documentation, not a violation of it.
      const code = (await readFile(file, "utf8"))
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(code, `${file} reaches for unbound mode`).not.toMatch(
        /acceptAnyNoteAndAllowRedirection|NOTE_ANY/,
      );
    }
  });
});

async function collectSources(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await collectSources(full)));
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}
