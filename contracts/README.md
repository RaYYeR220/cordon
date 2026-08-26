# Cordon contracts

Cairo contracts for a credential and policy gate over shielded STRK20 value.

Value physically routes through `PolicyGate` on its way back into a shielded note, so the rule is
unbypassable: an unaccredited, revoked, expired, over-cap or over-velocity party cannot move pool
funds at all — the gate panics and the whole pool transaction reverts. This is a gate, not a report
generated afterwards.

## Layout

| File | What it is |
| --- | --- |
| `src/types.cairo` | `Policy`, `Credential`, `Settlement`, `GateOperation`, and `OpenNoteDeposit` (an ABI mirror of the pool's own struct) |
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
  the gate reads `erc20.balance_of(self)`, net of what it already owes to open settlements.
- The gate must `approve(pool, amount)` and return `Span<OpenNoteDeposit>` naming the open note.
  Returning an **empty span** tells the pool to leave the value with the gate.
- **Any panic reverts the entire pool transaction.** The withdrawal, the transfer and the fee all
  unwind, and the value stays shielded.

## One selector, four legs

The pool offers exactly one entrypoint, so `GateOperation` — the first parameter — selects the leg.
Each variant carries exactly the data its leg needs and nothing it ignores.

| Leg | Who signs | Wallet action array | Returns |
| --- | --- | --- | --- |
| `Direct` | payer | `withdraw → transfer(OPEN) → invoke` | the payer's open note |
| `Fund` | payer | `withdraw → invoke` | **empty span** — value stays with the gate |
| `Claim` | **payee** | `transfer(OPEN, recipient: self) → invoke` | the payee's open note |
| `Refund` | payer | `transfer(OPEN, recipient: self) → invoke` | the payer's open note |

### Why payee compliance needs two steps

A payer cannot vouch for a payee. The gate never sees the `transfer(OPEN)` recipient, and a note id
is derived from a channel key the gate cannot recompute, so there is no way in a single transaction
to bind a payee credential to the address that actually receives the money. Any contract claiming
otherwise is checking something it cannot verify.

`Fund`/`Claim` is the sound answer, and it is the shape StarkWare's own escrow reference uses: the
payer clears their policy and parks the value, and the payee authenticates **themselves**, with
**their own key**, in **their own private transaction**, at the moment they take it. A claimant
whose credential was revoked between the funding and the claim cannot take the money, and the
refusal is a public on-chain fact.

`Refund` closes the loop: after `expires_at`, and only then, the payer can take back what nobody
claimed — signature-gated on the payer's pseudonym so a stranger cannot trigger it.

## Enforcement order

Each step has its own panic code so a UI can name the refusal instead of showing "reverted".

### Every leg

| # | Check | Refusal |
| --- | --- | --- |
| 1 | the caller is the pool the transaction names | `CORDON_BAD_POOL` |

### `Direct` and `Fund` (payer), and `Claim` (payee — identical pipeline)

| # | Check | Refusal |
| --- | --- | --- |
| 2 | the policy is published and active | `CORDON_NO_POLICY` |
| 2b | `Direct` only: it needs no payee credential this leg cannot carry | `CORDON_PAYEE_REQUIRED` |
| 3 | the pool actually sent value (`Direct`/`Fund`) | `CORDON_NO_VALUE` |
| 4 | the issuer is registered, active, and the one the policy pins | `CORDON_BAD_ISSUER` |
| 5 | the issuer signature over the credential hash verifies | `CORDON_BAD_CRED` |
| 6 | the credential has not lapsed | `CORDON_EXPIRED` |
| 7 | the issuer has not revoked it | `CORDON_REVOKED` |
| 8 | the claim is the one the policy asks for | `CORDON_CLAIM_MISMATCH` |
| 9 | the subject authorised this settlement, at this gate, on this chain | `CORDON_BAD_SUBJECT_SIG` |
| 9b | with a nonce they have not spent on any leg | `CORDON_NONCE_USED` |
| 10 | the amount fits the per-transaction cap | `CORDON_OVER_CAP` |
| 11 | and fits what is left in this epoch | `CORDON_OVER_VELOCITY` |
| 12 | book the spend, emit `PolicyPassed` | |

`Claim` runs steps 4 to 11 against the **payee's** credential and the **payee's** claim policy —
the same code path, so a payee check can never drift from a payer check. The claim policy's cap and
velocity apply to the payee: a receiving limit is a real control, and honouring `max_amount` for a
payer while ignoring it for a payee would be a silently dropped check.

### Settlement legs

| Leg | Check | Refusal |
| --- | --- | --- |
| `Fund` | the settlement id is fresh — ids are single-use forever, settled or not | `CORDON_SETTLEMENT_EXISTS`, `CORDON_ZERO_SETTLEMENT` |
| `Fund` | the claim window closes in the future | `CORDON_BAD_EXPIRY` |
| `Fund` | the claim policy exists and is active — checked *before* the money commits | `CORDON_NO_POLICY` |
| `Claim`/`Refund` | the settlement is open | `CORDON_NO_SETTLEMENT`, `CORDON_ALREADY_CLAIMED`, `CORDON_ALREADY_REFUNDED` |
| `Claim`/`Refund` | the leg names the token the settlement holds | `CORDON_TOKEN_MISMATCH` |
| `Claim`/`Refund` | the pool did not fund a leg that should carry nothing | `CORDON_UNEXPECTED_VALUE` |
| `Claim` | the window is still open | `CORDON_CLAIM_EXPIRED` |
| `Refund` | the window has closed | `CORDON_REFUND_TOO_EARLY` |
| `Refund` | signed by the pseudonym that funded it | `CORDON_BAD_SUBJECT_SIG` |

Replay protection is keyed by `(subject_public_key, nonce)` and spans every leg; velocity is keyed
by `(subject_public_key, policy_id, epoch_index)`. Both are keyed by a subject's pseudonym rather
than by a wallet address, so a party cannot reset their rate by rotating wallets — and the keying
costs them no privacy.

A refund deliberately does not re-check the payer's credential (a settlement can outlive the
attestation that funded it, and nothing new leaves the gate) and does not un-book the epoch spend
(velocity measures value pushed through the gate in a window; a refund does not unspend it).

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

The suite runs against a `MockPool` that reproduces the real pool's behaviour for every action
array Cordon uses — transfer in (or not), call `privacy_invoke`, `transfer_from` whatever was
approved back out — plus a minimal mock ERC20. Every refusal path has its own `#[should_panic]`
test, and the negative controls keep the passing tests from being vacuous: one flipped bit in the
issuer signature, one in the subject signature, a signature bound to a different gate, and — for
payee compliance — a claim that succeeds and the identical claim that fails after the payee's
credential is revoked.
