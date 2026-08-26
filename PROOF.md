# Proof

Every claim in this repository that can be checked on chain, with the link to check it.

> **Status: not yet deployed to mainnet.** This file is filled in by the deployment, not written
> ahead of it. Nothing below is a placeholder standing in for a result we expect — an empty row
> means the transaction has not happened yet. Deploying replaces this notice.

## Network

| | |
|---|---|
| Chain | Starknet mainnet (`SN_MAIN`) |
| STRK20 pool | [`0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a`](https://voyager.online/contract/0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a) |
| STRK | [`0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d`](https://voyager.online/contract/0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d) |

## Deployed contracts

| Contract | Address | Class hash |
|---|---|---|
| `PolicyGate` | — | — |
| `IssuerRegistry` | — | — |
| `RevocationRegistry` | — | — |
| `PolicyRegistry` | — | — |

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
