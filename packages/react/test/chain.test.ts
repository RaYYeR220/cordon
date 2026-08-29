/**
 * The chain layer, without React.
 *
 * These cover the parts that turn what a node said into something a component can render honestly:
 * error normalisation, event decoding, and the reads that have to distinguish "the answer is no"
 * from "there was no answer".
 */

import { describe, expect, it } from "vitest";
import { hash } from "starknet";

import {
  decodeGateEvent,
  describeError,
  extractRevert,
  formatUnits,
  isNotImplemented,
  isUserRefusal,
  normalizeError,
  parseBalanceEntry,
  parseBalances,
  parseUnits,
  readGateEvents,
  readPolicy,
  readRegistries,
  relativeTime,
  resolveConfig,
  shortHex,
  voyagerTxUrl,
} from "../src/strk20/index.js";
import {
  GATE,
  ONE_STRK,
  POLICY_REGISTRY,
  TOKEN,
  defaultChainState,
  makeRpc,
  policyPassedEvent,
  revertReason,
  settlementFundedEvent,
} from "./fixtures.js";

describe("normalizeError", () => {
  it("names a wallet-API error code", () => {
    const error = normalizeError(Object.assign(new Error("bad payload"), { code: 114 }));
    expect(error.source).toBe("wallet");
    expect(error.name).toBe("INVALID_REQUEST_PAYLOAD");
    expect(error.message).toBe("bad payload");
  });

  it("names a node error code", () => {
    const error = normalizeError({ code: 41, message: "execution error" });
    expect(error.source).toBe("rpc");
    expect(error.name).toBe("TRANSACTION_EXECUTION_ERROR");
  });

  it("keeps an unrecognised error's own words and admits it does not know the source", () => {
    const error = normalizeError(new Error("something the node made up"));
    expect(error.source).toBe("unknown");
    expect(error.code).toBeNull();
    expect(error.message).toBe("something the node made up");
  });

  it("never throws, whatever it is handed", () => {
    for (const value of [undefined, null, 0, "", [], { a: { b: {} } }]) {
      expect(() => normalizeError(value)).not.toThrow();
    }
  });

  it("lifts a panic code out of a revert reason", () => {
    const error = normalizeError(new Error(revertReason("CORDON_OVER_CAP")));
    expect(error.panicCodes).toContain("CORDON_OVER_CAP");
    expect(describeError(error)).toContain("CORDON_OVER_CAP");
  });

  it("decodes a panic code a node reported only as a felt", () => {
    const { panicCodes } = extractRevert(
      "Failure reason: 0x434f52444f4e5f5245564f4b4544",
    );
    expect(panicCodes).toContain("CORDON_REVOKED");
  });

  it("recognises the wallets that answer 'Not implemented' instead of a spec code", () => {
    expect(isNotImplemented(normalizeError(new Error("Not implemented")))).toBe(true);
    expect(isNotImplemented(normalizeError({ code: -32601, message: "method not found" }))).toBe(
      true,
    );
    expect(isNotImplemented(normalizeError(new Error("insufficient balance")))).toBe(false);
  });

  it("recognises a declined prompt", () => {
    expect(isUserRefusal(normalizeError({ code: 113, message: "nope" }))).toBe(true);
    expect(isUserRefusal(normalizeError(new Error("User rejected the request")))).toBe(true);
  });
});

describe("balance parsing", () => {
  it("accepts both the spec's `balance` and the `amount` wallets have shipped", () => {
    expect(parseBalanceEntry({ token: "0x1", balance: "0x64" })?.amount).toBe("0x64");
    expect(parseBalanceEntry({ token: "0x1", amount: 100 })?.amount).toBe("0x64");
  });

  it("drops an entry it cannot read rather than reporting it as zero", () => {
    expect(parseBalanceEntry({ token: 5, balance: "0x1" })).toBeNull();
    expect(parseBalanceEntry({ token: "0x1" })).toBeNull();
    expect(parseBalances([{ token: "0x1", balance: "0x2" }, "nonsense"])).toHaveLength(1);
  });

  it("reports an unreadable response as null, not as an empty list", () => {
    expect(parseBalances("not a list")).toBeNull();
    expect(parseBalances({ value: [] })).toEqual([]);
  });
});

describe("decodeGateEvent", () => {
  it("decodes a PolicyPassed", () => {
    const event = decodeGateEvent(policyPassedEvent({ amount: 3n * ONE_STRK, epoch: 9n }));
    expect(event).toMatchObject({
      kind: "PolicyPassed",
      policyLabel: "ACCREDITED",
      amount: 3n * ONE_STRK,
      epoch: 9n,
      blockNumber: 1234,
    });
  });

  it("decodes a SettlementFunded", () => {
    const event = decodeGateEvent(settlementFundedEvent({ amount: 2n * ONE_STRK }));
    expect(event).toMatchObject({ kind: "SettlementFunded", amount: 2n * ONE_STRK });
  });

  it("ignores an event from another contract rather than half-decoding it", () => {
    expect(
      decodeGateEvent({ keys: [hash.getSelectorFromName("Transfer"), "0x1"], data: ["0x2"] }),
    ).toBeNull();
  });

  it("drops a gate event whose payload is short", () => {
    expect(
      decodeGateEvent({ keys: [hash.getSelectorFromName("PolicyPassed"), "0x1"], data: [TOKEN] }),
    ).toBeNull();
  });

  it("drops an event with no keys at all", () => {
    expect(decodeGateEvent({ keys: [], data: [] })).toBeNull();
  });
});

describe("reads that have to tell 'no' from 'no answer'", () => {
  it("reports a policy that was never published as missing", async () => {
    const state = defaultChainState();
    state.policy = null;
    const reading = await readPolicy(makeRpc(state), POLICY_REGISTRY, "ACCREDITED");
    expect(reading.available).toBe(false);
    if (!reading.available) expect(reading.missing).toBe(true);
  });

  it("reports an unreachable node as unavailable, not missing", async () => {
    const state = defaultChainState();
    state.policyError = new Error("ECONNREFUSED");
    const reading = await readPolicy(makeRpc(state), POLICY_REGISTRY, "ACCREDITED");
    expect(reading.available).toBe(false);
    if (!reading.available) expect(reading.missing).toBe(false);
  });

  it("does not throw when the gate answers with something that is not a field element", async () => {
    const rpc = makeRpc(defaultChainState());
    const overPrime = `0x${"f".repeat(64)}`;
    rpc.callContract.mockResolvedValueOnce([overPrime, overPrime, overPrime]);
    const reading = await readRegistries(rpc, GATE);
    expect(reading.available).toBe(false);
    if (!reading.available) expect(reading.error.message).toMatch(/unreadable registry addresses/);
  });

  it("reports the wrong number of registry addresses rather than reading past the end", async () => {
    const rpc = makeRpc(defaultChainState());
    rpc.callContract.mockResolvedValueOnce(["0x1", "0x2"]);
    const reading = await readRegistries(rpc, GATE);
    expect(reading.available).toBe(false);
  });

  it("reports an events read that failed as unavailable rather than as an empty gate", async () => {
    const state = defaultChainState();
    state.eventsError = new Error("TOO_MANY_BLOCKS_BACK");
    const reading = await readGateEvents(makeRpc(state), GATE);
    expect(reading.available).toBe(false);
  });

  it("stops walking pages so a busy gate cannot hang a render, and says it did", async () => {
    // A node returns events oldest first inside the range, so a walk that runs out of pages holds
    // the OLDEST events and not the newest. Handing those back from a function that promises
    // "newest first" is a wrong answer, not a short one — so it is reported as unavailable.
    const state = defaultChainState();
    const rpc = makeRpc(state);
    rpc.getEvents.mockResolvedValue({
      events: [policyPassedEvent()],
      continuation_token: "more",
    });
    const reading = await readGateEvents(rpc, GATE, { maxPages: 3 });
    expect(reading.available).toBe(false);
    expect(rpc.getEvents).toHaveBeenCalledTimes(3);
    if (!reading.available) expect(reading.error.message).toContain("chain head");
  });

  it("bounds an unpinned range against the head instead of starting at block zero", async () => {
    // Starting at zero is the failure that looks like success: on a chain with millions of blocks
    // and a node that pages in fixed windows, the walk never reaches the deployment and returns
    // an empty list indistinguishable from a gate that has passed nothing.
    const state = defaultChainState();
    const rpc = makeRpc(state);
    await readGateEvents(rpc, GATE, { lookbackBlocks: 1_000 });
    expect(rpc.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({ from_block: { block_number: state.blockNumber - 1_000 } }),
    );
  });

  it("refuses to guess a range when the provider cannot report a head", async () => {
    const rpc = makeRpc(defaultChainState());
    const { getBlockLatestAccepted: _omitted, ...headless } = rpc;
    const reading = await readGateEvents(headless, GATE);
    expect(reading.available).toBe(false);
    if (!reading.available) expect(reading.error.message).toContain("fromBlock");
    expect(rpc.getEvents).not.toHaveBeenCalled();
  });

  it("takes a pinned fromBlock without asking for the head", async () => {
    const rpc = makeRpc(defaultChainState());
    const reading = await readGateEvents(rpc, GATE, { fromBlock: 1_400_000 });
    expect(reading.available).toBe(true);
    expect(rpc.getBlockLatestAccepted).not.toHaveBeenCalled();
    expect(rpc.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({ from_block: { block_number: 1_400_000 } }),
    );
  });
});

describe("configuration", () => {
  it("fills in the mainnet defaults around a bare gate address", () => {
    const config = resolveConfig({ gateAddress: GATE });
    expect(config.gateAddress).toBe(GATE);
    expect(config.chainId).toBe("0x534e5f4d41494e");
    expect(config.tokenDecimals).toBe(18);
    expect(config.rpcUrl).toMatch(/^https:\/\//);
  });

  it("points at the right explorer per chain", () => {
    expect(voyagerTxUrl("0x1")).toBe("https://voyager.online/tx/0x1");
    expect(voyagerTxUrl("0x1", "0x534e5f5345504f4c4941")).toBe(
      "https://sepolia.voyager.online/tx/0x1",
    );
  });
});

describe("display helpers", () => {
  it("formats and parses amounts without losing precision", () => {
    expect(formatUnits(ONE_STRK)).toBe("1");
    expect(formatUnits(1500000000000000000n)).toBe("1.5");
    expect(formatUnits(1n)).toBe("0.000000000000000001");
    expect(parseUnits("1.5")).toBe(1500000000000000000n);
    expect(parseUnits("0")).toBe(0n);
  });

  it("refuses an amount it cannot represent rather than rounding it", () => {
    expect(() => parseUnits("1.0000000000000000001")).toThrow(RangeError);
    expect(() => parseUnits("-1")).toThrow(TypeError);
  });

  it("shortens a hex string without hiding both ends", () => {
    expect(shortHex("0x1234567890abcdef")).toBe("0x1234…cdef");
    expect(shortHex("0x12")).toBe("0x12");
  });

  it("says when something happens in words", () => {
    expect(relativeTime(90)).toBe("in 2 minutes");
    expect(relativeTime(-3600)).toBe("1 hour ago");
    expect(relativeTime(172800)).toBe("in 2 days");
  });
});
