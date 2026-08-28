# Proof

Every claim in this repository that can be checked on chain, with the link to check it.

> **Status: deployed to mainnet; the demonstration transactions are still to come.** This file is
> filled in by what actually happens, not written ahead of it. An empty row below means that
> transaction has not been made yet.

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

| # | What it proves | Result | Transaction |
|---|---|---|---|
| 1 | A credentialed payer inside the policy settles privately through the gate | — | — |
| 2 | A payee presents their own credential and claims an escrowed settlement | — | — |
| 3 | A second policy-compliant payment, on the direct leg | — | — |
| 4 | **A payment over the policy cap is refused on chain** | — | — |
| 5 | **A payee revoked after funding cannot claim** | — | — |

Rows 4 and 5 are reverted transactions. They are the point of the project, and they are deliberately
**not** listed in `strk20.json`: the sprint's eligibility check requires transactions that succeeded,
and a revert is not one. They are linked here instead, which is where the evidence belongs.

## Verify it yourself, without trusting this file

```bash
# every listed transaction succeeded, touched the pool, and ran through our gate
node scripts/verify-onchain.mjs
```

The script re-reads `strk20.json`, fetches each receipt from a public RPC endpoint, and asserts:
the transaction exists, its execution status is `SUCCEEDED`, it carries an event emitted by the
STRK20 pool, and it carries an event emitted by our `PolicyGate`. It prints a line per check and
exits non-zero on the first failure. It takes no arguments and needs no credentials.

## Timing

The repository's first commit and every transaction above are dated inside the sprint window
(14–31 August 2026). `git log --reverse --format='%ad %s' | head -1` shows the start.
