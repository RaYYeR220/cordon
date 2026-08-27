/**
 * Read facts back out of the Cairo source.
 *
 * The contracts are the authority for the hashes and the panic codes, so the tests read them from
 * `contracts/` rather than from a copy that can quietly go stale. Everything here is deliberately
 * tolerant of renames and reformatting and intolerant of a changed *value*: the point is to notice
 * when Cairo and TypeScript stop agreeing, not to police how the Cairo is written.
 *
 * Test-only. Nothing in `src/` reads the filesystem.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shortStringToFelt, toFelt, type Felt } from "../src/felt.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** `contracts/` as seen from `packages/sdk/test/`. */
export const CONTRACTS_DIR = join(HERE, "..", "..", "..", "contracts");

export function readContractsFile(...segments: string[]): string {
  return readFileSync(join(CONTRACTS_DIR, ...segments), "utf8");
}

/**
 * Resolve a Cairo felt literal: `0x…` hex, `1_800_086_400` decimal, or `'SHORT_STRING'`.
 * A trailing `.try_into().unwrap()`, which is how a `ContractAddress` literal is written, is
 * ignored. Returns `null` for anything else, such as a bare identifier.
 */
function literalToFelt(text: string): Felt | null {
  const value = text.trim().replace(/\.try_into\(\)\s*\.unwrap\(\)$/, "").trim();
  const short = /^'([^']*)'$/.exec(value);
  if (short) return shortStringToFelt(short[1] as string);
  if (/^0x[0-9a-fA-F_]+$/.test(value)) return toFelt(value.replace(/_/g, ""));
  if (/^[0-9][0-9_]*$/.test(value)) return toFelt(value.replace(/_/g, ""));
  return null;
}

/**
 * Every felt-valued name in a Cairo file: `let x: felt252 = …`, `const X: felt252 = …`, and
 * zero-argument fixture helpers such as `fn fixture_gate() -> ContractAddress { 0x… }`.
 *
 * The helpers matter because the Cairo fixture spells its preimages out using them, so a reader
 * that only understood `let` bindings would silently fail to resolve a span and skip the very
 * conformance check it exists to perform. Values that are not literals are left out rather than
 * guessed at.
 */
export function feltBindings(source: string): Map<string, Felt> {
  const bindings = new Map<string, Felt>();

  // Zero-argument fixture helpers first, because a `let` binding often just calls one.
  const helper = /fn\s+(\w+)\s*\(\s*\)\s*->\s*(?:felt252|ContractAddress)\s*\{([\s\S]*?)\n\}/g;
  for (const match of source.matchAll(helper)) {
    const body = (match[2] as string)
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, "").trim())
      .filter((line) => line.length > 0)
      .join(" ");
    const felt = literalToFelt(body);
    if (felt !== null) {
      bindings.set(`${match[1] as string}()`, felt);
      bindings.set(match[1] as string, felt);
    }
  }

  const assignment = /(?:let|const)\s+(?:mut\s+)?(\w+)\s*:\s*felt252\s*=\s*([\s\S]*?);/g;
  for (const match of source.matchAll(assignment)) {
    const raw = (match[2] as string).trim();
    const felt = literalToFelt(raw) ?? bindings.get(raw) ?? null;
    if (felt !== null) bindings.set(match[1] as string, felt);
  }

  return bindings;
}

/**
 * Split a Cairo file into function bodies.
 *
 * Bindings have to be resolved per function, not per file. Each spelled-out preimage test declares
 * its own `let tag: felt252 = …`, and a single flat map would let the last one win — which silently
 * misclassifies one preimage as another and drops a conformance check.
 */
function functionBodies(source: string): string[] {
  const bodies: string[] = [];
  const opener = /\bfn\s+\w+\s*(?:<[^>]*>)?\s*\(/g;

  for (const match of source.matchAll(opener)) {
    const brace = source.indexOf("{", match.index + match[0].length);
    if (brace === -1) continue;
    let depth = 0;
    for (let index = brace; index < source.length; index += 1) {
      const character = source[index];
      if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          bodies.push(source.slice(brace, index + 1));
          break;
        }
      }
    }
  }

  return bodies;
}

/**
 * Every `[a, b, c].span()` literal in a Cairo file, with each element resolved through the
 * bindings visible where it appears.
 *
 * A span whose elements cannot all be resolved is dropped: it is not a spelled-out preimage, which
 * is the only thing this is looking for.
 */
export function feltSpans(source: string): Felt[][] {
  const fileScope = feltBindings(source);
  const spans: Felt[][] = [];

  for (const body of functionBodies(source)) {
    // Names declared inside the function shadow anything at file scope.
    const bindings = new Map(fileScope);
    for (const [name, felt] of feltBindings(body)) bindings.set(name, felt);
    spans.push(...spansIn(body, bindings));
  }

  return spans;
}

function spansIn(source: string, bindings: Map<string, Felt>): Felt[][] {
  const spans: Felt[][] = [];

  for (const match of source.matchAll(/\[([^[\]]*?)\]\s*\.span\(\)/gs)) {
    const elements = (match[1] as string)
      .split(",")
      .map((element) => element.trim())
      .filter((element) => element.length > 0);
    if (elements.length === 0) continue;

    const resolved: Felt[] = [];
    let complete = true;
    for (const element of elements) {
      const felt = literalToFelt(element) ?? bindings.get(element) ?? null;
      if (felt === null) {
        complete = false;
        break;
      }
      resolved.push(felt);
    }
    if (complete) spans.push(resolved);
  }

  return spans;
}

/** The domain-separation tags as `contracts/src/hashing.cairo` declares them. */
export function readDomainTags(): {
  credential: Felt;
  subjectAction: Felt;
  settlementTerms: Felt;
} {
  const bindings = feltBindings(readContractsFile("src", "hashing.cairo"));
  const credential = bindings.get("CREDENTIAL_TAG");
  const subjectAction = bindings.get("SUBJECT_ACTION_TAG");
  const settlementTerms = bindings.get("SETTLEMENT_TERMS_TAG");
  if (!credential || !subjectAction || !settlementTerms) {
    throw new Error("could not read all three domain tags from contracts/src/hashing.cairo");
  }
  return { credential, subjectAction, settlementTerms };
}

/** The leg tags as `contracts/src/hashing.cairo` declares them. */
export function readLegTags(): Record<string, Felt> {
  const bindings = feltBindings(readContractsFile("src", "hashing.cairo"));
  const legs: Record<string, Felt> = {};
  for (const name of ["DIRECT", "FUND", "CLAIM", "REFUND"]) {
    const felt = bindings.get(name);
    if (!felt) throw new Error(`could not read the ${name} leg tag from hashing.cairo`);
    legs[name] = felt;
  }
  return legs;
}

/** One spelled-out preimage and the hash the Cairo suite pins for it. */
export interface CairoVector {
  /** The felt span, tag first, exactly as the Cairo test writes it out. */
  preimage: Felt[];
  /** The pinned hash constant. */
  expected: Felt;
}

/**
 * The pinned fixture vectors from `contracts/src/tests/test_hashing.cairo`.
 *
 * Spans are classified by their first element — the domain tag — rather than by the name of the
 * test that contains them, so renaming a Cairo test does not silently drop a conformance check.
 */
export function readPinnedVectors(): {
  credential: CairoVector;
  settlementTerms: CairoVector;
  subjectAction: CairoVector;
} {
  const source = readContractsFile("src", "tests", "test_hashing.cairo");
  const bindings = feltBindings(source);
  const tags = readDomainTags();

  const pick = (name: string): Felt => {
    const felt = bindings.get(name);
    if (!felt) {
      throw new Error(`could not find ${name} in contracts/src/tests/test_hashing.cairo`);
    }
    return felt;
  };

  const spans = feltSpans(source);
  const spanFor = (tag: Felt, what: string): Felt[] => {
    const span = spans.find((candidate) => candidate[0] === tag);
    if (!span) {
      throw new Error(
        `contracts/src/tests/test_hashing.cairo no longer spells the ${what} preimage out as a ` +
          "literal felt span; the conformance test cannot read the Cairo side any more",
      );
    }
    return span;
  };

  return {
    credential: {
      preimage: spanFor(tags.credential, "credential"),
      expected: pick("FIXTURE_CREDENTIAL_HASH"),
    },
    settlementTerms: {
      preimage: spanFor(tags.settlementTerms, "settlement terms"),
      expected: pick("FIXTURE_TERMS_HASH"),
    },
    subjectAction: {
      preimage: spanFor(tags.subjectAction, "subject action"),
      expected: pick("FIXTURE_ACTION_HASH"),
    },
  };
}

/** Every `CORDON_*` panic code declared in `contracts/src/errors.cairo`. */
export function readPanicCodes(): string[] {
  const source = readContractsFile("src", "errors.cairo");
  const codes = new Set<string>();
  for (const match of source.matchAll(/'(CORDON_[A-Z0-9_]+)'/g)) {
    codes.add(match[1] as string);
  }
  return [...codes].sort();
}
