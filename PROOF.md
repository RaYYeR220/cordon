# Proof

Every claim in this repository that can be checked on chain, with the link to check it.

> This file is filled in by what actually happened, not written ahead of it.

## Network

| | |
|---|---|
| Chain | Starknet mainnet (`SN_MAIN`) |
| STRK20 pool | [`0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a`](https://voyager.online/contract/0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a) |
| STRK | [`0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d`](https://voyager.online/contract/0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d) |

## Deployed contracts

| Contract | Address | Class hash |
|---|---|---|
| `PolicyGate` | [`0x061c734f…dfc6b2`](https://voyager.online/contract/0x061c734fe518f4c1a0e46d3d2a35b4ff1ab0df17dec510cff401d25e67dfc6b2) | `0x009191b1a66cd82e64a57bf03c3a8e1874facf90ef1bdbd79f47da7473cd97d9` |
| `IssuerRegistry` | [`0x001cc4f1…d3aae7`](https://voyager.online/contract/0x001cc4f14b4af4f7b1d7a6b973fbe968513abf1c94a3e9602c7fdd14e3d3aae7) | `0x0782d17348efb0fd566218f7f67ff11ef85b145035bc4ddec756ab61cd979411` |
| `RevocationRegistry` | [`0x035cc9e0…655c6d`](https://voyager.online/contract/0x035cc9e0dd4767aa259d6d7a6c6c10cb58fc97acdc0b45b7541807329a655c6d) | `0x028f748cdd825c31e3ad826ad0508ccd75e4616be7a8ac7d54fa4461a704a2c1` |
| `PolicyRegistry` | [`0x01b0cf17…7ab9ee`](https://voyager.online/contract/0x01b0cf177a70f390af44dc706e7867fa5d0be8920c14d23d4230955a027ab9ee) | `0x05912f7ebcdb995bc86df71f85e869c1c1137bd8a46895c51bd0c73cf1b8fed5` |

The same four classes are deployed on Sepolia, at the class hashes above — byte for byte the same
code on both networks. Sepolia addresses are in
[`contracts/deployments/sepolia.json`](./contracts/deployments/sepolia.json).

### The gate says what it is wired to

The pool and the three registry pointers are fixed at construction and have no setters, so you can
confirm the wiring yourself rather than trusting this table:

```bash
GATE=0x061c734fe518f4c1a0e46d3d2a35b4ff1ab0df17dec510cff401d25e67dfc6b2
RPC=https://api.cartridge.gg/x/starknet/mainnet

for f in privacy_pool issuer_registry revocation_registry policy_registry; do
  sncast call --url $RPC --contract-address $GATE --function $f
done
```

Reproduce the class hashes yourself:

```bash
cd contracts && scarb build
starkli class-hash target/dev/cordon_PolicyGate.contract_class.json
```

They must equal the class hashes above. If they do not, the deployed code is not this code.

## Transactions

Three settlements through the gate, on Starknet mainnet. Each one exists, succeeded, carries a
STRK20 pool event, and carries an event from `PolicyGate` — the four things the sprint checks.

| # | What it proves | Transaction |
|---|---|---|
| 1 | A credentialed payer inside the policy settles privately through the gate. `PolicyPassed(PAY_ACCREDITED_V1, STRK, 2.00)` | [`0x48706650…5e292c`](https://voyager.online/tx/0x48706650f053d722b138a83b40ec19ce83c4c61f346bd378d9b1473265e292c) |
| 2 | A settlement is funded for one named payee. `PolicyPassed(SETTLE_ACCREDITED_V1, STRK, 2.00)` | [`0x628d58ed…49e6f`](https://voyager.online/tx/0x628d58eda409d1c035e334fcd2bc8c63da60b5959e03843182d0c3d99449e6f) |
| 3 | The payee claims it **with their own key**, and the settlement moves to `Claimed` | [`0x3c33703c…169fd`](https://voyager.online/tx/0x3c33703c367473102af8aa67335a5247cbee74a7bbd975cbc9b825ca4a169fd) |

## The gate refusing, on mainnet

| What it proves | Result | Transaction |
|---|---|---|
| The gate refuses a caller that is not the pool, and reverts | `REVERTED` · `CORDON_BAD_POOL` | [`0x1645148b…e7839`](https://voyager.online/tx/0x1645148beb027368b945f6e63e4d7e95954c1f1e9e03d303001aa11ca1e7839) |

This is a direct call from an ordinary account, which is why it is the pool-caller guard and not one
of the policy rules: that check runs first, so nothing else is reachable this way. It is here as
proof that the gate really does refuse and revert on mainnet — not as a stand-in for a cap refusal.

## Why there is no reverted transaction for the cap

There is no mainnet transaction showing `CORDON_OVER_CAP`, and there cannot be one through a wallet.
A payment composed over its cap is refused before it becomes a transaction: the wallet's paymaster
simulates it, sees the gate revert, and declines to sponsor it — `PaymasterV2Error 156,
TRANSACTION_EXECUTION_ERROR`. Nothing reaches a block, so there is nothing to link.

Rather than dress that up, here is what it actually means. The rule is enforced so early that
breaking it **costs the payer nothing** — no gas is burned on a payment that was never going to
settle. And the refusal has a witness we do not control: a third party's paymaster refuses to carry
the transaction precisely because our contract would refuse it. That is a stronger claim than a
receipt we produced ourselves.

The cap rule is demonstrable three ways, none of which require taking our word for it:

- the pre-flight in the app names the rule that would fire, computed by the same code the chain runs;
- `snforge test` proves it, and the assertion is not vacuous — deleting the check makes exactly the
  tests that cover it fail (see the mutation checks in `contracts/`);
- the paymaster's own refusal, above.

## What the diagnostic contract is, and why it is in the repository

`contracts/src/diagnostics/echo_gate.cairo` is deployed at
[`0x022bead6…c7968`](https://voyager.online/contract/0x022bead6e687f1991bcfac3c4e4408847be7104c900e2afc2fdf02ae2b7c7968)
and it **enforces nothing**. It exists because a payment was failing with an opaque paymaster error
and no revert reason anywhere, and the only way to tell "our rules are refusing" from "the route
will not carry this" was to put an identical contract with the rules removed on the same path.

It settled the question — the enforcement-free version went through, so the route was fine — and the
calldata of that transaction is what exposed the real bug: the SDK was reading the resolved note id
from the wrong position and binding every authorisation to a nonsense note. Two invocations exist:
[`0x1c62fa64…f902db`](https://voyager.online/tx/0x1c62fa6430e022ef6465efc7af2d501cd619a5f9b60d9cb46ebd38c96f902db)
and [`0x3aa83ef5…6f3b`](https://voyager.online/tx/0x3aa83ef55e18480627e0cf4b85cce607e757fc1aa6042d17673af90026f3b).

**They are not listed in `strk20.json` and are not offered as product transactions.** They passed
because nothing checked them. Counting them would be the exact dishonesty this project argues
against.

## Verify it yourself, without trusting this file

```bash
# every listed transaction succeeded, touched the pool, and ran through our gate
node scripts/verify-onchain.mjs
```

The script re-reads `strk20.json`, fetches each receipt from a public RPC endpoint, and asserts:
the transaction exists, its execution status is `SUCCEEDED`, it carries an event emitted by the
STRK20 pool, and it carries an event emitted by our `PolicyGate`. It prints a line per check and
exits non-zero on the first failure. It takes no arguments and needs no credentials.

The state those transactions ran against is checkable on its own, with no transaction and no
wallet:

```bash
node scripts/rehearse.mjs
```

It reads the gate's four wiring pointers, the registered issuer's key and standing, and all three
published policies field for field; builds the action array for every leg and asserts the shape,
the three wallet placeholders and that a withdraw carries exactly the signed amount; and predicts
each refusal above against the policies as published — including `CORDON_OVER_CAP` at step 10 and
`CORDON_REVOKED` at step 7. Forty-three checks, or a hundred and two with `ISSUER_PRIVATE_KEY` set,
which additionally signs a credential and verifies it against the key read off the `IssuerRegistry`
rather than a locally derived one. Nothing is sent and no account key is touched.

## Timing

The repository's first commit and every transaction above are dated inside the sprint window
(14–31 August 2026). `git log --reverse --format='%ad %s' | head -1` shows the start.
