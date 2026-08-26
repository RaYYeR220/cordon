# Cordon contracts

Cairo contracts for a credential and policy gate over shielded STRK20 value.

Value physically routes through `PolicyGate` on its way back into a shielded note, so the rule is
unbypassable: an unaccredited, revoked, expired, over-cap or over-velocity payer cannot move pool
funds at all — the gate panics and the whole pool transaction reverts. This is a gate, not a report
generated afterwards.

## Layout

| File | What it is |
| --- | --- |
| `src/types.cairo` | `Policy`, `Credential`, `Issuer`, and `OpenNoteDeposit` (an ABI mirror of the pool's own struct) |
| `src/errors.cairo` | Every panic code, one per refusal |
| `src/hashing.cairo` | The two Poseidon preimages an issuer and a subject sign — see [`HASHING.md`](HASHING.md) |
| `src/interfaces.cairo` | The four public interfaces |
| `src/issuer_registry.cairo` | Which keys may attest, and who speaks for them. Owner-governed |
| `src/revocation_registry.cairo` | Issuer-scoped revocation. The issuer's operator revokes, not the owner |
| `src/policy_registry.cairo` | Published, immutable rule sets |
| `src/policy_gate.cairo` | The anonymizer the pool calls. All enforcement lives here |

## The pool's calling convention

`PolicyGate::privacy_invoke` is called by the privacy pool through `selector!("privacy_invoke")`.
Three properties of that convention drive the design:

- The pool has **already transferred the tokens** before it calls. There is no `amount` argument;
  the gate reads `erc20.balance_of(self)`.
- The gate must `approve(pool, amount)` and return `Span<OpenNoteDeposit>` naming the open note.
- **Any panic reverts the entire pool transaction.** The withdrawal, the transfer and the fee all
  unwind, and the value stays shielded.

## Enforcement order

Each step has its own panic code so a UI can name the refusal instead of showing "reverted".

| # | Check | Refusal |
| --- | --- | --- |
| 1 | the caller is the pool the transaction names | `CORDON_BAD_POOL` |
| 2 | the policy is published and active | `CORDON_NO_POLICY` |
| 2b | and needs no payee credential this entrypoint cannot carry | `CORDON_PAYEE_REQUIRED` |
| 3 | the pool actually sent value | `CORDON_NO_VALUE` |
| 4 | the issuer is registered, active, and the one the policy pins | `CORDON_BAD_ISSUER` |
| 5 | the issuer signature over the credential hash verifies | `CORDON_BAD_CRED` |
| 6 | the credential has not lapsed | `CORDON_EXPIRED` |
| 7 | the issuer has not revoked it | `CORDON_REVOKED` |
| 8 | the claim is the one the policy asks for | `CORDON_CLAIM_MISMATCH` |
| 9 | the subject authorised this exact settlement | `CORDON_BAD_SUBJECT_SIG` |
| 9b | with a nonce they have not spent | `CORDON_NONCE_USED` |
| 10 | the amount fits the per-transaction cap | `CORDON_OVER_CAP` |
| 11 | and fits what is left in this epoch | `CORDON_OVER_VELOCITY` |
| 12 | book the spend, emit `PolicyPassed` | |
| 13 | `approve(pool, amount)`, return the deposit | |

Replay protection is keyed by `(subject_public_key, nonce)`; velocity is keyed by
`(subject_public_key, policy_id, epoch_index)`. Both are keyed by the subject's pseudonym rather
than by a wallet address, so a payer cannot reset their rate by rotating wallets — and the keying
costs them no privacy.

## What Cordon does not do

The pool hands an anonymizer a plaintext ERC20 balance, never note amounts. Caps and velocity are
genuinely enforceable because the value routes through the gate. Rules over *encrypted* amounts are
not possible here and are not claimed.

## Build and test

```sh
scarb build
snforge test
```

Toolchain: Scarb 2.18.0, Cairo edition `2024_07`, snforge 0.63.0, OpenZeppelin Cairo 3.0.0.

The suite runs against a `MockPool` that reproduces the real pool's behaviour — transfer in, call
`privacy_invoke`, `transfer_from` the approved amount back out — plus a minimal mock ERC20. Every
refusal path has its own `#[should_panic]` test, and two negative controls (one flipped bit in the
issuer signature, one in the subject signature) keep the passing tests from being vacuous.
