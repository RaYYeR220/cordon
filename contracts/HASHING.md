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
| Subject action | `CORDON_SUBJECT_ACTION:V1` | `0x434f52444f4e5f5355424a4543545f414354494f4e3a5631` |

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

**Scope.** The hash binds no chain id and no verifier address: a Cordon credential is a portable
statement about a subject, valid at any gate that trusts the same issuer registry. Scoping a
credential to a use is the policy's job, not the credential's.

## 2. `subject_action_hash` — what a subject signs

```
subject_action_hash = poseidon_hash_span([
    'CORDON_SUBJECT_ACTION:V1',  // domain tag
    policy_id,                   // felt252
    note_id,                     // felt252, the open note the pool will fill
    token,                       // ContractAddress widened to felt252
    amount,                      // u128 widened to felt252, token base units
    nonce,                       // felt252, chosen by the subject
])
```

Six elements, in that order.

The subject signs this with the private key behind `credential.subject_public_key`. Holding a
credential is not the same as authorising a payment: the credential says who the subject is, this
signature says that this subject wants this value moved under this policy, once.

`amount` is the plaintext balance the pool handed the gate, read from
`erc20.balance_of(gate)` — so a relayer cannot inflate a settlement past what the subject signed
for. `nonce` is consumed per `(subject_public_key, nonce)` and is what makes it once.

**Scope.** As with the credential, the action hash binds no chain id and no gate address. A nonce
is consumed in the gate that saw it, so the same signature could in principle be presented to a
second Cordon deployment enforcing the same `policy_id`. Both deployments enforce the same rule,
so this is a bounded concern, and it is called out here rather than left for a reader to discover.
A future `:V2` tag is the place to bind the gate.

## Pinned test vector

Both values below are asserted in `src/tests/test_hashing.cairo`. Use them as the first thing your
SDK's test suite checks.

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
| tag | `CORDON_SUBJECT_ACTION:V1` | `0x434f52444f4e5f5355424a4543545f414354494f4e3a5631` |
| `policy_id` | `PAY_ACCREDITED_V1` | `0x5041595f414343524544495445445f5631` |
| `note_id` | `note_0` | `0x6e6f74655f30` |
| `token` | STRK | `0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d` |
| `amount` | `400` | `0x190` |
| `nonce` | `nonce_0` | `0x6e6f6e63655f30` |

```
subject_action_hash = 0x796cff5d741e86cd5fb0cd9f48186501141039ae4ea33ee094b639d19e30621
```

## Reproducing it in TypeScript

```ts
import { ec, encodeShortString, hash, num } from "starknet";

const CREDENTIAL_TAG = encodeShortString("CORDON_CREDENTIAL:V1");
const SUBJECT_ACTION_TAG = encodeShortString("CORDON_SUBJECT_ACTION:V1");

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
  policyId: string;
  noteId: string;
  token: string;
  amount: bigint;
  nonce: string;
}): string {
  return num.toHex(
    hash.computePoseidonHashOnElements([
      SUBJECT_ACTION_TAG,
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
