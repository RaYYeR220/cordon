/**
 * Error normalisation.
 *
 * The rule for the whole app: show what the wallet or the node actually said.
 * Nothing here invents a message, and nothing swallows one — an unrecognised
 * error keeps its original text and reports `source: "unknown"`.
 */

import { shortString } from "starknet";
import type { Strk20NormalizedError } from "./types";

/** Wallet-API error codes (SNIP-29 / SNIP-36). */
export const WALLET_ERROR_NAMES: Record<number, string> = {
  111: "NOT_ERC20",
  112: "UNLISTED_NETWORK",
  113: "USER_REFUSED_OP",
  114: "INVALID_REQUEST_PAYLOAD",
  115: "ACCOUNT_ALREADY_DEPLOYED",
  116: "DEPLOYMENT_DATA_NOT_AVAILABLE",
  117: "CHAIN_ID_NOT_SUPPORTED",
  118: "NOT_REGISTERED",
  119: "INSUFFICIENT_PRIVATE_BALANCE",
  120: "PRIVACY_LEAK",
  162: "API_VERSION_NOT_SUPPORTED",
  163: "UNKNOWN_ERROR",
};

/** Starknet node JSON-RPC error codes. */
export const RPC_ERROR_NAMES: Record<number, string> = {
  1: "FAILED_TO_RECEIVE_TXN",
  10: "NO_TRACE_AVAILABLE",
  20: "CONTRACT_NOT_FOUND",
  21: "ENTRYPOINT_NOT_FOUND",
  24: "BLOCK_NOT_FOUND",
  27: "INVALID_TXN_INDEX",
  28: "CLASS_HASH_NOT_FOUND",
  29: "TXN_HASH_NOT_FOUND",
  31: "PAGE_SIZE_TOO_BIG",
  32: "NO_BLOCKS",
  33: "INVALID_CONTINUATION_TOKEN",
  34: "TOO_MANY_KEYS_IN_FILTER",
  40: "CONTRACT_ERROR",
  41: "TRANSACTION_EXECUTION_ERROR",
  42: "STORAGE_PROOF_NOT_SUPPORTED",
  51: "CLASS_ALREADY_DECLARED",
  52: "INVALID_TRANSACTION_NONCE",
  53: "INSUFFICIENT_RESOURCES_FOR_VALIDATE",
  54: "INSUFFICIENT_ACCOUNT_BALANCE",
  55: "VALIDATION_FAILURE",
  56: "COMPILATION_FAILED",
  57: "CONTRACT_CLASS_SIZE_IS_TOO_LARGE",
  58: "NON_ACCOUNT",
  59: "DUPLICATE_TX",
  60: "COMPILED_CLASS_HASH_MISMATCH",
  61: "UNSUPPORTED_TX_VERSION",
  62: "UNSUPPORTED_CONTRACT_CLASS_VERSION",
  63: "UNEXPECTED_ERROR",
  64: "REPLACEMENT_TRANSACTION_UNDERPRICED",
  65: "FEE_BELOW_MINIMUM",
  66: "INVALID_SUBSCRIPTION_ID",
  67: "TOO_MANY_ADDRESSES_IN_FILTER",
  68: "TOO_MANY_BLOCKS_BACK",
  69: "INVALID_PROOF",
  100: "COMPILATION_ERROR",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Pull a numeric JSON-RPC code out of whatever the caller threw. */
function extractCode(error: unknown): number | null {
  if (!isRecord(error)) return null;
  const direct = error.code;
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  if (typeof direct === "string" && /^-?\d+$/.test(direct)) return Number(direct);
  const base = error.baseError;
  if (isRecord(base) && typeof base.code === "number") return base.code;
  const nested = error.error;
  if (isRecord(nested) && typeof nested.code === "number") return nested.code;
  return null;
}

function extractMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (isRecord(error)) {
    if (typeof error.message === "string" && error.message) return error.message;
    const base = error.baseError;
    if (isRecord(base) && typeof base.message === "string") return base.message;
  }
  if (error === undefined) return "undefined error";
  if (error === null) return "null error";
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function extractData(error: unknown): unknown {
  if (!isRecord(error)) return null;
  if (error.data !== undefined) return error.data;
  const base = error.baseError;
  if (isRecord(base) && base.data !== undefined) return base.data;
  const nested = error.error;
  if (isRecord(nested) && nested.data !== undefined) return nested.data;
  return null;
}

/** Flatten anything a node may put in `data` into searchable text. */
function stringifyData(data: unknown): string {
  if (data === null || data === undefined) return "";
  if (typeof data === "string") return data;
  if (isRecord(data)) {
    const nested =
      typeof data.revert_error === "string"
        ? data.revert_error
        : typeof data.execution_error === "string"
          ? data.execution_error
          : null;
    if (nested) return nested;
  }
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

/**
 * Decode a felt that encodes a Cairo short string. Returns null when the felt
 * is not printable ASCII, so numeric failure codes are left alone rather than
 * rendered as mojibake.
 */
export function decodeShortStringFelt(hex: string): string | null {
  try {
    const decoded = shortString.decodeShortString(hex);
    if (!decoded) return null;
    return /^[\x20-\x7e]+$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

const FAILURE_REASON_RE = /Failure reason:?\s*([\s\S]*?)(?:\n\s*\n|$)/i;
const HEX_FELT_RE = /0x[0-9a-fA-F]{2,64}/g;
const QUOTED_RE = /\('([^']{1,31})'\)/g;

/**
 * Lift the Cairo revert reason out of a node error and decode any short-string
 * panic codes inside it. Returns the raw reason text plus the decoded codes.
 */
export function extractRevert(text: string): { reason: string | null; panicCodes: string[] } {
  if (!text) return { reason: null, panicCodes: [] };

  const match = FAILURE_REASON_RE.exec(text);
  const reason = match?.[1]?.trim() ?? (/revert|Execution failed|panic/i.test(text) ? text.trim() : null);
  if (!reason) return { reason: null, panicCodes: [] };

  const codes = new Set<string>();

  // Nodes that already decoded the short string print it as ('CORDON_OVER_CAP').
  for (const quoted of reason.matchAll(QUOTED_RE)) {
    if (quoted[1]) codes.add(quoted[1]);
  }
  // Nodes that did not print raw felts; decode them ourselves.
  for (const felt of reason.match(HEX_FELT_RE) ?? []) {
    const decoded = decodeShortStringFelt(felt);
    if (decoded) codes.add(decoded);
  }

  return { reason, panicCodes: [...codes] };
}

/**
 * Reduce any thrown value to the honest facts about it. Never throws.
 */
export function normalizeError(error: unknown): Strk20NormalizedError {
  const message = extractMessage(error);
  const code = extractCode(error);
  const data = extractData(error);
  const haystack = `${message}\n${stringifyData(data)}`;
  const { reason, panicCodes } = extractRevert(haystack);

  let source: Strk20NormalizedError["source"] = "unknown";
  let name: string | null = null;
  if (code !== null && WALLET_ERROR_NAMES[code]) {
    source = "wallet";
    name = WALLET_ERROR_NAMES[code];
  } else if (code !== null && RPC_ERROR_NAMES[code]) {
    source = "rpc";
    name = RPC_ERROR_NAMES[code];
  } else if (code !== null) {
    // A code we do not have a name for is still a real code — report it as-is.
    source = code >= 111 && code <= 163 ? "wallet" : "rpc";
  }

  return { source, code, name, message, revertReason: reason, panicCodes, data };
}

/**
 * True when a wallet is telling us the STRK20 method does not exist. Wallets are
 * inconsistent here: Braavos answers with a plain "Not implemented" message
 * rather than a spec error code, so we match on the message as well as on the
 * JSON-RPC "method not found" code.
 */
export function isNotImplemented(error: Strk20NormalizedError): boolean {
  if (error.code === -32601) return true;
  const text = `${error.message} ${stringifyData(error.data)}`.toLowerCase();
  return (
    /not[\s_-]*implemented/.test(text) ||
    /method[\s_-]*not[\s_-]*(found|supported)/.test(text) ||
    /unsupported[\s_-]*method/.test(text) ||
    /unknown[\s_-]*method/.test(text)
  );
}

/** True when the user dismissed the wallet prompt. */
export function isUserRefusal(error: Strk20NormalizedError): boolean {
  if (error.code === 113) return true;
  const text = error.message.toLowerCase();
  return /user (refused|rejected|denied|abort)/.test(text) || /rejected by user/.test(text);
}

/** A single line safe to render in the UI, carrying the code and revert reason. */
export function describeError(error: Strk20NormalizedError): string {
  const parts: string[] = [];
  if (error.name && error.code !== null) parts.push(`${error.name} (${error.code})`);
  else if (error.code !== null) parts.push(`JSON-RPC ${error.code}`);
  if (error.panicCodes.length) parts.push(error.panicCodes.join(", "));
  else if (error.revertReason) parts.push(error.revertReason);
  if (!parts.length) return error.message;
  return `${parts.join(" · ")} — ${error.message}`;
}
