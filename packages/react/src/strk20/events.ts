/**
 * Reading the gate's public record.
 *
 * `PolicyGate` emits an event on every leg that *passes*: `PolicyPassed` names the policy, the
 * token, the amount and the epoch. That is the honest half of a gate feed.
 *
 * **No subject key appears in any of these events, and that is deliberate.** An event carrying the
 * payer's pseudonym and one carrying the payee's, joinable through a settlement id, would publish
 * a permanent indexed edge between two counterparties and the exact amount that passed between
 * them. So the log records that a policy passed and how much moved, and stops there — which means
 * a feed built on it can show enforcement without showing anyone's payment graph.
 *
 * There is no refusal event, and there cannot be one. A refusal is a panic, a panic reverts the
 * whole pool transaction, and a reverted transaction emits nothing — that is precisely what makes
 * the gate a gate rather than a report. A refusal is visible only in the receipt of the
 * transaction that hit it, which is why `useGatedPayment` journals its own refusals into the
 * provider and `<GateFeed>` merges the two streams instead of pretending the chain hands them over
 * together. Every row says which half it came from.
 */

import { hash, num } from "starknet";
import { feltToShortString, toFelt, type Address, type Felt } from "@cordon/sdk";

import { available, unavailable } from "./balances.js";
import { localError } from "./errors.js";
import type { Reading } from "./types.js";

/** Event names the gate declares, and the selectors they hash to. */
export const GATE_EVENT_NAMES = [
  "PolicyPassed",
  "SettlementFunded",
  "SettlementClaimed",
  "SettlementRefunded",
  "DustSwept",
] as const;

export type GateEventName = (typeof GATE_EVENT_NAMES)[number];

/** `name -> selector`, computed once. */
export const GATE_EVENT_SELECTORS: Record<GateEventName, string> = Object.fromEntries(
  GATE_EVENT_NAMES.map((name) => [name, hash.getSelectorFromName(name)]),
) as Record<GateEventName, string>;

const SELECTOR_TO_NAME = new Map<bigint, GateEventName>(
  GATE_EVENT_NAMES.map((name) => [num.toBigInt(GATE_EVENT_SELECTORS[name]), name]),
);

/** What every gate event carries, whichever it is. */
interface GateEventBase {
  token: Address;
  amount: bigint;
  transactionHash: string;
  blockNumber: number | null;
}

/** A gate event, decoded. `kind` discriminates; the rest is per-event. */
export type GateEvent =
  | (GateEventBase & {
      kind: "PolicyPassed";
      policyId: Felt;
      /** Decoded short string when the id is one, otherwise the raw felt. */
      policyLabel: string;
      epoch: bigint;
    })
  | (GateEventBase & { kind: "SettlementFunded"; settlementId: Felt })
  | (GateEventBase & { kind: "SettlementClaimed"; settlementId: Felt })
  | (GateEventBase & { kind: "SettlementRefunded"; settlementId: Felt })
  | (GateEventBase & { kind: "DustSwept"; to: Address });

/** The raw event shape a node returns, reduced to what is needed here. */
export type RawEvent = {
  keys: string[];
  data: string[];
  transaction_hash?: string;
  block_number?: number;
};

/** The event filter these reads build, spelled out so a test double can be typed against it. */
export type GateEventFilter = {
  address: string;
  from_block: { block_number: number };
  to_block: "latest";
  keys: string[][];
  chunk_size: number;
  continuation_token?: string;
};

/**
 * The subset of a provider these reads need. `RpcProvider` satisfies it.
 *
 * Declared as a method rather than a property so parameter types stay bivariant: Starknet.js
 * types `getEvents` against its own full `EventFilter` union, and a narrower filter is exactly
 * what this module passes.
 */
export interface EventProvider {
  getEvents(
    filter: GateEventFilter,
  ): Promise<{ events?: RawEvent[]; continuation_token?: string }>;
  /**
   * The chain head, used to bound the block range a read walks.
   *
   * Optional because a caller that pins `fromBlock` never needs it, and because a stub provider in
   * a test should not have to grow a method to answer one question.
   */
  getBlockLatestAccepted?(): Promise<{ block_number: number }>;
}

/**
 * Decode one raw event.
 *
 * Returns `null` for anything that is not a gate event this package knows, or whose payload is
 * the wrong shape — a partially-decoded event rendered as if it were whole is exactly the kind of
 * fabricated state this package refuses to produce.
 */
export function decodeGateEvent(raw: RawEvent): GateEvent | null {
  const first = raw.keys[0];
  if (first === undefined) return null;
  let name: GateEventName | undefined;
  try {
    name = SELECTOR_TO_NAME.get(num.toBigInt(first));
  } catch {
    return null;
  }
  if (!name) return null;

  // Every event is `[selector, one keyed felt]` plus data starting with the token and, for all but
  // the sweep, the amount in the same position.
  const keyed = raw.keys[1];
  const token = raw.data[0];
  if (keyed === undefined || token === undefined) return null;

  const base: GateEventBase = {
    token: toFelt(token),
    amount: 0n,
    transactionHash: raw.transaction_hash ?? "",
    blockNumber: typeof raw.block_number === "number" ? raw.block_number : null,
  };

  try {
    switch (name) {
      case "PolicyPassed": {
        const [amount, epoch] = [raw.data[1], raw.data[2]];
        if (amount === undefined || epoch === undefined) return null;
        const policyId = toFelt(keyed);
        return {
          ...base,
          kind: "PolicyPassed",
          amount: num.toBigInt(amount),
          policyId,
          policyLabel: feltToShortString(policyId) ?? policyId,
          epoch: num.toBigInt(epoch),
        };
      }
      case "SettlementFunded":
      case "SettlementClaimed":
      case "SettlementRefunded": {
        const amount = raw.data[1];
        if (amount === undefined) return null;
        return {
          ...base,
          kind: name,
          amount: num.toBigInt(amount),
          settlementId: toFelt(keyed),
        };
      }
      case "DustSwept": {
        // The sweep keys the token and puts the recipient first in the data.
        const [to, amount] = [raw.data[0], raw.data[1]];
        if (to === undefined || amount === undefined) return null;
        return {
          ...base,
          kind: "DustSwept",
          token: toFelt(keyed),
          to: toFelt(to),
          amount: num.toBigInt(amount),
        };
      }
    }
  } catch {
    // A felt that will not parse means the event is not what its selector claims. Drop it rather
    // than render half of it.
    return null;
  }
}

/**
 * How far back an unpinned read looks, in blocks.
 *
 * Mainnet blocks are roughly half a minute apart, so this is about three weeks — long enough to
 * hold a deployment's history, short enough that the node can walk it in a few pages.
 */
export const DEFAULT_EVENT_LOOKBACK_BLOCKS = 60_000;

export type ReadGateEventsOptions = {
  /** Restrict to these event kinds. Defaults to all of them. */
  kinds?: readonly GateEventName[];
  /**
   * The first block to look at. Defaults to `head - lookbackBlocks`.
   *
   * Pin it to the gate's deploy block when you know it: a range that starts there is exact, and
   * the read costs one page instead of several.
   */
  fromBlock?: number;
  /** Blocks to look back from the head when `fromBlock` is not given. */
  lookbackBlocks?: number;
  /** Most events to return, newest first. Defaults to 50. */
  limit?: number;
  /** Page size asked of the node. Defaults to 100. */
  chunkSize?: number;
  /** Most pages to walk, so a busy gate cannot hang a render. Defaults to 10. */
  maxPages?: number;
};

/**
 * Read gate events, newest first.
 *
 * Two things about pagination decide whether this function tells the truth.
 *
 * The node returns events **oldest first** within the range and hands back a continuation token,
 * so walking a bounded number of pages and stopping yields the *oldest* events, not the newest.
 * A filter starting at block zero therefore does not return "the last few decisions" — on a chain
 * with fourteen million blocks and a node that pages in eighty-thousand-block windows, it returns
 * an empty list from the chain's prehistory and looks exactly like a gate that has never passed
 * anything. So the range is bounded near the head instead, and a walk that runs out of pages
 * before reaching the head is reported as **unavailable** rather than as a short answer: the
 * caller asked for the newest events and would be handed events that are not.
 *
 * An empty list from a fully-walked range is a true answer and comes back as one.
 */
export async function readGateEvents(
  provider: EventProvider,
  gate: Address,
  options: ReadGateEventsOptions = {},
): Promise<Reading<GateEvent[]>> {
  const kinds = options.kinds ?? GATE_EVENT_NAMES;
  const limit = options.limit ?? 50;
  const chunkSize = options.chunkSize ?? 100;
  const maxPages = options.maxPages ?? 10;
  const lookback = options.lookbackBlocks ?? DEFAULT_EVENT_LOOKBACK_BLOCKS;

  const keys: string[][] = [kinds.map((kind) => GATE_EVENT_SELECTORS[kind])];
  const collected: GateEvent[] = [];
  let continuation: string | undefined;

  try {
    let fromBlock = options.fromBlock;
    if (fromBlock === undefined) {
      if (provider.getBlockLatestAccepted) {
        const head = await provider.getBlockLatestAccepted();
        fromBlock = Math.max(0, head.block_number - lookback);
      } else {
        // Without a head to measure from there is no honest default. Zero is what the caller
        // would have got before, and it is the one value that reliably produces a wrong answer.
        return unavailable(
          localError(
            "this provider cannot report the chain head, so the block range to scan for gate " +
              "events cannot be bounded. Pass fromBlock.",
          ),
        );
      }
    }

    for (let page = 0; page < maxPages; page += 1) {
      const response = await provider.getEvents({
        address: gate,
        from_block: { block_number: fromBlock },
        to_block: "latest",
        keys,
        chunk_size: chunkSize,
        ...(continuation !== undefined ? { continuation_token: continuation } : {}),
      });
      for (const raw of response.events ?? []) {
        const decoded = decodeGateEvent(raw);
        if (decoded) collected.push(decoded);
      }
      continuation = response.continuation_token;
      if (!continuation) break;
    }

    if (continuation !== undefined) {
      return unavailable(
        localError(
          `the node did not reach the chain head within ${maxPages} pages from block ` +
            `${fromBlock}, so the newest decisions were not read. Narrow the range with ` +
            "fromBlock or lookbackBlocks, or raise maxPages.",
        ),
      );
    }
  } catch (error) {
    return unavailable(error);
  }

  collected.reverse();
  return available(collected.slice(0, limit));
}

/** Convenience: only the passes, which is what a public gate monitor mostly shows. */
export async function readPolicyPassed(
  provider: EventProvider,
  gate: Address,
  options: Omit<ReadGateEventsOptions, "kinds"> = {},
): Promise<Reading<GateEvent[]>> {
  const reading = await readGateEvents(provider, gate, { ...options, kinds: ["PolicyPassed"] });
  if (!reading.available) return reading;
  const passes = reading.value.filter((event) => event.kind === "PolicyPassed");
  if (passes.length === 0 && reading.value.length > 0) {
    return unavailable(
      localError("the node returned gate events but none decoded as PolicyPassed"),
    );
  }
  return available(passes);
}
