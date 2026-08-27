/**
 * Test fixtures: a fake node, real credentials, real signatures.
 *
 * The signatures here are genuine — `issueCredential` signs with a real STARK-curve key and the
 * package verifies against it. Faking that would make the credential tests prove nothing. What is
 * faked is the node: `callContract` answers from a plain object, so a test can say "the revocation
 * registry is unreachable" by making one entrypoint throw.
 */

import {
  createPolicy,
  issueCredential,
  generateSubjectKeypair,
  policyCalldata,
  shortStringToFelt,
  toFelt,
  type Credential,
  type Policy,
  type PolicyInput,
  type SubjectKeypair,
} from "@cordon/sdk";
import { hash, num } from "starknet";

import type { RawEvent } from "../src/strk20/index.js";
import { vi } from "vitest";

export const GATE = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
export const ISSUER_REGISTRY = "0x0111111111111111111111111111111111111111111111111111111111111111";
export const REVOCATION_REGISTRY = "0x0222222222222222222222222222222222222222222222222222222222222222";
export const POLICY_REGISTRY = "0x0333333333333333333333333333333333333333333333333333333333333333";
export const TOKEN = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
export const PAYEE = "0x0444444444444444444444444444444444444444444444444444444444444444";

export const issuerKey: SubjectKeypair = generateSubjectKeypair();
export const subjectKey: SubjectKeypair = generateSubjectKeypair();

const ONE_STRK = 10n ** 18n;
export { ONE_STRK };

/** A credential that is genuinely signed, and by default genuinely valid. */
export function makeCredential(
  overrides: {
    claim?: string;
    expiresAt?: number;
    credentialId?: string;
    issuerId?: string;
    subjectPublicKey?: string;
    signWith?: string;
  } = {},
): Credential {
  return issueCredential(
    {
      issuerId: shortStringToFelt(overrides.issuerId ?? "ACME"),
      credentialId: shortStringToFelt(overrides.credentialId ?? "CRED_1"),
      subjectPublicKey: overrides.subjectPublicKey ?? subjectKey.publicKey,
      claim: shortStringToFelt(overrides.claim ?? "ACCREDITED"),
      expiresAt: overrides.expiresAt ?? Math.floor(Date.now() / 1000) + 86_400,
    },
    overrides.signWith ?? issuerKey.privateKey,
  );
}

export function makePolicy(overrides: Partial<PolicyInput> = {}): Policy {
  return createPolicy({
    requiredClaim: shortStringToFelt("ACCREDITED"),
    issuerId: 0,
    maxAmount: 100n * ONE_STRK,
    epochLength: 3600,
    maxPerEpoch: 500n * ONE_STRK,
    ...overrides,
  });
}

/** What the fake node knows. Every field can be replaced, or set to throw. */
export interface ChainState {
  policy: Policy | null;
  /** Raised instead of answering `get_policy`. Use it to test missing vs unavailable. */
  policyError: Error | null;
  issuerPublicKey: string | null;
  issuerActive: boolean | null;
  revoked: boolean | null;
  nonceUsed: boolean;
  epoch: bigint;
  epochSpend: bigint | null;
  registriesError: Error | null;
  events: Array<{ keys: string[]; data: string[]; transaction_hash: string; block_number: number }>;
  eventsError: Error | null;
  /** The receipt `waitForTransaction` resolves with. */
  receipt: Record<string, unknown>;
  receiptError: Error | null;
}

export function defaultChainState(): ChainState {
  return {
    policy: makePolicy(),
    policyError: null,
    issuerPublicKey: issuerKey.publicKey,
    issuerActive: true,
    revoked: false,
    nonceUsed: false,
    epoch: 7n,
    epochSpend: 10n * ONE_STRK,
    registriesError: null,
    events: [],
    eventsError: null,
    receipt: { execution_status: "SUCCEEDED", finality_status: "ACCEPTED_ON_L2", events: [] },
    receiptError: null,
  };
}

function felt(value: bigint | number | boolean): string {
  if (typeof value === "boolean") return value ? "0x1" : "0x0";
  return num.toHex(value);
}

/** A provider that answers from a `ChainState`. Mutate the state between renders to drive a test. */
export function makeRpc(state: ChainState) {
  const callContract = vi.fn(async ({ entrypoint }: { entrypoint: string }) => {
    switch (entrypoint) {
      case "registries":
        if (state.registriesError) throw state.registriesError;
        return [ISSUER_REGISTRY, REVOCATION_REGISTRY, POLICY_REGISTRY];
      case "get_policy":
        if (state.policyError) throw state.policyError;
        if (!state.policy) throw new Error("Failure reason: 0x434f52444f4e5f4e4f5f504f4c494359");
        return policyCalldata(state.policy);
      case "policy_exists":
        return [felt(state.policy !== null)];
      case "issuer_public_key":
        if (state.issuerPublicKey === null) throw new Error("node unreachable");
        return [state.issuerPublicKey];
      case "is_issuer_active":
        if (state.issuerActive === null) throw new Error("node unreachable");
        return [felt(state.issuerActive)];
      case "is_revoked":
        if (state.revoked === null) throw new Error("the revocation registry did not answer");
        return [felt(state.revoked)];
      case "is_nonce_used":
        return [felt(state.nonceUsed)];
      case "current_epoch":
        return [felt(state.epoch)];
      case "epoch_spend":
        if (state.epochSpend === null) throw new Error("the velocity counter did not answer");
        return [felt(state.epochSpend)];
      case "committed_balance":
        return ["0x0"];
      default:
        throw new Error(`unexpected entrypoint ${entrypoint}`);
    }
  });

  const getEvents = vi.fn(
    async (): Promise<{ events?: RawEvent[]; continuation_token?: string }> => {
      if (state.eventsError) throw state.eventsError;
      return { events: state.events };
    },
  );

  const waitForTransaction = vi.fn(async () => {
    if (state.receiptError) throw state.receiptError;
    return state.receipt;
  });

  return { callContract, getEvents, waitForTransaction, state };
}

/**
 * A `PolicyPassed` event as a node would return it.
 *
 * Note what is not in it: no subject key. The gate deliberately keeps pseudonyms out of its log,
 * so a feed built on these events can show enforcement without publishing anyone's payment graph.
 */
export function policyPassedEvent(params: {
  policyId?: string;
  amount?: bigint;
  epoch?: bigint;
  transactionHash?: string;
  blockNumber?: number;
} = {}) {
  return {
    keys: [
      hash.getSelectorFromName("PolicyPassed"),
      toFelt(params.policyId ?? shortStringToFelt("ACCREDITED")),
    ],
    data: [TOKEN, felt(params.amount ?? 5n * ONE_STRK), felt(params.epoch ?? 7n)],
    transaction_hash: params.transactionHash ?? "0xabc123",
    block_number: params.blockNumber ?? 1234,
  };
}

/** A `SettlementFunded` event as a node would return it. */
export function settlementFundedEvent(params: {
  settlementId?: string;
  amount?: bigint;
  transactionHash?: string;
  blockNumber?: number;
} = {}) {
  return {
    keys: [
      hash.getSelectorFromName("SettlementFunded"),
      toFelt(params.settlementId ?? "0x9001"),
    ],
    data: [TOKEN, felt(params.amount ?? 2n * ONE_STRK)],
    transaction_hash: params.transactionHash ?? "0xabc456",
    block_number: params.blockNumber ?? 1240,
  };
}

/** A revert reason in the shape a node reports it, carrying one Cordon panic code. */
export function revertReason(code: string): string {
  const felts = shortStringToFelt(code);
  return `Transaction execution has failed:\nFailure reason: ${felts} ('${code}')`;
}
