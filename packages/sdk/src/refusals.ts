/**
 * Refusals: every `CORDON_*` panic code, in words.
 *
 * A gate that refuses is the product, not an error path. On chain a refusal is a short-string
 * panic and a whole reverted transaction; a user gets "execution reverted" and no idea which rule
 * fired. This module turns the code back into the rule.
 *
 * The registry mirrors `contracts/src/errors.cairo`, and `test/refusals.test.ts` parses that file
 * to assert every code declared there has an entry here. Adding a panic code to the contracts
 * without adding it here fails that test.
 */

import { feltToShortString, isFelt } from "./felt.js";

/** Which contract, or which part of one, raised a refusal. */
export type RefusalSource =
  | "gate"
  | "settlement"
  | "issuer-registry"
  | "revocation-registry"
  | "policy-registry"
  | "shared";

/**
 * Who can do something about a refusal. This is what a UI should branch on: telling a payer to
 * "contact your issuer" when they merely need to send less is the difference between a useful
 * refusal and a dead end.
 */
export type RefusalRemedy =
  /** The payer can retry with different inputs — a smaller amount, a fresh nonce, later. */
  | "payer"
  /** Only the credential's issuer can fix it: re-attest, un-revoke, renew. */
  | "issuer"
  /** Only the registry owner can fix it: publish the policy, register the issuer. */
  | "operator"
  /** The transaction was assembled wrongly. A user cannot fix this; the integrator must. */
  | "integrator";

/** One decoded refusal. */
export interface Refusal {
  /** The panic code exactly as the contract raises it, e.g. `CORDON_OVER_CAP`. */
  code: string;
  /** One line, safe to put straight in a UI. */
  title: string;
  /** Which rule fired and why, in a sentence or two a non-engineer can act on. */
  explanation: string;
  /** The contract that raised it. */
  source: RefusalSource;
  /** Who can resolve it. */
  remedy: RefusalRemedy;
  /**
   * Position in the gate's enforcement order, for refusals raised during a settlement. Lets a UI
   * show how far a transaction got before it was stopped.
   */
  step?: number;
}

const REFUSALS: readonly Refusal[] = [
  {
    code: "CORDON_ZERO_ADDRESS",
    title: "A contract address was left empty",
    explanation:
      "A Cordon contract was pointed at address zero where a live contract is required. This is a " +
      "deployment or configuration mistake, not something a payer did.",
    source: "shared",
    remedy: "operator",
  },

  // The gate, in the order it evaluates.
  {
    code: "CORDON_BAD_POOL",
    title: "The caller is not the privacy pool",
    explanation:
      "The gate only accepts calls from the pool address the transaction names, because value has " +
      "to have routed through the pool for the settlement to mean anything. Either the transaction " +
      "was not assembled by the pool, or the pool address in the calldata is wrong — it should be " +
      'the literal placeholder "${poolAddress}", which the wallet substitutes.',
    source: "gate",
    remedy: "integrator",
    step: 1,
  },
  {
    code: "CORDON_NO_POLICY",
    title: "No such policy",
    explanation:
      "Nothing is published under this policy id, or it has been retired. Policies are immutable " +
      "once published, so a changed rule is a new id — check you are pointing at the current one.",
    source: "gate",
    remedy: "operator",
    step: 2,
  },
  {
    code: "CORDON_PAYEE_REQUIRED",
    title: "This policy requires a credentialed payee",
    explanation:
      "The policy demands a credential from the payee as well as the payer, and this settlement " +
      "carries only the payer's. The gate refuses rather than quietly dropping the check. Use the " +
      "escrowed Fund/Claim flow, where the payee presents their own credential to claim.",
    source: "gate",
    remedy: "integrator",
    step: 2,
  },
  {
    code: "CORDON_NO_VALUE",
    title: "The pool sent no value",
    explanation:
      "The gate reads its own token balance to learn the amount, and it is zero, so there is " +
      "nothing to gate. The withdraw action that funds the gate is missing from the transaction, " +
      "or it named a different token than the invoke did.",
    source: "gate",
    remedy: "integrator",
    step: 3,
  },
  {
    code: "CORDON_AMOUNT_OVERFLOW",
    title: "The amount is too large to settle",
    explanation:
      "The balance handed to the gate does not fit the pool's u128 deposit amount. No real token " +
      "supply reaches this, so in practice it means the token contract reported a nonsense balance.",
    source: "gate",
    remedy: "integrator",
    step: 3,
  },
  {
    code: "CORDON_BALANCE_SHORTFALL",
    title: "The gate holds less than it owes",
    explanation:
      "The gate's token balance is below what it has committed to open settlements, so it cannot " +
      "work out how much the pool just sent. Nothing can settle safely in this state; it means " +
      "value left the gate outside a claim or a refund.",
    source: "gate",
    remedy: "operator",
    step: 3,
  },
  {
    code: "CORDON_BAD_ISSUER",
    title: "The issuer is not accepted",
    explanation:
      "The credential's issuer is unknown to the registry, has been deactivated, or is not the " +
      "issuer this policy pins. A credential is only as good as the key that signed it, and this " +
      "gate does not accept that key.",
    source: "gate",
    remedy: "issuer",
    step: 4,
  },
  {
    code: "CORDON_BAD_CRED",
    title: "The credential signature does not verify",
    explanation:
      "The issuer's signature over the credential hash failed against the issuer's registered " +
      "public key. Either a field was altered after signing, or the signer computed a different " +
      "preimage — compare your hash against contracts/HASHING.md and the SDK conformance vectors.",
    source: "gate",
    remedy: "issuer",
    step: 5,
  },
  {
    code: "CORDON_EXPIRED",
    title: "The credential has expired",
    explanation:
      "The credential's expiry is in the past relative to the block timestamp. Ask the issuer for " +
      "a fresh one; nothing about the old credential can be repaired.",
    source: "gate",
    remedy: "issuer",
    step: 6,
  },
  {
    code: "CORDON_REVOKED",
    title: "The credential was revoked",
    explanation:
      "The issuer has withdrawn this credential before its expiry. Revocation is the issuer's " +
      "power alone, and it is recorded on chain, so the refusal is auditable.",
    source: "gate",
    remedy: "issuer",
    step: 7,
  },
  {
    code: "CORDON_CLAIM_MISMATCH",
    title: "The credential attests the wrong claim",
    explanation:
      "The credential is valid but says something else. A genuine KYC_L2 credential is still the " +
      "wrong credential for a policy that requires ACCREDITED.",
    source: "gate",
    remedy: "issuer",
    step: 8,
  },
  {
    code: "CORDON_BAD_SUBJECT_SIG",
    title: "The subject did not authorise this settlement",
    explanation:
      "The signature over the action hash failed against the credential's subject public key. " +
      "Holding a credential is not authorisation: the subject signs the exact chain, gate, policy, " +
      "note, token, amount and nonce. If any of those changed after signing — most often the " +
      "amount, which the gate reads from its own balance — the signature no longer covers it.",
    source: "gate",
    remedy: "payer",
    step: 9,
  },
  {
    code: "CORDON_NONCE_USED",
    title: "This authorisation was already spent",
    explanation:
      "The subject already settled with this nonce. Each authorisation is single-use, which is " +
      "what stops a relayer replaying one settlement. Sign again with a fresh nonce.",
    source: "gate",
    remedy: "payer",
    step: 9,
  },
  {
    code: "CORDON_OVER_CAP",
    title: "Over the policy's per-transaction cap",
    explanation:
      "The amount is larger than the most this policy lets one settlement move. The credential is " +
      "fine and the subject is fine; the size is not. Send less, or use a policy with a higher cap.",
    source: "gate",
    remedy: "payer",
    step: 10,
  },
  {
    code: "CORDON_OVER_VELOCITY",
    title: "Over the policy's limit for this period",
    explanation:
      "This settlement plus what the subject has already moved in the current epoch exceeds the " +
      "policy's aggregate. Velocity is counted against the subject pseudonym, so a new wallet does " +
      "not reset it. Wait for the next epoch or send less.",
    source: "gate",
    remedy: "payer",
    step: 11,
  },

  // Two-step settlement: the Fund, Claim and Refund legs.
  {
    code: "CORDON_ZERO_SETTLEMENT",
    title: "Settlement id zero is reserved",
    explanation:
      'Zero is reserved to mean "no settlement", so it cannot name one. Pick any other id; it is ' +
      "the handle the claim and the refund will both quote.",
    source: "settlement",
    remedy: "integrator",
  },
  {
    code: "CORDON_SETTLEMENT_EXISTS",
    title: "That settlement id has already been used",
    explanation:
      "Settlement ids are single-use, whether the settlement is still open, claimed or refunded. " +
      "Reusing one would overwrite a record the gate needs to resolve the first. Choose a fresh id.",
    source: "settlement",
    remedy: "integrator",
  },
  {
    code: "CORDON_NO_SETTLEMENT",
    title: "Nothing was funded under that id",
    explanation:
      "There is no settlement to claim or refund. Either the funding transaction never landed, or " +
      "this is the wrong id.",
    source: "settlement",
    remedy: "payer",
  },
  {
    code: "CORDON_ALREADY_CLAIMED",
    title: "The payee has already taken this settlement",
    explanation:
      "The value has gone to the payee. A settlement resolves exactly once, and this one is done.",
    source: "settlement",
    remedy: "payer",
  },
  {
    code: "CORDON_ALREADY_REFUNDED",
    title: "The payer has already taken this settlement back",
    explanation:
      "The claim window closed unclaimed and the payer refunded it. There is nothing left to take.",
    source: "settlement",
    remedy: "payer",
  },
  {
    code: "CORDON_CLAIM_EXPIRED",
    title: "The claim window has closed",
    explanation:
      "This settlement's expiry has passed, so the payee can no longer claim and the payer can now " +
      "refund. Ask the payer to fund a new settlement with a longer window.",
    source: "settlement",
    remedy: "payer",
  },
  {
    code: "CORDON_REFUND_TOO_EARLY",
    title: "The claim window is still open",
    explanation:
      "A refund cannot race a payee who still has time to claim. Wait until the settlement's " +
      "expiry, then refund.",
    source: "settlement",
    remedy: "payer",
  },
  {
    code: "CORDON_BAD_EXPIRY",
    title: "The claim window would close in the past",
    explanation:
      "A settlement funded with an expiry at or before the current block time could never be " +
      "claimed by anyone. Set an expiry far enough ahead for the payee to act.",
    source: "settlement",
    remedy: "integrator",
  },
  {
    code: "CORDON_TOKEN_MISMATCH",
    title: "That settlement holds a different token",
    explanation:
      "The claim or refund names one ERC20 and the settlement holds another. The token is fixed at " +
      "funding time and both later legs have to name the same one.",
    source: "settlement",
    remedy: "integrator",
  },
  {
    code: "CORDON_UNEXPECTED_VALUE",
    title: "This leg should not carry value",
    explanation:
      "Only the funding leg is fed by the pool. A claim or a refund moves value the gate is " +
      "already holding, so its action array is `transfer(OPEN, self)` → `invoke` with no withdraw. " +
      "An unexpected balance means the wrong action array was built.",
    source: "settlement",
    remedy: "integrator",
  },

  // Issuer registry.
  {
    code: "CORDON_ZERO_ISSUER_ID",
    title: "Issuer id zero is reserved",
    explanation:
      'Zero means "any active issuer" in a policy, so it cannot also name a specific issuer. ' +
      "Choose a non-zero id.",
    source: "issuer-registry",
    remedy: "operator",
  },
  {
    code: "CORDON_ZERO_KEY",
    title: "An issuer public key cannot be zero",
    explanation:
      "The registry answers zero for unknown issuers, so a zero key would make a registered issuer " +
      "indistinguishable from a missing one and turn a lookup failure into an accepted signer.",
    source: "issuer-registry",
    remedy: "operator",
  },
  {
    code: "CORDON_ISSUER_EXISTS",
    title: "That issuer id is already claimed",
    explanation:
      "Issuer ids are claimed once and never rebound, so any credential signed under an id can " +
      "always be traced to the key registered under it. Register a new id instead of rebinding.",
    source: "issuer-registry",
    remedy: "operator",
  },
  {
    code: "CORDON_UNKNOWN_ISSUER",
    title: "No issuer is registered under that id",
    explanation: "Nothing has ever been registered under this issuer id.",
    source: "issuer-registry",
    remedy: "operator",
  },
  {
    code: "CORDON_ALREADY_INACTIVE",
    title: "That issuer is already deactivated",
    explanation:
      "Deactivation is permanent for an issuer id, and doing it twice is more likely a mistake " +
      "than an intent, so the registry says so.",
    source: "issuer-registry",
    remedy: "operator",
  },
  {
    code: "CORDON_ZERO_OPERATOR",
    title: "An issuer operator cannot be address zero",
    explanation:
      "Address zero can never be a caller, so setting it as the operator would leave the issuer " +
      "unable to revoke anything.",
    source: "issuer-registry",
    remedy: "operator",
  },

  // Revocation registry.
  {
    code: "CORDON_NOT_OPERATOR",
    title: "Only the issuer's operator may revoke",
    explanation:
      "Revocation belongs to the issuer, not to the registry owner: an issuer that learns a " +
      "subject no longer qualifies must be able to withdraw the attestation without asking anyone.",
    source: "revocation-registry",
    remedy: "issuer",
  },
  {
    code: "CORDON_ALREADY_REVOKED",
    title: "That credential is already revoked",
    explanation:
      "The credential id has already been withdrawn by this issuer. Revoking twice is worth " +
      "surfacing rather than silently accepting.",
    source: "revocation-registry",
    remedy: "issuer",
  },

  // Policy registry.
  {
    code: "CORDON_ZERO_POLICY_ID",
    title: "Policy id zero is reserved",
    explanation: 'Zero is reserved to mean "no policy" and cannot name a published rule set.',
    source: "policy-registry",
    remedy: "operator",
  },
  {
    code: "CORDON_ZERO_CLAIM",
    title: "A policy must require a claim",
    explanation:
      "A policy with no required claim would admit every credential, which is not a gate. Name the " +
      "claim the policy is about.",
    source: "policy-registry",
    remedy: "operator",
  },
  {
    code: "CORDON_POLICY_EXISTS",
    title: "That policy id is already published",
    explanation:
      "Published policies are immutable, so that a decision recorded against a policy id can " +
      "always be replayed against the exact parameters that produced it. Publish a new id.",
    source: "policy-registry",
    remedy: "operator",
  },
  {
    code: "CORDON_INACTIVE_PUBLISH",
    title: "A policy must be published active",
    explanation:
      "Publishing an already-retired policy would create a rule set that never applied to " +
      "anything. Publish it active and retire it afterwards to take it out of service.",
    source: "policy-registry",
    remedy: "operator",
  },
  {
    code: "CORDON_ALREADY_RETIRED",
    title: "That policy is already retired",
    explanation: "The policy has already been taken out of service. Retirement is one-way.",
    source: "policy-registry",
    remedy: "operator",
  },
  {
    code: "CORDON_ZERO_EPOCH_CAP",
    title: "A velocity epoch needs a non-zero allowance",
    explanation:
      "A policy with a velocity epoch but a zero aggregate would refuse every settlement, however " +
      "small. If the intent is no velocity limit, set the epoch length to zero instead.",
    source: "policy-registry",
    remedy: "operator",
  },
];

const BY_CODE: ReadonlyMap<string, Refusal> = new Map(
  REFUSALS.map((refusal) => [refusal.code, refusal]),
);

/** Every refusal Cordon can raise, in enforcement order within each contract. */
export function allRefusals(): readonly Refusal[] {
  return REFUSALS;
}

/** Every panic code Cordon can raise. */
export function refusalCodes(): readonly string[] {
  return REFUSALS.map((refusal) => refusal.code);
}

/** Look up one panic code. Returns `undefined` for a code this SDK does not know. */
export function refusalForCode(code: string): Refusal | undefined {
  return BY_CODE.get(code.trim());
}

/**
 * The refusal used when a transaction reverted for a reason Cordon did not raise.
 *
 * Keeping this shaped like a real refusal means a UI has exactly one thing to render, and an
 * unrecognised revert reads as "we do not know" instead of as a blank screen.
 */
export function unknownRefusal(raw: string): Refusal {
  return {
    code: "UNKNOWN",
    title: "The transaction reverted for a reason outside Cordon",
    explanation:
      "No Cordon panic code appears in this revert. It came from the pool, the token, the account, " +
      `or the node. The reason as reported: ${raw.trim() || "(empty)"}`,
    source: "shared",
    remedy: "integrator",
  };
}

/**
 * Pull Cordon refusals out of a raw revert reason.
 *
 * Nodes report panics inconsistently: sometimes as the short string itself, sometimes as the felt
 * it encodes, sometimes buried in a longer trace with several frames. This scans for both forms
 * and returns everything it finds, in the order it appears, deduplicated.
 *
 * @example
 * ```ts
 * decodeRefusals("Failure reason: 0x434f52444f4e5f4f5645525f434150 ('CORDON_OVER_CAP')");
 * // -> [{ code: "CORDON_OVER_CAP", title: "Over the policy's per-transaction cap", … }]
 * ```
 */
export function decodeRefusals(revertReason: string): Refusal[] {
  const found: Refusal[] = [];
  const seen = new Set<string>();

  const add = (code: string): void => {
    const refusal = BY_CODE.get(code);
    if (refusal && !seen.has(code)) {
      seen.add(code);
      found.push(refusal);
    }
  };

  for (const match of revertReason.matchAll(/CORDON_[A-Z0-9_]+/g)) {
    add(match[0]);
  }
  for (const match of revertReason.matchAll(/0x[0-9a-fA-F]+/g)) {
    const literal = match[0];
    if (!isFelt(literal)) continue;
    const decoded = feltToShortString(literal);
    if (decoded && decoded.startsWith("CORDON_")) add(decoded);
  }

  return found;
}

/**
 * Decode a revert into the single refusal worth showing a user.
 *
 * The gate stops at the first failed check, so a revert carries one Cordon refusal in practice. If
 * several appear (a trace spanning contracts), the first is the one that fired.
 */
export function decodeRefusal(revertReason: string): Refusal {
  return decodeRefusals(revertReason)[0] ?? unknownRefusal(revertReason);
}

/**
 * Best-effort decode of anything a wallet, provider or node threw.
 *
 * Walks the usual places a revert reason hides — `message`, `revert_reason`, `execution_error`,
 * `data`, nested `cause` — so a caller can hand over a caught error and get a refusal back.
 */
export function decodeRefusalFromError(error: unknown): Refusal {
  const text = collectText(error, new Set(), 0).join("\n");
  return decodeRefusal(text);
}

function collectText(value: unknown, seen: Set<object>, depth: number): string[] {
  if (depth > 6 || value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "bigint") return [String(value)];
  if (typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);

  const out: string[] = [];
  if (value instanceof Error) {
    out.push(value.message);
    out.push(...collectText((value as Error & { cause?: unknown }).cause, seen, depth + 1));
  }
  if (Array.isArray(value)) {
    for (const item of value) out.push(...collectText(item, seen, depth + 1));
    return out;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    out.push(...collectText(nested, seen, depth + 1));
  }
  return out;
}
