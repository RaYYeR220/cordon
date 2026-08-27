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
| `src/hashing.cairo` | The Poseidon preimages an issuer and a subject sign — see [`HASHING.md`](HASHING.md) |
| `src/interfaces.cairo` | The four public interfaces |
| `src/issuer_registry.cairo` | Which keys may attest, and who speaks for them. Owner-governed |
| `src/revocation_registry.cairo` | Issuer-scoped revocation. The issuer's operator revokes, not the owner |
| `src/policy_registry.cairo` | Published, immutable rule sets |
| `src/policy_gate.cairo` | The anonymizer the pool calls. All enforcement lives here |

## The pool's calling convention

`PolicyGate::privacy_invoke` is called by the privacy pool through `selector!("privacy_invoke")`.

- Only the pool the gate was **constructed against** may call it. `pool_address` in the calldata is
  the wallet's `${poolAddress}` substitution — untrusted, cross-checked against the stored pool,
  and never used to decide who receives an allowance.
- The pool has **already transferred the tokens** before it calls. There is still no `amount`
  argument in the pool's sense: the amount comes from the subject's *signature*, and the gate's
  balance is consulted only to check it can cover it.
- The gate `approve`s the stored pool and returns `Span<OpenNoteDeposit>` naming the open note.
  An **empty span** tells the pool to leave the value with the gate.
- **Any panic reverts the entire pool transaction.** The withdrawal, the transfer and the fee all
  unwind, and the value stays shielded.

## One selector, four legs

`GateOperation` — the first parameter — selects the leg. Each variant carries exactly the data its
leg needs and nothing it ignores, and the leg itself is inside every signed message.

| Leg | Who signs | Wallet action array | Returns |
| --- | --- | --- | --- |
| `Direct` | payer | `withdraw → transfer(OPEN) → invoke` | the payer's open note |
| `Fund` | payer | `withdraw → invoke` | **empty span** — value stays with the gate |
| `Claim` | **the named payee** | `transfer(OPEN, recipient: self) → invoke` | the payee's open note |
| `Refund` | payer | `transfer(OPEN, recipient: self) → invoke` | the payer's open note |

### Why payee compliance needs two steps

A payer cannot vouch for a payee. The gate never sees the `transfer(OPEN)` recipient, and a note id
is derived from a channel key the gate cannot recompute, so there is no way in a single transaction
to bind a payee credential to the address that actually receives the money. Any contract claiming
otherwise is checking something it cannot verify.

`Fund`/`Claim` is the sound answer, and it is the shape StarkWare's own escrow reference uses: the
payer clears their policy, names the payee's pseudonym and parks the value; the payee authenticates
**themselves**, with **their own key**, in **their own private transaction**, at the moment they
take it. A claimant whose credential was revoked between the funding and the claim cannot take the
money, and the refusal is a public on-chain fact.

`Refund` closes the loop: after `expires_at`, and only then, the payer can take back what nobody
claimed — signature-gated on the payer's pseudonym and bound to the settlement id.

## Enforcement order

Each step has its own panic code so a UI can name the refusal instead of showing "reverted".

### Every leg

| # | Check | Refusal |
| --- | --- | --- |
| 1 | the caller **is** the pool this gate was constructed against | `CORDON_BAD_POOL` |
| 1b | the `pool_address` calldata names that same pool | `CORDON_BAD_POOL` |
| 1c | no allowance to the pool is outstanding from an earlier leg | `CORDON_STALE_ALLOWANCE` |

### `Direct` and `Fund` (payer), and `Claim` (payee — identical pipeline)

| # | Check | Refusal |
| --- | --- | --- |
| 2 | the policy is published and active | `CORDON_NO_POLICY` |
| 2b | it permits this ERC20 | `CORDON_TOKEN_NOT_ALLOWED` |
| 2c | `Direct` only: it needs no payee credential this leg cannot carry | `CORDON_PAYEE_REQUIRED` |
| 3 | the signed amount is non-zero and the gate holds it above its ledger | `CORDON_NO_VALUE`, `CORDON_UNDERFUNDED` |
| 4 | the issuer is registered, active, and the one the policy pins | `CORDON_BAD_ISSUER` |
| 5 | the issuer signature over the credential hash verifies | `CORDON_BAD_CRED` |
| 6 | the credential has not lapsed | `CORDON_EXPIRED` |
| 7 | the issuer has not revoked it | `CORDON_REVOKED` |
| 8 | the claim is the one the policy asks for | `CORDON_CLAIM_MISMATCH` |
| 9 | the transaction fills the note the subject bound to, and the authorisation is not stale | `CORDON_NOTE_MISMATCH`, `CORDON_AUTH_EXPIRED`, `CORDON_NEEDS_DEADLINE`, `CORDON_WINDOW_TOO_LONG` |
| 9b | the subject authorised this leg, amount, note, gate, pool, chain and terms | `CORDON_BAD_SUBJECT_SIG` |
| 9c | with a nonce they have not spent on any leg | `CORDON_NONCE_USED` |
| 10 | the amount fits the per-transaction cap | `CORDON_OVER_CAP` |
| 11 | and fits what is left in this epoch | `CORDON_OVER_VELOCITY` |
| 12 | book the spend, emit `PolicyPassed` | |

`Claim` runs steps 4 to 11 against the **payee's** credential and the **payee's** claim policy —
the same code path, so a payee check can never drift from a payer check.

### Settlement legs

| Leg | Check | Refusal |
| --- | --- | --- |
| `Fund` | it names no open note (there is none), and binds that | `CORDON_NOTE_ID_NOT_ZERO`, `CORDON_FUND_NEEDS_BINDING` |
| `Fund` | the settlement id is fresh — ids are single-use forever, settled or not | `CORDON_SETTLEMENT_EXISTS`, `CORDON_ZERO_SETTLEMENT` |
| `Fund` | it names a payee | `CORDON_ZERO_PAYEE` |
| `Fund` | the claim window closes in the future | `CORDON_BAD_EXPIRY` |
| `Fund` | the claim policy exists, is active, permits this token, and its cap fits the amount | `CORDON_NO_POLICY`, `CORDON_TOKEN_NOT_ALLOWED`, `CORDON_PAYEE_OVER_CAP` |
| `Claim`/`Refund` | the settlement is open | `CORDON_NO_SETTLEMENT`, `CORDON_ALREADY_CLAIMED`, `CORDON_ALREADY_REFUNDED` |
| `Claim`/`Refund` | the leg names the token the settlement holds | `CORDON_TOKEN_MISMATCH` |
| `Claim` | the claimant is the payee the payer named | `CORDON_NOT_THE_PAYEE` |
| `Claim` | the window is still open | `CORDON_CLAIM_EXPIRED` |
| `Refund` | the window has closed | `CORDON_REFUND_TOO_EARLY` |
| `Refund` | signed by the pseudonym that funded it, for this settlement | `CORDON_BAD_SUBJECT_SIG` |

Replay protection is keyed by `(subject_public_key, nonce)` and spans every leg; velocity is keyed
by `(subject_public_key, policy_id, epoch_index)`. Both are keyed by a subject's pseudonym rather
than by a wallet address, so a party cannot reset their rate by rotating wallets — and the keying
costs them no privacy.

A refund deliberately does not re-check the payer's credential (a settlement can outlive the
attestation that funded it, and nothing new leaves the gate) and does not un-book the epoch spend
(velocity measures value pushed through the gate in a window; a refund does not unspend it).

## Where a payment is allowed to land

An authorisation names the open note it is for, and the gate checks the transaction fills that
note. This is what makes a leaked authorisation worthless: a thief cannot create a note with
someone else's id, because a note id is
`poseidon(NOTE_ID_TAG, channel_key, token, index, 0)` and the channel key commits to its owner's
private key.

It matters because authorisations do leak. A reverted transaction is included on Starknet with its
full calldata, and a revert does not burn the nonce — so a claim that fails for an ordinary reason
publishes a live authorisation to the whole chain. Without the binding, anyone could resubmit it
into a note of their own and the gate would pay them: the credential, the signature and the payee
key would all still check out.

The complication is that on the Wallet API route the signer often cannot know the note id. The
application submits the literal `"${openNoteIds[0]}"` and the wallet substitutes the resolved felt
at submission time. So the signed field is a *binding*, and it is one of two things:

- **the resolved note id** — the strong mode, and the one to use. It is obtainable:
  `strk20PrepareInvoke` returns a fully resolved call, so an application can prepare once to read
  the note id, sign it, and prepare again to submit. The id is stable across that round trip
  because none of its inputs depend on the invoke calldata; if another transaction moves the note
  index in between, the second prepare produces a different id and the transaction fails closed.
- **`NOTE_ANY`** — for flows where it genuinely cannot be obtained. The gate accepts whichever note
  the transaction fills, which is the redirection exposure above, so it charges for it: an unbound
  authorisation must carry a deadline and the gate refuses one more than **600 seconds** out. The
  exposure becomes a window an attacker has to be watching for, rather than a lifetime.

Either way the choice is inside the signed message, so a subject can see which one they made. The
`Fund` leg fills no note, so its binding is always knowable and `NOTE_ANY` is refused there.

## What the gate is immutable about

Three things are fixed at construction with no setter, and each one is load-bearing:

- **The privacy pool.** It is both the only permitted caller and the only address that can ever be
  approved.
- **The three registry pointers.** A registry decides what a credential *means*. Re-pointing one
  while a settlement is open would let whoever did it mint a credential satisfying that
  settlement's claim policy and take the money — a seizure, not a migration, and no timelock makes
  it something else. Migrate by deploying a new gate and letting open settlements run out.
- **A published policy's rules.** Only the `active` flag ever changes, and only one way.

Because a wrong pointer is only fixable by redeploying, every one of them is readable from outside.
You do not have to take our word for what this gate is wired to, and you should not have to read a
deployment transaction's calldata to find out:

```sh
sncast call --contract-address <gate> --function privacy_pool
sncast call --contract-address <gate> --function issuer_registry
sncast call --contract-address <gate> --function revocation_registry
sncast call --contract-address <gate> --function policy_registry
```

`registries` returns all three in one call if you would rather. `RevocationRegistry` exposes
`issuer_registry` the same way, which matters because its promise that only an issuer's own
operator can revoke rests on that pointer being fixed. There are no matching setters, and
`test_gate::the_gate_has_no_registry_setter` asserts as much against the compiled ABI rather than
in a comment.

## Dust, and the internal ledger

Anyone can transfer tokens to the gate; nothing stops them and nothing should. So the gate never
treats `balance_of` as an input. It keeps `accounted`, the sum of what it owes to open settlements,
and a leg may promise value only while `balance_of >= accounted + amount`. Consequences:

- a stray transfer cannot inflate a payment (the amount is signed), cannot block one (there is no
  equality check anywhere), and cannot be reached by a leg that would have to dip into escrow;
- surplus accrues as dust and is removable only by `sweep(token, to)`, which is owner-only and
  bounded by `balance_of - accounted` — so no amount of owner mischief reaches a funded settlement.

**Known residual.** A credentialed party can still deliberately sign a `Direct` leg for stranded
dust and receive it, bounded by their own policy cap and velocity and costing them a nonce. The
gate cannot distinguish a pool withdrawal from a stray transfer — both are just balance, and the
pool's convention attests to neither — so this is not closable at the contract level. It is
recorded rather than papered over; sweep promptly, and pin policies to a token you control.

## What a chain observer can still correlate

No Cordon event contains a subject key. That is deliberate: `PolicyPassed` carrying a payer's
pseudonym and `SettlementClaimed` carrying a payee's, joinable through a settlement id, would
publish a permanent indexed edge between two counterparties and the exact amount between them — and
a pseudonym lives as long as a credential does. Unlinkability is the property this contract exists
to protect.

What remains visible, and should be stated plainly:

- **Amounts are public.** Every `PolicyPassed`, `SettlementFunded`, `SettlementClaimed` and
  `SettlementRefunded` carries an exact amount and a token. Cordon does not hide them and never
  claimed to — the pool hands anonymizers plaintext balances.
- **Policy ids are public**, so which rule set a transaction satisfied is public. Timing is public.
- **A settlement's funding and its claim share a `settlement_id`**, so the two transactions are
  linkable to each other. They are not linkable to a *person* unless the id is guessable — which is
  why `settlement_id` must be generated at random by the payer. The SDK does this.
- **Credentials travel as plaintext calldata**, so a subject's pseudonym and their attestation are
  linkable once they transact. Rotate credentials if that matters to you.
- **Velocity windows are absolute**, so `epoch_length` boundaries are public and a subject may move
  `2 × max_per_epoch` across one. Size windows accordingly; the enforced bound is per window, not
  per rolling interval.
- **A reverted transaction publishes its calldata**, including the authorisation it carried. A
  bound authorisation is worthless once published; an unbound one is redirectable until its
  deadline. Treat a revert as having burned the authorisation and sign a fresh nonce to retry.

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
approved back out — plus a minimal mock ERC20.

`src/tests/test_audit_regressions.cairo` is the pre-deployment audit's proof-of-concept file, kept
and inverted. Every test in it was a working exploit that passed; each now asserts the attack
fails, with the original scenario in its doc comment. The other negative controls: one flipped bit
in the issuer signature, one in the subject signature, a signature bound to a different gate, a
signature bound to a different pool, a signature made for a different leg, and — for payee
compliance — a claim that succeeds beside the identical claim that fails once the payee's
credential is revoked.
