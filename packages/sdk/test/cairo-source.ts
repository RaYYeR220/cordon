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
 * Returns `null` for anything else, such as a bare identifier.
 */
function literalToFelt(text: string): Felt | null {
  const value = text.trim();
  const short = /^'([^']*)'$/.exec(value);
  if (short) return shortStringToFelt(short[1] as string);
  if (/^0x[0-9a-fA-F_]+$/.test(value)) return toFelt(value.replace(/_/g, ""));
  if (/^[0-9][0-9_]*$/.test(value)) return toFelt(value.replace(/_/g, ""));
  return null;
}

/**
 * Every `felt252` binding in a Cairo file — `let x: felt252 = …` and `const X: felt252 = …` alike.
 * Values that are not literals are skipped rather than guessed at.
 */
export function feltBindings(source: string): Map<string, Felt> {
  const bindings = new Map<string, Felt>();
  const pattern = /(?:let|const)\s+(?:mut\s+)?(\w+)\s*:\s*felt252\s*=\s*([\s\S]*?);/g;
  for (const match of source.matchAll(pattern)) {
    const felt = literalToFelt(match[2] as string);
    if (felt !== null) bindings.set(match[1] as string, felt);
  }
  return bindings;
}

/**
 * Every `[a, b, c].span()` literal in a Cairo file, with each element resolved through
 * {@link feltBindings}.
 *
 * A span whose elements cannot all be resolved is dropped: it is not a spelled-out preimage, which
 * is the only thing this is looking for.
 */
export function feltSpans(source: string): Felt[][] {
  const bindings = feltBindings(source);
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
export function readDomainTags(): { credential: Felt; subjectAction: Felt } {
  const source = readContractsFile("src", "hashing.cairo");
  const bindings = feltBindings(source);
  const credential = bindings.get("CREDENTIAL_TAG");
  const subjectAction = bindings.get("SUBJECT_ACTION_TAG");
  if (!credential || !subjectAction) {
    throw new Error(
      "could not find CREDENTIAL_TAG and SUBJECT_ACTION_TAG in contracts/src/hashing.cairo",
    );
  }
  return { credential, subjectAction };
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
export function readPinnedVectors(): { credential: CairoVector; subjectAction: CairoVector } {
  const source = readContractsFile("src", "tests", "test_hashing.cairo");
  const bindings = feltBindings(source);
  const tags = readDomainTags();

  const credentialHash = bindings.get("FIXTURE_CREDENTIAL_HASH");
  const actionHash = bindings.get("FIXTURE_ACTION_HASH");
  if (!credentialHash || !actionHash) {
    throw new Error(
      "could not find FIXTURE_CREDENTIAL_HASH and FIXTURE_ACTION_HASH in " +
        "contracts/src/tests/test_hashing.cairo",
    );
  }

  const spans = feltSpans(source);
  const credentialSpan = spans.find((span) => span[0] === tags.credential);
  const actionSpan = spans.find((span) => span[0] === tags.subjectAction);
  if (!credentialSpan || !actionSpan) {
    throw new Error(
      "contracts/src/tests/test_hashing.cairo no longer spells out both preimages as literal " +
        "felt spans; the conformance test cannot read the Cairo side any more",
    );
  }

  return {
    credential: { preimage: credentialSpan, expected: credentialHash },
    subjectAction: { preimage: actionSpan, expected: actionHash },
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
