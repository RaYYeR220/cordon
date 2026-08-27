# Cordon hash preimages

Cordon verifies two STARK-curve signatures on every settlement, and both are checked against a
Poseidon hash the signer computed off-chain. If your implementation of these hashes differs from
the contract's by a single field or a single byte of a tag, every signature you produce is refused
with `CORDON_BAD_CRED` or `CORDON_BAD_SUBJECT_SIG` and there is nothing in the revert to tell you
why. So these preimages are a public contract, not an implementation detail.

Authoritative source: [`src/hashing.cairo`](src/hashing.cairo).
Pinned by: [`src/tests/test_hashing.cairo`](src/tests/test_hashing.cairo) — including tests that
recompute each hash from the literal felt list printed below, so this document cannot drift from
the code without a test failing.

> **`:V4` is a breaking change.** The action preimage replaced the raw note id with a note
> *binding* and added the authorisation's own deadline. Any `:V3` signature is now refused. See
> [Why `:V4`](#why-v4-the-signer-cannot-know-the-note-id) and
> [Why `:V3`](#why-v3-the-argument-v2-made-was-wrong).

## Primitives

- **Hash**: `poseidon_hash_span` over a flat `Span<felt252>` — the Starknet Poseidon sponge.
  In TypeScript: `poseidonHashMany` from `starknet` / `micro-starknet`.
- **Signature**: STARK-curve ECDSA, verified with `core::ecdsa::check_ecdsa_signature`.
  In TypeScript: `ec.starkCurve.sign(msgHash, privateKey)`.
- **Field widening**: `u64` and `u128` values are widened to `felt252` unchanged;
  a `ContractAddress` is its felt value. No packing, no offsets, no length prefix.
- **Short strings**: `'ACCREDITED'` is the ASCII bytes read big-endian as an integer, the standard
  Cairo short-string encoding (`shortString.encodeShortString` in `starknet`).

## Domain-separation tags

Template: `CORDON_<PURPOSE>:V<VERSION>`. The tag is the first element of every preimage. It is what
stops one hash being replayed as another, since a subject may hold keys used in several roles. A
change to a field list means a new tag, never a silent reinterpretation of signatures already in
circulation.

| Tag | Short string | felt (hex) |
| --- | --- | --- |
| Credential | `CORDON_CREDENTIAL:V1` | `0x434f52444f4e5f43524544454e5449414c3a5631` |
| Subject action | `CORDON_SUBJECT_ACTION:V4` | `0x434f52444f4e5f5355424a4543545f414354494f4e3a5634` |
| Settlement terms | `CORDON_SETTLEMENT_TERMS:V1` | `0x434f52444f4e5f534554544c454d454e545f5445524d533a5631` |

### Leg tags

Which of the four `GateOperation` legs an authorisation is for.

| Leg | Short string | felt (hex) |
| --- | --- | --- |
| `Direct` | `CORDON_LEG_DIRECT` | `0x434f52444f4e5f4c45475f444952454354` |
| `Fund` | `CORDON_LEG_FUND` | `0x434f52444f4e5f4c45475f46554e44` |
| `Claim` | `CORDON_LEG_CLAIM` | `0x434f52444f4e5f4c45475f434c41494d` |
| `Refund` | `CORDON_LEG_REFUND` | `0x434f52444f4e5f4c45475f524546554e44` |

These are short strings rather than the enum's discriminant on purpose. A discriminant is a
position, and positions move when someone adds a variant; a tag means the same thing forever and is
legible in a raw calldata dump.

## Why `:V4`: the signer cannot know the note id

`:V3` put the resolved `note_id` in the signed message. On the Wallet API route — the only route
that works on mainnet — that is not something the signer can produce.

The application submits the literal placeholder `"${openNoteIds[0]}"` and the *wallet* substitutes
the resolved felt at submission time. The value is
`poseidon(NOTE_ID_TAG, channel_key, token, index, 0)`, and `channel_key` is
`poseidon(CHANNEL_KEY_TAG, sender_addr, sender_private_key, recipient_addr, recipient_public_key)` —
it commits to the **wallet's private key**. An application cannot compute it, and the pool's own
documentation says as much: *"That indirection is what lets you reference a note that does not
exist yet at the time you build the calldata."* Under `:V3`, `Fund` (which signs `note_id = 0`) was
signable and `Direct`, `Claim` and `Refund` were not.

Dropping the note from the message is not a safe fix, and it is worth being exact about why,
because the argument decides the design. Consider a `Claim`. If the message does not name the
destination, then anyone who obtains the payee's authorisation before it is consumed can resubmit
it pointing at a note of their own — the gate still sees the payee's credential, the payee's
signature, and a subject key matching the stored payee, so every check passes and the money lands
in the thief's note. **That is reachable without any privileged position:** a reverted transaction
is included on Starknet with its full calldata (execution status `REVERTED`), and a revert does not
burn the nonce, so a claim that fails for any ordinary reason — an expired window, an over-velocity
refusal, too little shielded balance for the pool's fee — publishes a live authorisation to the
whole chain. The hostile-assembler case in the `:V3` threat model gets there too, immediately.

So `:V4` keeps the destination in the message but lets the signer say which of two things they can
honestly commit to:

- **`note_binding = note_id`** — the strong mode. The gate asserts the transaction fills exactly
  that note, and a harvested authorisation is worthless: a thief would have to create a note with
  that id, and a note id commits to its owner's channel key. This mode *is* reachable —
  `strk20PrepareInvoke` returns `{ call, proof }` where `call` is a fully resolved Starknet `Call`,
  so the resolved note id is in `call.calldata`. Prepare once to learn the note, sign, prepare
  again to submit. The id is stable across that round trip because none of its inputs depend on the
  invoke calldata: only the channel key, the token and the note index, and the index moves only if
  another transaction lands on the same channel in between — in which case the second prepare
  produces a different id and the transaction fails closed rather than paying the wrong party.
- **`note_binding = NOTE_ANY`** — the weak mode, for flows where the resolved id genuinely cannot
  be obtained before signing. The gate accepts whichever note the transaction fills, which is
  exactly the redirection exposure described above. It is not free: an unbound authorisation
  **must** carry a `valid_until`, and the gate refuses one further out than **600 seconds**. That
  turns "redirectable until the nonce burns" — which, for a reverted transaction, is forever — into
  a window an attacker has to already be watching for.

The choice is *inside the signed message*, so a subject can see which one they made. The gate does
not silently drop the binding on anyone's behalf.

`valid_until` is also a signed field in the strong mode, where `0` (no deadline) is allowed: a
bound authorisation is not redirectable, so it does not need to die on a clock.

## Why `:V3`: the argument `:V2` made was wrong

`:V2` left the leg and the settlement terms out of the signed message, and this document justified
it like this:

> The leg itself is not in the message. It does not need to be, because every leg consumes a nonce
> against the signing subject's key, so a signature carried from one leg to another always replays
> its nonce and is refused.

**That is a non-sequitur, and it cost real money in review.** The nonce registry prevents a
*second* use of a signature. It says nothing about the *first* use being the wrong one. Under
`:V2`, a payer who signed a `Direct` payment into their own note had — with the same signature, the
same nonce, one single legitimate use — also authorised a `Fund` parking that money in an escrow
whose id, payee, claim policy and expiry were chosen by whoever assembled the action array. The
nonce was spent exactly once. The payer's money was gone.

`:V3` fixes the message rather than the argument. It adds:

- **`pool_address`** — so an authorisation cannot be executed against a different pool, and so the
  address the subject signed is the address the gate approves.
- **`leg`** — so a payment cannot be re-typed as an escrow, or a refund as a payment.
- **`terms_hash`** — so every term of a settlement is something the payer agreed to, and so a claim
  or refund signature names the one settlement it is for.

The nonce registry is still there, and it is still worth having; it is a replay guard, which is all
it ever was.

## 1. `credential_hash` — what an issuer signs

```
credential_hash = poseidon_hash_span([
    'CORDON_CREDENTIAL:V1',   // domain tag
    issuer_id,                // felt252
    credential_id,            // felt252
    subject_public_key,       // felt252, STARK-curve public key (x-coordinate)
    claim,                    // felt252, short string such as 'ACCREDITED'
    expires_at,               // u64 widened to felt252, unix seconds
])
```

Six elements, in that order. `sig_r` and `sig_s` are **not** in the preimage — they are the
signature over it.

The issuer signs this with the key registered under `issuer_id` in the `IssuerRegistry`. Because
every asserted field is covered, no one can swap the claim, the subject or the expiry underneath
the issuer's signature.

Payer and payee credentials are the same object signed the same way. The claim leg of a two-step
settlement runs a payee's credential through exactly this hash and exactly the checks a payer's
goes through.

**Unchanged at `:V1`, deliberately.** A credential is a portable statement about a subject — "this
pseudonym is accredited" — true at every gate that trusts the same issuer, on every network.
Binding it to one deployment would force an issuer to re-attest per venue for no security gain.
Scoping a credential to a use is the policy's job. An action authorisation is the opposite kind of
statement, which is why it is bound to everything it can be.

## 2. `settlement_terms_hash` — the terms nested inside an action

```
settlement_terms_hash = poseidon_hash_span([
    'CORDON_SETTLEMENT_TERMS:V1',
    settlement_id,          // felt252
    payee_subject_key,      // felt252, zero on Claim and Refund
    payee_claim_policy_id,  // felt252, zero on Claim and Refund
    expires_at,             // u64 widened to felt252, zero on Claim and Refund
])
```

Five elements. It gets its own tag even though it is only ever nested, so its digest can never be
mistaken for a hash of some other four-felt structure.

- **`Fund`** fills every field: the payer is agreeing to all of them.
- **`Claim`** and **`Refund`** fill only `settlement_id` and zero the rest. They do not set terms,
  they quote an id — and binding that id is what stops one claim signature being valid for any open
  settlement that happens to share a claim policy, a token and an amount.
- **`Direct`** has no settlement and uses a terms hash of **literal `0`**, not the hash of four
  zeros. (`settlement_terms_hash(0,0,0,0)` is a large non-zero felt; do not use it here.)

## 3. `subject_action_hash` — what a subject signs

```
subject_action_hash = poseidon_hash_span([
    'CORDON_SUBJECT_ACTION:V4',  // domain tag
    chain_id,                    // felt252, get_tx_info().unbox().chain_id
    gate_address,                // ContractAddress -> felt252, the verifying PolicyGate
    pool_address,                // ContractAddress -> felt252, the pool that will pull the value
    leg,                         // felt252, one of the leg tags above
    policy_id,                   // felt252
    note_binding,                // felt252, the open note to fill, or NOTE_ANY (0 on Fund)
    valid_until,                 // u64 widened to felt252, unix seconds; 0 means no deadline
    token,                       // ContractAddress -> felt252
    amount,                      // u128 widened to felt252, token base units
    nonce,                       // felt252, chosen by the subject
    terms_hash,                  // felt252, see above; literal 0 on Direct
])
```

Twelve elements, in that order.

`NOTE_ANY` is the short string `CORDON_NOTE_ANY` =
`0x434f52444f4e5f4e4f54455f414e59`.

The subject signs this with the private key behind the `subject_public_key` their credential names.
Holding a credential is not the same as authorising a payment: the credential says who the subject
is, this says that this subject wants this value moved, on this leg, under this policy, at this
contract, through this pool, once.

`amount` is authoritative. The gate takes the amount from the signed authorisation and uses its own
balance only to check it can cover it — it never derives an amount from `balance_of`, because
`balance_of` is a permissionlessly writable global and a stranger could otherwise inflate, deflate
or block a payment the subject had already signed.

### What each leg signs

| Leg | Signer | `policy_id` | `note_binding` | `amount` | `terms_hash` |
| --- | --- | --- | --- | --- | --- |
| `Direct` | payer | the payer policy | the resolved `${openNoteIds[0]}`, or `NOTE_ANY` | what the pool withdrew | `0` |
| `Fund` | payer | the payer policy | **must be `0`** — the array is `withdraw → invoke`, there is no note, and `NOTE_ANY` is refused here | what the pool withdrew | all four terms |
| `Claim` | **payee** | the settlement's `payee_claim_policy_id` | the payee's resolved `${openNoteIds[0]}`, or `NOTE_ANY` | the settlement's amount | the settlement id, rest zero |
| `Refund` | payer | the settlement's `payer_policy_id` | the payer's resolved `${openNoteIds[0]}`, or `NOTE_ANY` | the settlement's amount | the settlement id, rest zero |

`valid_until` may be `0` only when `note_binding` names a note. With `NOTE_ANY` it is mandatory and
must be within 600 seconds of the block the transaction lands in.

## Pinned test vectors

Every value below is asserted in `src/tests/test_hashing.cairo`, twice each: once through the Cairo
functions and once from the literal felt list. Use them as the first thing your SDK's test suite
checks.

### Credential

| Field | Value | felt (hex) |
| --- | --- | --- |
| tag | `CORDON_CREDENTIAL:V1` | `0x434f52444f4e5f43524544454e5449414c3a5631` |
| `issuer_id` | `CORDON_KYC` | `0x434f52444f4e5f4b5943` |
| `credential_id` | `CRED_0001` | `0x435245445f30303031` |
| `subject_public_key` | — | `0x1ce8adcb0d0e5e0d0a3e2b8b8f9e5c3b2a1908070605040302010f0e0d0c0b0` |
| `claim` | `ACCREDITED` | `0x41434352454449544544` |
| `expires_at` | `1800086400` | `0x6b4b2380` |

```
credential_hash = 0x33416da028165a7c7d2799315f717493f4ffe5379a4f1efe7fb85e1244db1b5
```

### Settlement terms

| Field | Value | felt (hex) |
| --- | --- | --- |
| tag | `CORDON_SETTLEMENT_TERMS:V1` | `0x434f52444f4e5f534554544c454d454e545f5445524d533a5631` |
| `settlement_id` | `stl_0` | `0x73746c5f30` |
| `payee_subject_key` | — | `0x066ee00a11ce00a11ce00a11ce00a11ce00a11ce00a11ce00a11ce00a11ce00` |
| `payee_claim_policy_id` | `RECV_KYC_L2_V1` | `0x524543565f4b59435f4c325f5631` |
| `expires_at` | `1800007200` | `0x6b49ee20` |

```
settlement_terms_hash = 0x4d1dba11f958448bb5b3d4b7e39ebba33b79ca80ea191539bc1868a628f7d3d
```

### Subject action (a `Fund` leg)

| Field | Value | felt (hex) |
| --- | --- | --- |
| tag | `CORDON_SUBJECT_ACTION:V4` | `0x434f52444f4e5f5355424a4543545f414354494f4e3a5634` |
| `chain_id` | `SN_MAIN` | `0x534e5f4d41494e` |
| `gate_address` | — | `0x02c0de00c0de00c0de00c0de00c0de00c0de00c0de00c0de00c0de00c0de001` |
| `pool_address` | — | `0x0900100c0011ea1100c0011ea1100c0011ea1100c0011ea1100c0011ea11002` |
| `leg` | `CORDON_LEG_FUND` | `0x434f52444f4e5f4c45475f46554e44` |
| `policy_id` | `PAY_ACCREDITED_V1` | `0x5041595f414343524544495445445f5631` |
| `note_binding` | `0` (funding leg) | `0x0` |
| `valid_until` | `1800000300` | `0x6b49d32c` |
| `token` | STRK | `0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d` |
| `amount` | `400` | `0x190` |
| `nonce` | `nonce_0` | `0x6e6f6e63655f30` |
| `terms_hash` | the settlement terms above | `0x4d1dba11f958448bb5b3d4b7e39ebba33b79ca80ea191539bc1868a628f7d3d` |

```
subject_action_hash = 0x15954b6b284f2575533fda03c443131d11a5217061cf1cae05b5055af9c6a22
```

## Reproducing it in TypeScript

```ts
import { ec, hash, num, shortString } from "starknet";

const CREDENTIAL_TAG = shortString.encodeShortString("CORDON_CREDENTIAL:V1");
const SUBJECT_ACTION_TAG = shortString.encodeShortString("CORDON_SUBJECT_ACTION:V4");
export const NOTE_ANY = shortString.encodeShortString("CORDON_NOTE_ANY");
const SETTLEMENT_TERMS_TAG = shortString.encodeShortString("CORDON_SETTLEMENT_TERMS:V1");

export const LEG = {
  direct: shortString.encodeShortString("CORDON_LEG_DIRECT"),
  fund: shortString.encodeShortString("CORDON_LEG_FUND"),
  claim: shortString.encodeShortString("CORDON_LEG_CLAIM"),
  refund: shortString.encodeShortString("CORDON_LEG_REFUND"),
} as const;

export function credentialHash(c: {
  issuerId: string;
  credentialId: string;
  subjectPublicKey: string;
  claim: string;
  expiresAt: bigint;
}): string {
  return num.toHex(
    hash.computePoseidonHashOnElements([
      CREDENTIAL_TAG,
      c.issuerId,
      c.credentialId,
      c.subjectPublicKey,
      c.claim,
      num.toHex(c.expiresAt),
    ]),
  );
}

export function settlementTermsHash(t: {
  settlementId: string;
  payeeSubjectKey: string;
  payeeClaimPolicyId: string;
  expiresAt: bigint;
}): string {
  return num.toHex(
    hash.computePoseidonHashOnElements([
      SETTLEMENT_TERMS_TAG,
      t.settlementId,
      t.payeeSubjectKey,
      t.payeeClaimPolicyId,
      num.toHex(t.expiresAt),
    ]),
  );
}

// Claim and Refund quote a settlement id and nothing else.
export const quotedSettlementHash = (settlementId: string) =>
  settlementTermsHash({
    settlementId,
    payeeSubjectKey: "0x0",
    payeeClaimPolicyId: "0x0",
    expiresAt: 0n,
  });

export function subjectActionHash(a: {
  chainId: string;
  gateAddress: string;
  poolAddress: string;
  leg: string;
  policyId: string;
  noteBinding: string; // the resolved note id, or NOTE_ANY
  validUntil: bigint; // 0n only when noteBinding names a note
  token: string;
  amount: bigint;
  nonce: string;
  termsHash: string; // "0x0" for Direct
}): string {
  return num.toHex(
    hash.computePoseidonHashOnElements([
      SUBJECT_ACTION_TAG,
      a.chainId,
      a.gateAddress,
      a.poolAddress,
      a.leg,
      a.policyId,
      a.noteBinding,
      num.toHex(a.validUntil),
      a.token,
      num.toHex(a.amount),
      a.nonce,
      a.termsHash,
    ]),
  );
}

// Learning the resolved note id: prepare, read it out, sign, prepare again, submit.
// `prepared.call` is a fully resolved Starknet Call, so `${openNoteIds[0]}` has already been
// substituted in its calldata. Locate it at the position your gate calldata puts it.
const probe = await account.strk20PrepareInvoke(actionsWithPlaceholderSignature, true);
const noteBinding = readNoteBindingFrom(probe.call.calldata);

// Sign with the STARK curve; the gate verifies with check_ecdsa_signature.
const { r, s } = ec.starkCurve.sign(credentialHash(credential), issuerPrivateKey);
```

`computePoseidonHashOnElements` is `poseidonHashMany`, which is exactly what
`core::poseidon::poseidon_hash_span` computes. Assert all three pinned vectors above before you
sign anything for real.

Five things to get right in the SDK, because the contract cannot warn you about any of them:

- **`chainId`** must be the chain the transaction will actually execute on, not a configured
  default. Read it from the provider.
- **`gateAddress`** is the `PolicyGate` deployment being called — not the pool, not a registry.
- **`poolAddress`** is the privacy pool the gate was constructed against. It must equal
  `PolicyGate::privacy_pool()`; anything else is refused twice over.
- **`amount`** must equal what the wallet's `withdraw` action actually withdraws. Signing for less
  than was withdrawn leaves the difference behind as unrecoverable-by-you dust; signing for more is
  refused with `CORDON_UNDERFUNDED`.
- **`settlementId` must be random.** Generate it from a CSPRNG. Ids are single-use forever and
  funding is permissionless, so a guessable one can be burned ahead of you — and it is the only
  handle in the event log, so a guessable one is also a correlation key.
- **Prefer the bound mode.** Resolve the note id with a dry-run `strk20PrepareInvoke`, sign that,
  and fall back to `NOTE_ANY` only when the wallet will not give it to you. When you do fall back,
  set `validUntil` to the shortest value that survives a wallet round trip — the gate's ceiling of
  600 seconds is a limit, not a recommendation — and treat a reverted transaction as a *burned*
  authorisation: sign a fresh nonce before retrying, rather than resubmitting the published one.
