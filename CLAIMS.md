# Claims ledger

Every public statement Cordon makes, tagged by what backs it. The point of this file is that you
should not have to take any sentence in the README on trust.

**Tiers**

- `REPRODUCIBLE` — you can re-derive it yourself from this repository with the command given.
- `VERIFIED-LIVE` — it is checkable right now against Starknet mainnet or a live third-party source.
- `MODELED` — argued from the design or measured off-chain; not independently verifiable here.
- `NOT-CLAIMED` — explicitly disclaimed. Listed so the absence is deliberate rather than an omission.

---

## Enforcement

| Claim | Tier | Evidence |
|---|---|---|
| An uncredentialed, revoked, expired or claim-mismatched payer cannot move value through the gate | `REPRODUCIBLE` | `cd contracts && snforge test` — each refusal is its own `#[should_panic]` test |
| A payment over the policy's amount cap is refused | `REPRODUCIBLE` | the test suite proves the gate reverts. On mainnet it never becomes a transaction at all — see the paymaster row below and [`PROOF.md`](./PROOF.md#why-there-is-no-reverted-transaction-for-the-cap) |
| A payer over the per-epoch velocity budget reverts, and the budget resets on rollover | `REPRODUCIBLE` | `spend_resets_when_the_epoch_advances` and the velocity refusal tests |
| A payee revoked between funding and claiming cannot take the money | `REPRODUCIBLE` | `a_payee_revoked_between_funding_and_claiming_cannot_take_the_money`, and its negative control: the identical claim pays when the credential is not revoked. Not shown on mainnet — a refused claim is filtered by the paymaster the same way a capped payment is |
| The refusal tests are not vacuous | `REPRODUCIBLE` | mutation checks: deleting the revocation check fails exactly 3 tests; deleting the settlement-status write fails 4. Revert either edit and the suite is green again |
| A signature cannot be replayed across legs, policies, amounts, gates or chains | `REPRODUCIBLE` | the action preimage binds all of them; see [`contracts/HASHING.md`](./contracts/HASHING.md) and the replay tests |
| A published authorisation cannot be redirected to a stranger's note | `REPRODUCIBLE` | the authorisation binds the note it may fill, and a note id commits to its owner's key. Tested by the harvested-claim redirection attempt and its negative control — the identical authorisation into the note it was signed for, which pays |
| An authorisation signed in unbound mode **is** redirectable, which is why it is time-boxed | `REPRODUCIBLE` | `an_unbound_claim_is_redirectable_which_is_why_it_is_time_boxed` asserts the exposure rather than hiding it; the gate refuses an unbound authorisation with no deadline, or one more than 600s out |
| Unbound mode is as safe as bound mode | `NOT-CLAIMED` | it is not. The destination is chosen after signing, so no contract change can close it — the mode is opt-in, stated inside the signed message, and never the default |
| Only the pool can drive the gate | `REPRODUCIBLE` + `VERIFIED-LIVE` | the pool address is fixed at construction and asserted against `get_caller_address()`; regression tests derived from an in-house audit's proof-of-concept exploits, and a **real reverted mainnet transaction** — [`0x1645148b…e7839`](https://voyager.online/tx/0x1645148beb027368b945f6e63e4d7e95954c1f1e9e03d303001aa11ca1e7839), `CORDON_BAD_POOL` |
| A payment over its cap never becomes a transaction | `VERIFIED-LIVE` | the wallet's paymaster simulates it, sees the gate revert and declines to sponsor it (`PaymasterV2Error 156`). The refusal has a witness we do not control |
| There is a reverted mainnet transaction showing `CORDON_OVER_CAP` | `NOT-CLAIMED` | there is not, and there cannot be one through a wallet — see [`PROOF.md`](./PROOF.md#why-there-is-no-reverted-transaction-for-the-cap). We say so rather than substituting a different refusal |
| The gate settled real value on mainnet | `VERIFIED-LIVE` | three transactions in `strk20.json`, each carrying a `PolicyPassed` event; `node scripts/verify-onchain.mjs` checks all four conditions the sprint checks |
| The payee claims with their own key, so revoking their credential can stop them | `VERIFIED-LIVE` | transaction 3 moved the settlement to `Claimed`, authorised by the payee's own subject key, in the payee's own transaction |

## Integration

| Claim | Tier | Evidence |
|---|---|---|
| The gate is called by the real mainnet STRK20 pool, not a fork or a mock | `VERIFIED-LIVE` | transaction hashes in `PROOF.md`; each carries a pool event and an event from our gate |
| The Cairo and TypeScript hash implementations agree | `REPRODUCIBLE` | `cd packages/sdk && npm test` — the conformance suite re-reads the fixture vectors out of `contracts/src/tests/test_hashing.cairo` at test time, so the two cannot drift |
| Every `CORDON_*` refusal code has a human-readable explanation in the SDK | `REPRODUCIBLE` | a test parses `contracts/src/errors.cairo` and asserts the mapping in both directions |

## Screening

| Claim | Tier | Evidence |
|---|---|---|
| Sanctions screening uses the live OFAC SDN list, not a fixture | `VERIFIED-LIVE` | `cd services/issuer && OFAC_LIVE=1 npm test` fetches from the U.S. Treasury and asserts against it |
| A real listed address is refused | `REPRODUCIBLE` | the issuer returns `403` with the listing reason; test included |
| The issuer never invents a clean result | `REPRODUCIBLE` | 8 fail-closed tests, including an error page served with HTTP 200 — it parses cleanly and contains no addresses, which is indistinguishable from a clean list unless refused outright |

## Privacy

| Claim | Tier | Evidence |
|---|---|---|
| Payer and payee identities are not published by Cordon | `MODELED` | the gate emits no subject keys; pool transactions are relayed by rotating shared relayers. Correlation from timing and amounts remains possible — see below |
| A subject pseudonym is not linked on-chain to the wallet that funded it | `MODELED` | the pseudonym is a locally generated keypair that never enters a wallet |
| Amounts are private | `NOT-CLAIMED` | value routed through any anonymizer settles at a plaintext amount. Stated in the README |
| The anonymity set protects a user | `NOT-CLAIMED` | independently measured at a median effective set of 1.00, 72% of deposits alone in their cell. We report it rather than rely on it |
| A chain observer cannot correlate a funding with its claim | `NOT-CLAIMED` | they share a settlement id by construction. Amounts and timing narrow it further |
| The issuer cannot deanonymise a subject | `NOT-CLAIMED` | the issuer sees the applicant's public address and the pseudonym it attests. Splitting that is future work, not a shipped property |

## Security

| Claim | Tier | Evidence |
|---|---|---|
| The contracts were reviewed adversarially before deployment | `REPRODUCIBLE` | the review's proof-of-concept exploits ship as regression tests; the fixes are in the commit history |
| A bug was found by reading real mainnet calldata, not by guessing | `REPRODUCIBLE` | the SDK read the resolved note id from the wrong position, binding every authorisation to a nonsense note. `packages/sdk/test/fixtures/mainnet-calldata.ts` holds the 111 felts of the transaction that exposed it, and a test asserts the reader does **not** read from the end of the array |
| The diagnostic contract is not counted as product | `REPRODUCIBLE` | `EchoGate` enforces nothing and is deployed; its two invocations are documented in `PROOF.md` and deliberately absent from `strk20.json` |
| The contracts are professionally audited | `NOT-CLAIMED` | they are not. Treat this as hackathon-grade code holding hackathon-sized amounts |
| The owner cannot take escrowed value | `REPRODUCIBLE` | registry pointers are immutable after construction; the sweep function can only move balance in excess of the internal ledger. Tested |
