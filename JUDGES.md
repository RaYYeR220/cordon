# Review in five minutes

The short path through this repository, in the order that makes it verifiable rather than the order
that makes it sound good.

## 1 · The one-sentence version

Cordon puts compliance rules *inside* the settlement path of Starknet's STRK20 privacy pool. Value
routes through a Cairo anonymizer, so a payer who is uncredentialed, revoked, over their cap or over
their velocity budget cannot move shielded funds at all. The payer and payee stay private.

## 2 · Watch it refuse (60 seconds)

The demo is open, needs no wallet, no account and no funds to look at, and no faucet.

- **Live demo:** see the repository's Website field
- **The money shot:** [`PROOF.md`](./PROOF.md) rows 4 and 5 — two *reverted* mainnet transactions:
  a payment over the policy cap, and a payee revoked between funding and claiming. Both are real
  failures on Starknet mainnet, linked to Voyager.

Connecting a wallet is only needed to send your own payment, and requires **Ready** — it is
currently the only Starknet wallet implementing the STRK20 methods. The app detects this and says
so rather than failing.

## 3 · Check the claims instead of reading them

```bash
node scripts/verify-onchain.mjs
```

Re-reads `strk20.json`, fetches each receipt from a public RPC endpoint, and asserts every listed
transaction exists, succeeded, carries a STRK20 pool event, and carries an event from our gate. No
arguments, no credentials, exits non-zero on the first failure.

[`CLAIMS.md`](./CLAIMS.md) tags every public statement we make by evidence tier, including an
explicit list of what we do **not** claim. [`MOCKS.md`](./MOCKS.md) draws the real-versus-simulated
line.

## 4 · The depth, if you want it

| Look at | For |
|---|---|
| [`contracts/src/policy_gate.cairo`](./contracts/src/policy_gate.cairo) | the anonymizer: the pool calls `privacy_invoke` here, and every rule is enforced before it approves a single token |
| [`contracts/README.md`](./contracts/README.md) | the pool calling convention and the four settlement legs, with the enforcement table |
| [`contracts/HASHING.md`](./contracts/HASHING.md) | the hash contract, so any client can reproduce a signature — and why the credential hash is portable while the authorisation hash is bound to chain, gate and pool |
| `contracts/src/tests/` | the suite. Every refusal is its own `#[should_panic]` test, and the regression tests derived from our in-house audit's proof-of-concept exploits are in `test_audit_poc.cairo` |

```bash
cd contracts && scarb build && snforge test     # the contracts
cd packages/sdk && npm install && npm test      # includes the Cairo-vs-TypeScript hash conformance
cd services/issuer && OFAC_LIVE=1 npm test      # fetches the real OFAC SDN list
```

## 5 · What we would want a reviewer to press on

Three things we think are the honest weak points, so you do not have to find them yourself:

1. **We are our own issuer.** The registry, the signature verification and the revocation are real
   and enforced on chain; the authority holding the key is us rather than a licensed provider. The
   `NOT_SANCTIONED` claim is the exception — it is screened against the live OFAC SDN list.
2. **A funding and its claim share a settlement id**, so a chain observer can correlate the two legs
   even though neither party is named. We say this in `CLAIMS.md` rather than describing the system
   as unlinkable.
3. **The pool's anonymity set is measurably small** — a median effective set of 1.00 at current
   usage. Cordon neither improves it nor depends on it, and we would rather state that than let
   "private" do work it has not earned.

## 6 · Reusable by other teams

[`packages/react`](./packages/react) and [`packages/sdk`](./packages/sdk) exist so another project
can gate its own flow without adopting our application:

```tsx
<CordonProvider config={{ gate: GATE_ADDRESS, policy: "PAY_ACCREDITED_V1" }}>
  <GatedPaymentButton token={STRK} amount={100n} recipient={payee} />
</CordonProvider>
```
