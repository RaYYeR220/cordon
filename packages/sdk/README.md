# `@cordon/sdk`

Credential and policy gate for shielded STRK20 value on Starknet.

Cordon routes shielded value through a Cairo anonymizer, so a policy is not a report generated
afterwards — it is a gate. An unaccredited, revoked, sanctioned, over-cap or over-velocity payer
cannot move pool funds at all: the gate panics and the whole pool transaction reverts.

This package is everything the off-chain side of that needs: the two hash preimages the contracts
verify signatures against, STARK-curve signing, the calldata for all four gate legs, and a decoder
that turns every `CORDON_*` panic into the rule that fired.

- **Zero runtime dependencies** beyond `starknet` (`^10.4.0`).
- **Browser-safe.** No `fs`, no `Buffer`, no Node built-ins anywhere in the entry point.
- **ESM and CJS**, with types for both.
- **Conformance-tested against the Cairo source** on every run. See
  [Why the conformance tests matter](#why-the-conformance-tests-matter).

```sh
npm install @cordon/sdk starknet
```

## The five-minute version

```ts
import {
  authorizeAction,
  buildDirectActions,
  decodeRefusalFromError,
  generateSubjectKeypair,
  randomNonce,
} from "@cordon/sdk";

// 1. A pseudonym, generated locally. This is never a wallet address.
const subject = generateSubjectKeypair();

// 2. …hand `subject.publicKey` to an issuer, get a credential back. (See services/issuer.)

// 3. Authorise exactly one settlement.
const payer = authorizeAction(
  {
    chainId: "SN_MAIN",
    gate: GATE_ADDRESS,
    policyId: "PAY_ACCREDITED_V1",
    noteId: resolvedNoteId,   // see "The note id" below
    token: STRK,
    amount: 400_000000000000000000n,
    nonce: randomNonce(),
    credential,
  },
  subject.privateKey,
);

// 4. Build the transaction and send it through the wallet.
const actions = buildDirectActions({
  gate: GATE_ADDRESS,
  token: STRK,
  amount: 400_000000000000000000n,
  payee: PAYEE_ADDRESS,
  payer,
});

try {
  await wallet.strk20InvokeTransaction({ actions });
} catch (error) {
  // 5. The refusal is the product.
  const refusal = decodeRefusalFromError(error);
  console.log(refusal.title);        // "Over the policy's per-transaction cap"
  console.log(refusal.explanation);  // …and which rule fired, and who can fix it
}
```

## What Cordon is, in four legs

`PolicyGate::privacy_invoke(operation, token, pool_address, note_id)` is the only entrypoint the
pool calls. The `operation` enum selects the leg:

| Leg | Who signs | Action array | Returns |
| --- | --- | --- | --- |
| `Direct` | payer | `withdraw` → `transfer(OPEN)` → `invoke` | the payer's open note |
| `Fund` | payer | `withdraw` → `invoke` | an empty span — the value stays with the gate |
| `Claim` | **payee** | `transfer(OPEN, self)` → `invoke` | the payee's open note |
| `Refund` | payer | `transfer(OPEN, self)` → `invoke` | the payer's open note |

`Direct` is a gated private payment in one transaction. `Fund`/`Claim` exists because a payer
cannot vouch for a payee — the gate never sees who the `transfer(OPEN)` credits — so a policy that
requires a payee credential can only be satisfied by the payee authenticating themselves, with
their own key, in their own transaction, at the moment they take the money. `Refund` closes the
loop after the claim window shuts.

One builder per leg:

```ts
buildDirectActions({ gate, token, amount, payee, payer })
buildFundActions({ gate, token, amount, payer, settlementId, payeeClaimPolicyId, expiresAt })
buildClaimActions({ gate, token, settlementId, credential, signature, nonce, recipient })
buildRefundActions({ gate, token, settlementId, signature, nonce, recipient })
```

Each has an `encode*Calldata` twin returning just the flat felt array for the `invoke` action, if
you are assembling the transaction yourself.

## The three literals you must not touch

The wallet substitutes three strings while it assembles a STRK20 transaction. They travel as plain
strings. Hex-encoding any of them breaks the substitution, and the failure is silent until the gate
refuses with `CORDON_BAD_POOL`.

| Literal | Where it goes |
| --- | --- |
| `"OPEN"` | the `amount` of the transfer that reserves an open note |
| `"${poolAddress}"` | the `pool_address` argument |
| `"${openNoteIds[0]}"` | the `note_id` argument |

Every encoder in this package routes through `calldataItem`, which recognises them and passes them
through untouched. `isPlaceholder` is exported so you can assert it yourself.

`validateActions` checks an array against the pool's assembly rules before you pay a wallet
round-trip to learn the same thing: no empty arrays, no invoke-only arrays (the wallet answers
`INVALID_REQUEST_PAYLOAD`), at most one invoke, phases non-decreasing.

## Signing

Two signatures matter, and this package reproduces both preimages exactly.

### `credential_hash` — what an issuer signs

```text
poseidon(['CORDON_CREDENTIAL:V1', issuer_id, credential_id, subject_public_key, claim, expires_at])
```

It binds no chain and no gate on purpose: a credential is a portable statement about a subject,
valid at any gate that trusts the same issuer registry. Scoping a credential to a use is the
policy's job.

### `subject_action_hash` — what a subject signs

```text
poseidon(['CORDON_SUBJECT_ACTION:V2', chain_id, gate_address, policy_id, note_id, token, amount, nonce])
```

This one is bound tightly, because it says "move this exact value, here, once". One preimage serves
all four legs, and what each leg puts in it differs:

| Leg | Signer | `policyId` | `noteId` | `amount` |
| --- | --- | --- | --- | --- |
| `Direct` | payer | the payer policy | the resolved open note id | what the pool sent |
| `Fund` | payer | the payer policy | `FUND_NOTE_ID` (zero) | what the pool sent |
| `Claim` | payee | the settlement's `payeeClaimPolicyId` | the payee's own note id | the settlement's amount |
| `Refund` | payer | the settlement's `payerPolicyId` | the payer's own note id | the settlement's amount |

### Nonces are global to the gate, not per leg

**A nonce is single-use across all four legs.** One registry keyed by
`(subject_public_key, nonce)` serves `Direct`, `Fund`, `Claim` and `Refund` alike. That is
load-bearing: the leg is deliberately *not* in the signed message, and what stops a signature made
for one leg being replayed on another is that it would replay its nonce and be refused with
`CORDON_NONCE_USED`. So never reuse a nonce, even for a different leg, and never assume a nonce
"belongs" to a flow. `randomNonce()` gives you sixteen random bytes, which is far past what a
collision needs.

### The note id

The subject signs the *resolved* note id, not the `"${openNoteIds[0]}"` placeholder: the wallet
substitutes the placeholder in the calldata, but the gate hashes what it actually received. Your
app therefore needs the resolved id **before** it asks the subject to sign. On a `Fund` there is no
open note at all and the signed value is `FUND_NOTE_ID` (zero) — the SDK sends zero in the calldata
too, so the two always agree.

## Keys

A subject key is a pseudonym. It is not a wallet key and must never be one: nonce replay protection
and velocity accounting are keyed by it, so binding it to an address would undo the privacy the
pool provides.

```ts
// Generate and store.
const subject = generateSubjectKeypair();

// Or derive it from the wallet, so nothing has to be stored.
const data = subjectKeyTypedData({ chainId: "SN_MAIN" });
const signature = await wallet.signMessage(data);
const subject = deriveSubjectKeypair({ signature });
```

Derivation is only as reproducible as the wallet's signer. Every starknet.js-based signer is
deterministic (RFC 6979), which is what makes it work. Derive twice and compare the public keys
before you rely on it; if they differ, generate and back up a key instead.

Pass a `context` to hold several unlinked pseudonyms under one wallet:

```ts
deriveSubjectKeypair({ signature, context: "treasury" });
```

## Credentials

```ts
import { credentialFromJson, encodeCredential, validateCredential } from "@cordon/sdk";

// Compact, fixed-width, URL and QR safe — 268 characters for every credential.
const link = `https://your.app/passport#c=${encodeCredential(credential)}`;

// Check it locally before anyone pays for a transaction.
const check = validateCredential(credential, {
  issuerPublicKey,
  requiredClaim: "ACCREDITED",
  revokedCredentialIds,
});
check.refusals;  // named with the same panic codes the gate raises
check.skipped;   // what could not be checked, rather than assumed to pass
```

`validateCredential` and `preflight` both report `skipped` for anything they lacked the chain state
to check. A pre-flight that quietly skips the revocation check and says "allowed" is worse than one
that admits what it does not know.

## Predicting a refusal

`preflight` runs the gate's checks in the gate's own order and tells you which one would fire:

```ts
const result = preflight({
  policy,            // policyFromCalldata(await gate.get_policy(policyId))
  credential,
  amount,
  issuerPublicKey,
  issuerActive,
  revokedCredentialIds,
  nonceUsed,
  epochSpend,
});

result.refusal?.title;          // "Over the policy's limit for this period"
result.remainingThisEpoch;      // 500n
result.epochResetsAt;           // unix seconds
```

For two-step settlements, `settlementOptions` answers the same question about the escrow itself:

```ts
const options = settlementOptions(settlementFromCalldata(raw));
options.claimable;              // false
options.claimRefusal?.code;     // "CORDON_CLAIM_EXPIRED"
options.refundable;             // true
```

## Refusals

Every panic code in `contracts/src/errors.cairo` decodes to a `Refusal`:

```ts
{
  code: "CORDON_OVER_CAP",
  title: "Over the policy's per-transaction cap",
  explanation: "The amount is larger than the most this policy lets one settlement move. …",
  source: "gate",
  remedy: "payer",   // "payer" | "issuer" | "operator" | "integrator"
  step: 10,          // position in the gate's enforcement order
}
```

`remedy` is what a UI should branch on. Telling a payer to "contact your issuer" when they merely
need to send less is the difference between a useful refusal and a dead end.

`decodeRefusal(revertReason)` reads a raw reason; `decodeRefusalFromError(error)` walks a thrown
wallet or provider error and digs the reason out of `message`, `data`, `execution_error` and nested
causes. Both always return a `Refusal` — an unrecognised revert comes back as `code: "UNKNOWN"`
with the raw text, so a UI has exactly one shape to render.

A test parses `errors.cairo` and asserts every code declared there has an entry here, and that this
package decodes no code the contracts no longer raise. The registry cannot silently fall behind the
Cairo.

## Why the conformance tests matter

Cordon verifies two STARK-curve signatures on every settlement, both against a Poseidon hash the
signer computed off chain. If this package's hashes differ from the contracts' by a single field, a
single byte of a tag, or a single element of ordering, then every signature it produces is refused
as `CORDON_BAD_CRED` or `CORDON_BAD_SUBJECT_SIG` — and nothing in the revert says why.

So `test/conformance.test.ts` does three things on every run:

1. Asserts the fixture vectors pinned as literals, copied from
   `contracts/src/tests/test_hashing.cairo`.
2. Reads those same vectors back out of the Cairo source and recomputes them here, so the two sides
   cannot drift apart without a failure.
3. Reads the domain tags out of `contracts/src/hashing.cairo`, because a tag version bump is exactly
   the change that produces silently unverifiable signatures.

The current pins:

| Hash | Value |
| --- | --- |
| `credential_hash` | `0x33416da028165a7c7d2799315f717493f4ffe5379a4f1efe7fb85e1244db1b5` |
| `subject_action_hash` | `0x1d07660058550812f9d317014bcb9a843f55a2ed9362642fdb0c0eb2eca65e9` |

`npm run vectors` prints the full felt tables for both, ready to paste into a Cairo test.

## What Cordon does not do

The pool hands an anonymizer a plaintext ERC20 balance, never note amounts. Caps and velocity are
genuinely enforceable because value routes through the gate. **Rules over encrypted amounts are not
possible here and are not claimed.** The amount and the fact a policy check passed are public; the
payer and the payee are not.

## API surface

| Area | Exports |
| --- | --- |
| Field elements | `toFelt` `toBigInt` `toAddress` `shortStringToFelt` `feltToShortString` `feltEquals` `isFelt` `padFelt` `toU64Felt` `toU128Felt` |
| Hashing | `credentialHash` `credentialPreimage` `subjectActionHash` `subjectActionPreimage` `poseidon` `DOMAIN_TAGS` `CREDENTIAL_TAG` `SUBJECT_ACTION_TAG` |
| Keys | `generateSubjectKeypair` `deriveSubjectKeypair` `subjectKeyTypedData` `subjectKeyMessageHash` `subjectPublicKey` `signHash` `verifyHash` `signCredential` `verifyCredentialSignature` `signSubjectAction` `verifySubjectAction` `randomNonce` |
| Credentials | `issueCredential` `createCredential` `validateCredential` `summarizeCredential` `credentialToJson` `credentialFromJson` `credentialCalldata` `credentialFromCalldata` `encodeCredential` `decodeCredential` `credentialUri` |
| Policies | `createPolicy` `policyCalldata` `policyFromCalldata` `describePolicy` `currentEpoch` `epochResetsAt` `preflight` |
| Settlements | `settlementFromCalldata` `settlementCalldata` `settlementOptions` `settlementStatusFromFelt` `SETTLEMENT_STATUS_VARIANT` |
| Operations | `authorizeAction` `signAction` `encodeGateOperation` `encodeSubjectAuthorization` `encodePrivacyInvokeCalldata` `encode{Direct,Fund,Claim,Refund}Calldata` `build{Direct,Fund,Claim,Refund}Actions` `FUND_NOTE_ID` `GATE_OPERATION_VARIANT` |
| Actions | `validateActions` `assertValidActions` `withdrawAction` `openNoteAction` `transferAction` `depositAction` `invokeAction` `calldataItem` `isPlaceholder` `formatActions` `OPEN_NOTE` `POOL_ADDRESS_PLACEHOLDER` `openNoteIdPlaceholder` `WALLET_PLACEHOLDERS` |
| Refusals | `decodeRefusal` `decodeRefusals` `decodeRefusalFromError` `refusalForCode` `refusalCodes` `allRefusals` `unknownRefusal` |
| Encoding | `encodeBase64Url` `decodeBase64Url` |

## Development

```sh
npm install
npm test          # vitest, including the Cairo conformance suite
npm run build     # tsup, ESM + CJS + types
npm run typecheck
npm run vectors   # print the conformance vectors
```

The conformance and refusal tests read `contracts/` from the repository, so they run from a
checkout of the monorepo rather than from an installed package.

## Licence

MIT.
