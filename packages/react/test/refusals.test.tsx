/**
 * The refusal path, across several distinct codes.
 *
 * A refusal has to survive the whole journey intact: a node reports a short-string panic, the SDK
 * decodes it into a rule, and `<RefusalNotice>` names the code, explains which rule fired and says
 * who can fix it. These tests walk that journey for one refusal from each remedy class, because the
 * remedy is what a user actually acts on — telling a payer to "contact your issuer" when they
 * merely need to send less is the difference between a useful refusal and a dead end.
 */

import { screen } from "@testing-library/react";
import { decodeRefusal, refusalForCode } from "@cordon/sdk";
import { describe, expect, it } from "vitest";

import { RefusalNotice } from "../src/index.js";
import { defaultChainState, makeRpc, revertReason } from "./fixtures.js";
import { renderWithCordon } from "./harness.js";

const CASES = [
  {
    code: "CORDON_OVER_CAP",
    remedy: "payer",
    step: 10,
    expect: /Send less, or use a policy with a higher cap/,
  },
  {
    code: "CORDON_OVER_VELOCITY",
    remedy: "payer",
    step: 11,
    expect: /a new wallet does not reset it/,
  },
  {
    code: "CORDON_REVOKED",
    remedy: "issuer",
    step: 7,
    expect: /withdrawn this credential before its expiry/,
  },
  {
    code: "CORDON_EXPIRED",
    remedy: "issuer",
    step: 6,
    expect: /Ask the issuer for a fresh one/,
  },
  {
    code: "CORDON_NONCE_USED",
    remedy: "payer",
    step: 9,
    expect: /Sign again with a fresh nonce/,
  },
  {
    code: "CORDON_NO_POLICY",
    remedy: "operator",
    step: 2,
    expect: /Policies are immutable/,
  },
  {
    code: "CORDON_PAYEE_REQUIRED",
    remedy: "integrator",
    step: 2,
    expect: /Fund\/Claim flow/,
  },
] as const;

describe("decoding a revert into a refusal", () => {
  for (const testCase of CASES) {
    it(`recovers ${testCase.code} from a node's revert reason`, () => {
      const decoded = decodeRefusal(revertReason(testCase.code));
      expect(decoded.code).toBe(testCase.code);
      expect(decoded.remedy).toBe(testCase.remedy);
      expect(decoded.step).toBe(testCase.step);
    });
  }

  it("reports an unrecognised revert as unknown rather than inventing a rule", () => {
    const decoded = decodeRefusal("Failure reason: 0x753235365f737562204f766572666c6f77 ('u256_sub Overflow')");
    expect(decoded.code).toBe("UNKNOWN");
    expect(decoded.title).toContain("outside Cordon");
    expect(decoded.explanation).toContain("No Cordon panic code appears");
  });
});

describe("<RefusalNotice>", () => {
  for (const testCase of CASES) {
    it(`names ${testCase.code} and explains which rule fired`, () => {
      const refusal = refusalForCode(testCase.code);
      expect(refusal).toBeDefined();

      renderWithCordon(
        <RefusalNotice refusal={refusal ?? null} transactionHash="0xdeadbeef" />,
        { rpc: makeRpc(defaultChainState()) },
      );

      // The code itself, verbatim: an integrator has to be able to search for it.
      expect(screen.getByText(testCase.code)).toBeInTheDocument();
      expect(screen.getByText(refusal?.title ?? "")).toBeInTheDocument();
      expect(screen.getByText(testCase.expect)).toBeInTheDocument();
    });
  }

  it("renders inside an alert region so a refusal is announced", () => {
    renderWithCordon(<RefusalNotice refusal={refusalForCode("CORDON_OVER_CAP") ?? null} />, {
      rpc: makeRpc(defaultChainState()),
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("keeps the live region mounted when there is no refusal, so the next one announces", () => {
    renderWithCordon(<RefusalNotice refusal={null} />, { rpc: makeRpc(defaultChainState()) });
    const region = screen.getByRole("alert");
    expect(region).toBeInTheDocument();
    expect(region).toBeEmptyDOMElement();
  });

  it("links the reverted transaction on Voyager", () => {
    renderWithCordon(
      <RefusalNotice refusal={refusalForCode("CORDON_OVER_CAP") ?? null} transactionHash="0xfeed" />,
      { rpc: makeRpc(defaultChainState()) },
    );
    const link = screen.getByRole("link", { name: /Voyager/ });
    expect(link).toHaveAttribute("href", "https://voyager.online/tx/0xfeed");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("says plainly when a refusal was predicted and nothing was submitted", () => {
    renderWithCordon(
      <RefusalNotice refusal={refusalForCode("CORDON_OVER_CAP") ?? null} predicted />,
      { rpc: makeRpc(defaultChainState()) },
    );
    expect(screen.getByText(/no fee was charged/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Voyager/ })).not.toBeInTheDocument();
  });

  it("tells the user who can act on each refusal", () => {
    renderWithCordon(<RefusalNotice refusal={refusalForCode("CORDON_REVOKED") ?? null} />, {
      rpc: makeRpc(defaultChainState()),
    });
    expect(screen.getByText(/Only the credential's issuer can fix this/)).toBeInTheDocument();
  });
});
