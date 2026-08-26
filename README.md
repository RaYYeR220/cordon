# Cordon

**Compliance the pool can't settle around.**

Cordon is a credential and policy layer for [STRK20](https://strk20.starknet.io/), Starknet's
privacy pool. Value physically routes through a Cairo anonymizer, so a payer who is uncredentialed,
revoked, over their amount cap or over their per-epoch velocity limit **cannot move shielded funds
at all** — the transaction reverts. On the two-step settlement path the payee authorises the claim
with their own key, so a counterparty revoked between funding and claiming cannot take the money
either.

Payer and payee stay private. The amount, and the fact that a policy check passed, are public.

---

## Why this exists

Privacy that a regulator cannot inspect is unusable for institutional money, and the usual answer —
hand someone your viewing key and let them read everything, forever, after the fact — is not
compliance, it is surveillance with extra steps. STRK20 already ships mandatory deposit screening
and an auditor escrow, but both are all-or-nothing and both act *around* the money rather than *on*
it.

Cordon puts the rule in the settlement path. There is nothing to trust and nothing to review after
the fact, because a payment that breaks the policy never happens.

## How it works

```
  shielded note
       │
       ▼
  STRK20 pool ── apply_actions ──┐
       │                         │  the pool sends the value to the gate,
       │                         │  then calls privacy_invoke on it
       │                         ▼
       │                    PolicyGate.cairo
       │                         │  · issuer registered and active?
       │                         │  · issuer signature over the credential valid?
       │                         │  · credential unexpired and unrevoked?
       │                         │  · claim matches the policy?
       │                         │  · subject signature binds chain, gate, amount, nonce?
       │                         │  · within the amount cap?
       │                         │  · within the per-epoch velocity budget?
       │                         ▼
       │                 PASS ───┴─── FAIL ──▶ panic ──▶ the whole transaction reverts
       │                   │                             and the value returns to the pool
       └──◀── OpenNoteDeposit ─┘
```

The gate never sees note amounts — only the plaintext balance the pool hands it. Every rule is
therefore expressed on value that physically passes through the contract, which is precisely what
makes the rules unbypassable.

### Four settlement legs

| Leg | Who signs | Enforces | Action array |
|---|---|---|---|
| `Direct` | payer | payer policy | `withdraw → transfer(OPEN) → invoke` |
| `Fund` | payer | payer policy, escrows the value | `withdraw → invoke` |
| `Claim` | **payee** | payee policy | `transfer(OPEN, self) → invoke` |
| `Refund` | payer | after expiry only | `transfer(OPEN, self) → invoke` |

A payer cannot vouch for a payee: the gate never sees the recipient of the `transfer(OPEN)` action,
and the note id is derived from a channel key it cannot recompute. So payee compliance is enforced
the only sound way — the payee authorises the claim with their own key, in their own transaction.

## What is private, and what is not

Being precise about this matters more than sounding impressive.

| Public | Private |
|---|---|
| Shielding: your address, the token, the amount | Note-to-note transfers: amounts and parties |
| The amount that passes through the gate | Who the payer and payee are |
| That a policy check passed or failed, and which policy | Which deposit the value originally came from |
| Withdrawal destination and amount | The link between a subject pseudonym and a wallet |

**Cordon provides identity privacy, not amount privacy.** Anything routed through an anonymizer —
ours or anyone's — settles at a plaintext amount. If your threat model needs the amount hidden, use
a plain note-to-note transfer and accept that no rule can be enforced on it.

A subject pseudonym is an ordinary STARK-curve keypair generated locally. It never appears in a
wallet, and private pool transactions are submitted by rotating shared relayers, so it is not linked
on-chain to the account that funded it.

### Honest limits

- **The anonymity set is small.** Two builders independently measured the pool's median effective
  anonymity set at **1.00**, with 72% of deposits alone in their timing-and-amount cell. Cordon does
  not improve this and does not depend on it. Do not read "private" here as "unlinkable by a
  determined analyst with the deposit graph".
- Shielding is a public transaction. Bundling a deposit with the payment it funds publishes the
  link; shield earlier, separately.
- A credential is a portable statement about a subject key. Anyone holding both the credential and
  the subject private key is that subject.
- Revocation is only as timely as the issuer.
- The issuer is trusted to attest honestly. Cordon makes the attestation enforceable, not truthful.

## Repository

| Path | |
|---|---|
| `contracts/` | Cairo: `PolicyGate` (the anonymizer), `IssuerRegistry`, `RevocationRegistry`, `PolicyRegistry` |
| `packages/sdk` | `@cordon/sdk` — hashing, signing, calldata encoders, refusal decoding |
| `packages/react` | Drop-in hooks and components for gating your own flow |
| `services/issuer` | Credential issuer, screening against the live OFAC SDN list |
| `apps/web` | The reference application |

## Quick start

```bash
git clone https://github.com/RaYYeR220/cordon && cd cordon

# contracts
cd contracts && scarb build && snforge test

# sdk
cd ../packages/sdk && npm install && npm test

# app
cd ../../apps/web && npm install && cp .env.example .env.local && npm run dev
```

Requires [Scarb](https://docs.swmansion.com/scarb/) 2.18.0, [Starknet Foundry](https://foundry-rs.github.io/starknet-foundry/) 0.63.0 and Node 20+.

### Gate your own flow

```tsx
import { CordonProvider, GatedPaymentButton } from "@cordon/react";

<CordonProvider config={{ gate: GATE_ADDRESS, policy: "PAY_ACCREDITED_V1" }}>
  <GatedPaymentButton token={STRK} amount={100n} recipient={payee} />
</CordonProvider>
```

The button refuses locally when it can, and lets the chain refuse when it cannot — either way the
user sees which rule fired.

## Deployments

Starknet mainnet addresses, the verified transactions and the reproduction steps are in
[`PROOF.md`](./PROOF.md). Every claim in this README that can be checked on-chain is linked there.

## Documentation

- [`contracts/README.md`](./contracts/README.md) — the pool calling convention and the full enforcement tables
- [`contracts/HASHING.md`](./contracts/HASHING.md) — the hash contract, so any client can reproduce a signature
- [`PROOF.md`](./PROOF.md) — deployed addresses and verified mainnet transactions
- [`CLAIMS.md`](./CLAIMS.md) — every public claim, tagged by evidence tier
- [`MOCKS.md`](./MOCKS.md) — exactly what is real and what is simulated
- [`JUDGES.md`](./JUDGES.md) — a five-minute reviewer path

## Requires a privacy-enabled wallet

Private STRK20 actions are proved by the wallet, so the wallet has to implement the STRK20 methods.
Today that means **Ready**; Braavos answers `wallet_strk20Balances` with "Not implemented". The app
probes for support with that read-only call and explains the situation rather than failing.

## License

MIT — see [LICENSE](./LICENSE).
