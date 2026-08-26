# Cordon hash preimages

Cordon verifies two STARK-curve signatures on every settlement, and both are checked against a
Poseidon hash the signer computed off-chain. If your implementation of these hashes differs from
the contract's by a single field or a single byte of a tag, every signature you produce is refused
with `CORDON_BAD_CRED` or `CORDON_BAD_SUBJECT_SIG` and there is nothing in the revert to tell you
why. So these preimages are a public contract, not an implementation detail.

Authoritative source: [`src/hashing.cairo`](src/hashing.cairo).
Pinned by: [`src/tests/test_hashing.cairo`](src/tests/test_hashing.cairo) — including a test that
recomputes each hash from the literal felt list printed below, so this document cannot drift from
the code without a test failing.

## Primitives

- **Hash**: `poseidon_hash_span` over a flat `Span<felt252>` — the Starknet Poseidon sponge.
  In TypeScript: `poseidonHashMany` from `starknet` / `micro-starknet`.
- **Signature**: STARK-curve ECDSA, verified with `core::ecdsa::check_ecdsa_signature`.
  In TypeScript: `ec.starkCurve.sign(msgHash, privateKey)`.
- **Field widening**: `u64` and `u128` values are widened to `felt252` unchanged;
  a `ContractAddress` is its felt value. No packing, no offsets, no length prefix.
- **Short strings**: `'ACCREDITED'` is the ASCII bytes read big-endian as an integer, the standard
  Cairo short-string encoding (`encodeShortString` in `starknet`).

## Domain-separation tags

Template: `CORDON_<PURPOSE>:V<VERSION>`. The tag is the first element of every preimage. It is what
stops a credential signature from ever being replayed as an action signature, since a subject may
hold keys used in both roles. A change to a field list means a new tag, never a silent
reinterpretation of signatures already in circulation.

| Tag | Short string | felt (hex) |
| --- | --- | --- |
| Credential | `CORDON_CREDENTIAL:V1` | `0x434f52444f4e5f43524544454e5449414c3a5631` |
| Subject action | `CORDON_SUBJECT_ACTION:V2` | `0x434f52444f4e5f5355424a4543545f414354494f4e3a5632` |

### Why one is bound to a deployment and the other is not

The action hash binds the chain id and the gate address. The credential hash binds neither, and
that asymmetry is deliberate.

A **credential** is a portable statement about a subject — "this pseudonym is accredited". It is
true at every gate that trusts the same issuer, on every network. Binding it to one deployment
would force an issuer to re-attest per venue for no security gain, and scoping a credential to a
particular use is the policy's job, not the credential's.

An **action authorisation** is the opposite: it says "move this exact value, here, once". Left
unbound — as it was at `:V1` — the same signature would be replayable against a second Cordon
deployment enforcing the same policy id: a different contract, holding different money. `:V2`
closes that by putting the chain id and the verifying contract inside the signed message.

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

## 2. `subject_action_hash` — what a subject signs

```
subject_action_hash = poseidon_hash_span([
    'CORDON_SUBJECT_ACTION:V2',  // domain tag
    chain_id,                    // felt252, get_tx_info().unbox().chain_id
    gate_address,                // ContractAddress widened to felt252, the verifying PolicyGate
    policy_id,                   // felt252
    note_id,                     // felt252, the open note the pool will fill
    token,                       // ContractAddress widened to felt252
    amount,                      // u128 widened to felt252, token base units
    nonce,                       // felt252, chosen by the subject
])
```

Eight elements, in that order.

The subject signs this with the private key behind the `subject_public_key` their credential
names. Holding a credential is not the same as authorising a payment: the credential says who the
subject is, this signature says that this subject wants this value moved under this policy, at
this contract, once.

`amount` is the plaintext value the gate is moving — read from `erc20.balance_of(gate)` on the legs
the pool funds, and from the stored settlement on the legs it does not — so a relayer cannot
inflate a settlement past what the subject signed for. `chain_id` and `gate_address` stop the
signature being carried to another network or another deployment. `nonce` is what makes it once.

### What each leg signs

One preimage serves all four legs of `privacy_invoke`. Who signs and what they put in it:

| Leg | Signer | `policy_id` | `note_id` | `amount` |
| --- | --- | --- | --- | --- |
| `Direct` | payer | the payer policy | `${openNoteIds[0]}` | what the pool sent |
| `Fund` | payer | the payer policy | `0` — the action array is `withdraw → invoke`, so there is no open note | what the pool sent |
| `Claim` | **payee** | the settlement's `payee_claim_policy_id` | the payee's own `${openNoteIds[0]}` | the settlement's amount |
| `Refund` | payer | the settlement's `payer_policy_id` | the payer's own `${openNoteIds[0]}` | the settlement's amount |

The leg itself is **not** in the signed message, and it does not need to be. Every leg consumes a
nonce against the signing subject's key, from one registry shared across all of them, so a
signature carried from one leg to another always replays its nonce and is refused with
`CORDON_NONCE_USED`. The settlement id is likewise absent for the same reason. If you are auditing
this, that global nonce registry is the load-bearing part — `test_settlement.cairo` pins it in
`a_nonce_spent_on_one_leg_cannot_be_reused_on_another`.

## Pinned test vectors

Both values below are asserted in `src/tests/test_hashing.cairo`, twice each: once through the
Cairo functions and once from the literal felt list. Use them as the first thing your SDK's test
suite checks.

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

### Subject action

| Field | Value | felt (hex) |
| --- | --- | --- |
| tag | `CORDON_SUBJECT_ACTION:V2` | `0x434f52444f4e5f5355424a4543545f414354494f4e3a5632` |
| `chain_id` | `SN_MAIN` | `0x534e5f4d41494e` |
| `gate_address` | — | `0x02c0de00c0de00c0de00c0de00c0de00c0de00c0de00c0de00c0de00c0de001` |
| `policy_id` | `PAY_ACCREDITED_V1` | `0x5041595f414343524544495445445f5631` |
| `note_id` | `note_0` | `0x6e6f74655f30` |
| `token` | STRK | `0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d` |
| `amount` | `400` | `0x190` |
| `nonce` | `nonce_0` | `0x6e6f6e63655f30` |

```
subject_action_hash = 0x1d07660058550812f9d317014bcb9a843f55a2ed9362642fdb0c0eb2eca65e9
```

## Reproducing it in TypeScript

```ts
import { ec, encodeShortString, hash, num } from "starknet";

const CREDENTIAL_TAG = encodeShortString("CORDON_CREDENTIAL:V1");
const SUBJECT_ACTION_TAG = encodeShortString("CORDON_SUBJECT_ACTION:V2");

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

export function subjectActionHash(a: {
  chainId: string;
  gateAddress: string;
  policyId: string;
  noteId: string;
  token: string;
  amount: bigint;
  nonce: string;
}): string {
  return num.toHex(
    hash.computePoseidonHashOnElements([
      SUBJECT_ACTION_TAG,
      a.chainId,
      a.gateAddress,
      a.policyId,
      a.noteId,
      a.token,
      num.toHex(a.amount),
      a.nonce,
    ]),
  );
}

// Sign with the STARK curve; the gate verifies with check_ecdsa_signature.
const { r, s } = ec.starkCurve.sign(credentialHash(credential), issuerPrivateKey);
```

`computePoseidonHashOnElements` is `poseidonHashMany`, which is exactly what
`core::poseidon::poseidon_hash_span` computes. Assert both pinned vectors above before you sign
anything for real.

Two things to get right in the SDK, because the contract cannot warn you:

- `chainId` must be the chain id the transaction will actually execute on, not a configured
  default. Read it from the provider.
- `gateAddress` is the `PolicyGate` deployment being called — not the pool, and not the registry.
