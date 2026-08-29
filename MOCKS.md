# What is real and what is simulated

A privacy-and-compliance product is easy to fake and hard to check, so here is the line, drawn
explicitly. If something below is simulated, it says so and it says why.

## Real

| Component | What "real" means here |
|---|---|
| **The privacy pool** | Starknet's live mainnet STRK20 pool. Not a fork, not a redeploy, not a mock. Address in [`PROOF.md`](./PROOF.md). |
| **The gate** | Our own Cairo contract, deployed to Starknet mainnet, called by the real pool through `privacy_invoke`. |
| **The token** | Real STRK on mainnet. No test token, no mock ERC20 outside the test suite. |
| **The refusals** | Real reverted mainnet transactions. The over-cap and revoked-payee refusals in the demo are transactions that actually failed on chain, with explorer links. |
| **Sanctions screening** | The **live OFAC SDN list** published by the U.S. Treasury, fetched at issuance time and parsed for digital-currency addresses. The issuer refuses to attest a listed address, and refuses to attest anything at all when the list cannot be fetched. |
| **Signatures** | STARK-curve signatures verified on chain by the gate. The TypeScript and Cairo hash implementations are cross-checked against pinned fixture vectors in both directions. |

## Simulated, and why

| Component | What is simulated | Why |
|---|---|---|
| **The issuer's identity** | We operate the issuer ourselves. A real deployment would have a licensed KYC or accreditation provider hold that key. | Nobody licenses an attestation authority over a weekend. The *mechanism* — issuer registry, signature verification, revocation — is real and is what the gate enforces. |
| **The accreditation claim** | `ACCREDITED` and `KYC_L2` are attested by us, not by a broker-dealer or a KYC provider. | Same reason. `NOT_SANCTIONED` is **not** in this row: that one is screened against real OFAC data. The distinction is not left to this table — the issuer service records each credential with the evidence behind it, `ofac-screen` or `operator-attestation`, refuses to attest anything in the second category without the admin token and a written basis, and cannot reach the screening code from that path at all. `GET /issuer` publishes which is which. |
| **Policy parameters** | The demo policy's cap and epoch length are chosen to make the limits visible inside a three-minute video. | A realistic cap would take days to breach. The enforcement is identical at any parameter. |

## Not claimed

- We do not claim amount privacy. Value routed through any anonymizer settles at a plaintext amount.
- We do not claim the pool's anonymity set protects anyone at current usage. It is measurably small,
  and we say so in the [README](./README.md#honest-limits) rather than leaning on it.
- We do not claim the issuer is trustworthy. Cordon makes an attestation *enforceable*, not *true*.
- We do not claim an audit. The contracts were reviewed adversarially in-house and the findings are
  in the repository history; that is not a substitute for a professional audit, and this code has
  not had one.

## Where the mock ERC20 and mock pool do exist

`contracts/src/mocks/` contains a mock ERC20 and a mock pool. They are compiled **only into the test
target** (`#[cfg(test)]`) and exist so the test suite can reproduce the pool's exact calling
convention — transfer in, invoke, pull the approved amount back out — without spending mainnet STRK
on every assertion. They are never deployed and are not reachable from any shipped contract.
