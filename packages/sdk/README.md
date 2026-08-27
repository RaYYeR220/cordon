# `@cordon/sdk`

Credential and policy gate for shielded STRK20 value on Starknet.

Cordon routes shielded value through a Cairo anonymizer, so a policy is not a report generated
afterwards — it is a gate. An unaccredited, revoked, sanctioned, over-cap or over-velocity payer
cannot move pool funds at all: the gate panics and the whole pool transaction reverts.

This package is everything the off-chain side of that needs: the hash preimages the contracts
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
  authorizeDirect,
  buildDirectActions,
  decodeRefusalFromError,
  fetchGateContext,
  generateSubjectKeypair,
} from "@cordon/sdk";

// 1. A pseudonym, generated locally. This is never a wallet address.
const subject = generateSubjectKeypair();

// 2. …hand `subject.publicKey` to an issuer, get a credential back. (See services/issuer.)

// 3. Read the chain id and the pool from the chain. Never from a config file — see below.
const context = await fetchGateContext(provider, GATE_ADDRESS);

// 4. Authorise exactly one settlement, for exactly one amount.
const payment = authorizeDirect(
  {
    context,
    token: STRK,
    policyId: "PAY_ACCREDITED_V1",
    credential,
    amount: 400_000000000000000000n,
    noteId: resolvedNoteId,   // see "The note id" below
  },
  subject.privateKey,
);

// 5. Build the transaction. There is no `amount` here: it comes from the signed authorisation.
const actions = buildDirectActions({ authorization: payment, payee: PAYEE_ADDRESS });

try {
  await wallet.strk20InvokeTransaction({ actions });
} catch (error) {
  // 6. The refusal is the product.
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
| `Claim` | **the named payee** | `transfer(OPEN, self)` → `invoke` | the payee's open note |
| `Refund` | payer | `transfer(OPEN, self)` → `invoke` | the payer's open note |

`Direct` is a gated private payment in one transaction. `Fund`/`Claim` exists because a payer
cannot vouch for a payee — the gate never sees who the `transfer(OPEN)` credits — so a policy that
requires a payee credential can only be satisfied by the payee authenticating themselves, with
their own key, in their own transaction, at the moment they take the money. A settlement names the
payee, so only that pseudonym can claim it. `Refund` closes the loop after the claim window shuts.

Every leg is two calls: sign it, then build the transaction from what you signed.

```ts
const payment  = authorizeDirect({ context, token, policyId, credential, amount, noteId }, key);
const escrow   = authorizeFund({ context, token, policyId, credential, amount,
                                 payeeSubjectKey, payeeClaimPolicyId, expiresAt }, key);
const taking   = authorizeClaim({ context, settlement, settlementId, credential, noteId }, key);
const takeBack = authorizeRefund({ context, settlement, settlementId, noteId }, key);

buildDirectActions({ authorization: payment, payee });
buildFundActions({ authorization: escrow });
buildClaimActions({ authorization: taking, recipient });
buildRefundActions({ authorization: takeBack, recipient });
```

`encodeGateCalldata(authorization)` gives you just the flat felt array for the `invoke` action, if
you are assembling the transaction yourself.

## The amount is written once, on purpose

The gate settles the amount inside the signed authorisation and consults its own balance only to
check it can cover it. It never derives an amount from `balance_of`, because `balance_of` is a
permissionlessly writable global — a stranger could otherwise inflate, deflate or block a payment
somebody had already signed.

That makes the `withdraw` action and the signature two places that must name the same number, and
the failure modes are silent and asymmetric:

- withdrawing **more** than was signed leaves the difference at the gate as dust the payer cannot
  recover (the known residual in `contracts/README.md`);
- withdrawing **less** is refused with `CORDON_UNDERFUNDED`, after the user has paid for the
  transaction.

**So no builder in this package takes an `amount`.** It is written once, when you sign, and
`buildDirectActions` and `buildFundActions` read it back off the authorisation. There is no second
place to put a number, so the two cannot disagree. The same is true of the settlement terms, the
token, the gate and the pool: an `authorize*` call is the only place any of them is stated, and the
matching builder takes the result whole. `Claim` and `Refund` emit no `withdraw` at all, so nothing
can be stranded there either.

## Read the pool from the chain

`chain_id`, `gate_address` and `pool_address` are all inside the signed message. Two of them are
easy to get wrong from configuration, and both failures cost a transaction:

```ts
const context = await fetchGateContext(provider, GATE_ADDRESS, { expectedPool: CONFIGURED_POOL });
```

`fetchGateContext` reads the chain id from the provider and `privacy_pool()` from the gate itself.
Pass `expectedPool` to cross-check what you have configured; a mismatch throws immediately, loudly,
before anything is signed, rather than becoming a `CORDON_BAD_POOL` revert. `assertGateContext`
re-checks a context you already hold — worth doing whenever a wallet reports a network change,
since a context built for one chain silently produces unverifiable signatures on another.

The `provider` argument is structural: anything with `getChainId()` and `callContract()`, which
`starknet`'s `RpcProvider` satisfies as-is.

## The three literals you must not touch

The wallet substitutes three strings while it assembles a STRK20 transaction. They travel as plain
strings. Hex-encoding any of them breaks the substitution, and the failure is silent until the gate
refuses with `CORDON_BAD_POOL`.

| Literal | Where it goes |
| --- | --- |
| `"OPEN"` | the `amount` of the transfer that reserves an open note |
| `"${poolAddress}"` | the `pool_address` argument |
| `"${openNoteIds[0]}"` | the `note_id` argument |

Every encoder here routes through `calldataItem`, which recognises them and passes them through
untouched. `isPlaceholder` is exported so you can assert it yourself.

`validateActions` checks an array against the pool's assembly rules before you pay a wallet
round-trip to learn the same thing: no empty arrays, no invoke-only arrays (the wallet answers
`INVALID_REQUEST_PAYLOAD`), at most one invoke, phases non-decreasing.

## Signing

Three hashes, all reproduced here field for field.

### `credential_hash` — what an issuer signs

```text
poseidon(['CORDON_CREDENTIAL:V1', issuer_id, credential_id, subject_public_key, claim, expires_at])
```

Still `:V1`, deliberately. It binds no chain and no gate: a credential is a portable statement about
a subject, valid at any gate that trusts the same issuer registry. Scoping a credential to a use is
the policy's job.

### `settlement_terms_hash` — the terms nested in an action

```text
poseidon(['CORDON_SETTLEMENT_TERMS:V1', settlement_id, payee_subject_key, payee_claim_policy_id, expires_at])
```

It has its own domain tag even though it is only ever nested, so its digest can never be mistaken
for a hash of some other four-felt structure. **`Direct` uses a literal `0`, not this hash of four
zeros** — `DIRECT_TERMS_HASH` is exported so you never have to remember that.

### `subject_action_hash` — what a subject signs

```text
poseidon(['CORDON_SUBJECT_ACTION:V3', chain_id, gate_address, pool_address, leg,
          policy_id, note_id, token, amount, nonce, terms_hash])
```

Eleven elements, bound tightly, because it says "move this exact value, here, once". One preimage
serves all four legs:

| Leg | Signer | `policyId` | `noteId` | `amount` | `termsHash` |
| --- | --- | --- | --- | --- | --- |
| `Direct` | payer | the payer policy | the resolved open note id | what the pool withdrew | `0` |
| `Fund` | payer | the payer policy | `FUND_NOTE_ID` (zero) | what the pool withdrew | all four terms |
| `Claim` | payee | the settlement's `payeeClaimPolicyId` | the payee's own note id | the settlement's amount | the id, rest zero |
| `Refund` | payer | the settlement's `payerPolicyId` | the payer's own note id | the settlement's amount | the id, rest zero |

The `authorize*` functions fill this table for you, and `authorizeClaim`/`authorizeRefund` take the
`Settlement` record itself rather than loose fields, so a claim cannot be signed for the wrong
amount or judged against the wrong policy.

### Why the leg is in the message

`:V2` left the leg and the settlement terms out and justified it with the shared nonce registry.
That argument was wrong, and an audit caught it. The nonce registry stops a signature being used a
*second* time; it says nothing about the *first* use being the wrong one. Under `:V2`, a payer who
signed a `Direct` payment into their own note had — same signature, same nonce, one entirely
legitimate use — also authorised a `Fund` parking that money in an escrow whose id, payee, claim
policy and expiry were chosen by whoever assembled the transaction. `:V3` fixes the message.

### Nonces are global to the gate, not per leg

**A nonce is single-use across all four legs.** One registry keyed by `(subject_public_key, nonce)`
serves `Direct`, `Fund`, `Claim` and `Refund` alike. Never reuse one, even for a different leg. The
`authorize*` functions draw a fresh 128-bit nonce unless you pass one.

### The note id

The subject signs the *resolved* note id, not the `"${openNoteIds[0]}"` placeholder: the wallet
substitutes the placeholder in the calldata, but the gate hashes what it actually received. Your app
therefore needs the resolved id **before** it asks the subject to sign. On a `Fund` there is no open
note at all and the signed value is `FUND_NOTE_ID` (zero) — the SDK sends zero in the calldata too,
so the two always agree, and `encodeGateCalldata` refuses a note id override that disagrees with
what was signed.

## Settlement ids must be random

`authorizeFund` generates one from the platform CSPRNG and returns it on the result. Supplying your
own is possible, but `assertUnguessableSettlementId` refuses anything under 64 bits of entropy or
anything that decodes as text.

That is a hard failure rather than a warning because the failure mode is expensive: funding is
permissionless and an id is single-use forever, so an invoice number or a counter can be burned
ahead of you by a stranger for the price of one unit, after which your funding reverts with
`CORDON_SETTLEMENT_EXISTS`. It is also the only handle in the event log, so a guessable id is a
correlation key tying a funding to a claim to a business record.

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
  policy,                 // policyFromCalldata(await gate.get_policy(policyId))
  credential,
  amount,
  token,                  // checks the policy's token pin
  unaccountedBalance,     // balance_of - accounted_balance(token); catches CORDON_UNDERFUNDED
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

For two-step settlements, `settlementOptions` answers the same question about the escrow itself,
including whether a given claimant is the payee the payer named:

```ts
const options = settlementOptions(settlementFromCalldata(raw), { claimantSubjectKey });
options.claimable;              // false
options.claimRefusal?.code;     // "CORDON_NOT_THE_PAYEE"
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
package decodes no code the contracts no longer raise. The registry cannot silently fall behind.

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
3. Reads the domain tags and the four leg tags out of `contracts/src/hashing.cairo`, because a tag
   version bump is exactly the change that produces silently unverifiable signatures.

The current pins:

| Hash | Value |
| --- | --- |
| `credential_hash` | `0x33416da028165a7c7d2799315f717493f4ffe5379a4f1efe7fb85e1244db1b5` |
| `settlement_terms_hash` | `0x4d1dba11f958448bb5b3d4b7e39ebba33b79ca80ea191539bc1868a628f7d3d` |
| `subject_action_hash` | `0x699b15a2d12d1e8df2bc0aaafd30dfdf1eb8b48380496855dc89b85ada49c83` |

`npm run vectors` prints the full felt tables for all three, ready to paste into a Cairo test.

## What Cordon does not do

The pool hands an anonymizer plaintext amounts, never note amounts. Caps and velocity are genuinely
enforceable because value routes through the gate. **Rules over encrypted amounts are not possible
here and are not claimed.** The amount and the fact a policy check passed are public; the payer and
the payee are not.

## API surface

| Area | Exports |
| --- | --- |
| Field elements | `toFelt` `toBigInt` `toAddress` `shortStringToFelt` `feltToShortString` `feltEquals` `isFelt` `padFelt` `toU64Felt` `toU128Felt` `randomFelt` |
| Hashing | `credentialHash` `settlementTermsHash` `quotedSettlementHash` `subjectActionHash` `*Preimage` `poseidon` `DOMAIN_TAGS` `LEG_TAGS` `DIRECT_TERMS_HASH` `CREDENTIAL_TAG` `SUBJECT_ACTION_TAG` `SETTLEMENT_TERMS_TAG` |
| Context | `fetchGateContext` `assertGateContext` `createGateContext` `GateContextError` |
| Keys | `generateSubjectKeypair` `deriveSubjectKeypair` `subjectKeyTypedData` `subjectKeyMessageHash` `subjectPublicKey` `signHash` `verifyHash` `signCredential` `verifyCredentialSignature` `signSubjectAction` `verifySubjectAction` `randomNonce` |
| Credentials | `issueCredential` `createCredential` `validateCredential` `summarizeCredential` `credentialToJson` `credentialFromJson` `credentialCalldata` `credentialFromCalldata` `encodeCredential` `decodeCredential` `credentialUri` |
| Policies | `createPolicy` `policyCalldata` `policyFromCalldata` `describePolicy` `currentEpoch` `epochResetsAt` `preflight` |
| Settlements | `settlementFromCalldata` `settlementCalldata` `settlementOptions` `settlementStatusFromFelt` `randomSettlementId` `assertUnguessableSettlementId` `SETTLEMENT_STATUS_VARIANT` |
| Operations | `authorizeDirect` `authorizeFund` `authorizeClaim` `authorizeRefund` `build{Direct,Fund,Claim,Refund}Actions` `buildActions` `encodeGateCalldata` `encodeGateOperation` `encodeSubjectAuthorization` `FUND_NOTE_ID` `GATE_OPERATION_VARIANT` |
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
