/**
 * Reading the pool from the chain rather than trusting configuration.
 *
 * `pool_address` is inside every action hash and is checked twice on chain — against the gate's
 * stored pool and against the caller. A configured value that has drifted produces signatures
 * nobody can use, and the user finds out by paying for a reverted transaction. So the supported
 * path asks the gate, and a disagreement is a loud failure before anything is signed.
 */

import { describe, expect, it } from "vitest";
import {
  GateContextError,
  assertGateContext,
  createGateContext,
  fetchGateContext,
  type GateReader,
} from "../src/index.js";
import { FIXTURE_GATE, FIXTURE_POOL } from "./fixtures.js";

const OTHER_POOL = "0x0111222333444555666777888999aaabbbcccdddeeefff0001112223334445";

function reader(overrides: Partial<GateReader> = {}): GateReader {
  return {
    getChainId: async () => "SN_MAIN",
    callContract: async () => [FIXTURE_POOL],
    ...overrides,
  };
}

describe("fetchGateContext", () => {
  it("asks the gate which pool it serves", async () => {
    const calls: unknown[] = [];
    const context = await fetchGateContext(
      reader({
        callContract: async (call) => {
          calls.push(call);
          return [FIXTURE_POOL];
        },
      }),
      FIXTURE_GATE,
    );

    expect(calls).toEqual([
      { contractAddress: `0x${BigInt(FIXTURE_GATE).toString(16)}`, entrypoint: "privacy_pool", calldata: [] },
    ]);
    expect(context).toEqual(
      createGateContext({ chainId: "SN_MAIN", gate: FIXTURE_GATE, pool: FIXTURE_POOL }),
    );
  });

  it("accepts a provider that wraps the result", async () => {
    const context = await fetchGateContext(
      reader({ callContract: async () => ({ result: [FIXTURE_POOL] }) }),
      FIXTURE_GATE,
    );
    expect(context.pool).toBe(`0x${BigInt(FIXTURE_POOL).toString(16)}`);
  });

  it("fails loudly when the configured pool is not the one the gate serves", async () => {
    await expect(
      fetchGateContext(reader(), FIXTURE_GATE, { expectedPool: OTHER_POOL }),
    ).rejects.toThrow(GateContextError);
    await expect(
      fetchGateContext(reader(), FIXTURE_GATE, { expectedPool: OTHER_POOL }),
    ).rejects.toThrow(/CORDON_BAD_POOL/);
  });

  it("passes when the configured pool agrees", async () => {
    const context = await fetchGateContext(reader(), FIXTURE_GATE, { expectedPool: FIXTURE_POOL });
    expect(context.pool).toBe(`0x${BigInt(FIXTURE_POOL).toString(16)}`);
  });

  it("says the address is not a gate rather than returning a broken context", async () => {
    await expect(
      fetchGateContext(reader({ callContract: async () => [] }), FIXTURE_GATE),
    ).rejects.toThrow(/not a PolicyGate/);

    await expect(
      fetchGateContext(reader({ callContract: async () => ["0x0"] }), FIXTURE_GATE),
    ).rejects.toThrow(/answered zero/);
  });

  it("explains a failed call instead of leaking a raw provider error", async () => {
    await expect(
      fetchGateContext(
        reader({
          callContract: async () => {
            throw new Error("Contract not found");
          },
        }),
        FIXTURE_GATE,
      ),
    ).rejects.toThrow(/could not read privacy_pool\(\).*Contract not found/s);
  });

  it("refuses a provider with no chain id", async () => {
    await expect(
      fetchGateContext(reader({ getChainId: async () => "" }), FIXTURE_GATE),
    ).rejects.toThrow(/no chain id/);
  });
});

describe("assertGateContext", () => {
  const context = createGateContext({
    chainId: "SN_MAIN",
    gate: FIXTURE_GATE,
    pool: FIXTURE_POOL,
  });

  it("passes when the chain agrees with the context", async () => {
    await expect(assertGateContext(reader(), context)).resolves.toMatchObject({
      chainId: context.chainId,
    });
  });

  it("catches a wallet that has switched network under the application", async () => {
    await expect(
      assertGateContext(reader({ getChainId: async () => "SN_SEPOLIA" }), context),
    ).rejects.toThrow(/CORDON_BAD_SUBJECT_SIG/);
  });

  it("catches a gate that serves a different pool", async () => {
    await expect(
      assertGateContext(reader({ callContract: async () => [OTHER_POOL] }), context),
    ).rejects.toThrow(GateContextError);
  });
});
