# Review in five minutes

The short path through this repository, in the order that makes it verifiable rather than the order
that makes it sound good.

## 1 · The one-sentence version

Cordon puts compliance rules *inside* the settlement path of Starknet's STRK20 privacy pool. Value
routes through a Cairo anonymizer, so a payer who is uncredentialed, revoked, over their cap or over
their velocity budget cannot move shielded funds at all. The payer and payee stay private.

## 2 · Sixty seconds (no wallet, no account, no faucet)

**Live demo:** https://rayyer220.github.io/cordon/

Three settlements on Starknet mainnet, each carrying a `PolicyPassed` event from our gate:

| | |
|---|---|
| a gated payment under a published policy | [`0x48706650…5e292c`](https://voyager.online/tx/0x48706650f053d722b138a83b40ec19ce83c4c61f346bd378d9b1473265e292c) |
| a settlement funded for one named payee | [`0x628d58ed…49e6f`](https://voyager.online/tx/0x628d58eda409d1c035e334fcd2bc8c63da60b5959e03843182d0c3d99449e6f) |
| the payee claiming it **with their own key** | [`0x3c33703c…169fd`](https://voyager.online/tx/0x3c33703c367473102af8aa67335a5247cbee74a7bbd975cbc9b825ca4a169fd) |

And the gate refusing, reverted on mainnet:
[`0x1645148b…e7839`](https://voyager.online/tx/0x1645148beb027368b945f6e63e4d7e95954c1f1e9e03d303001aa11ca1e7839) — `CORDON_BAD_POOL`.

**Read [`PROOF.md`](./PROOF.md) for the refusal we could *not* put on chain, and why.** A payment
over its cap never becomes a transaction: the wallet's paymaster simulates it, sees the gate revert
and declines to sponsor it. We would rather explain that than substitute a different refusal and let
it read as the one we promised.

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
