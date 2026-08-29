# Cordon issuer

The attestation service. It screens a public Starknet address against the **live U.S. Treasury
OFAC sanctions lists** and signs a `NOT_SANCTIONED` credential — or refuses, and records why.

There is no mock in here and no sample data path. The lists it reads are the ones OFAC publishes,
fetched over the network, parsed from OFAC's own XML schema, and cached with the fetch timestamp
and the resolved source URL attached to every decision. When those lists cannot be reached, the
service says `unavailable` and issues nothing. It never falls back to a default-clean answer.

## Why that last paragraph is the whole point

A compliance checkmark is only worth what the check behind it was worth. A screening service that
answers "clean" when it could not reach its source has not screened anything; it has produced a
signature that somebody downstream will rely on. So the failure behaviour is a first-class feature
here, and `test/screening.test.ts` exercises every way the lookup can fail:

- the host is unreachable
- the source returns an HTTP error
- the source returns something that is not a sanctions list (an error page served with a 200 is the
  nastiest case: it parses fine and contains no listed addresses, which is indistinguishable from a
  clean list unless it is rejected outright)
- only some of the sources answer — a partial snapshot is a screen with a hole in it
- the cached snapshot is older than the freshness limit

Every one of those answers `unavailable`, and every one is recorded.

## What it attests, and what it does not

One claim comes with evidence: `NOT_SANCTIONED`. That is the only thing this service has a source
it can check for itself, and the only one it will sign on nobody's authority but the Treasury's.

A deployment can also be configured to attest claims it has **no** source for — `ACCREDITED`,
`KYC_L2`, whatever a gate's policies ask for — and the difference between the two is the point of
the design rather than a footnote:

| | `NOT_SANCTIONED` | anything in `ISSUER_ATTESTED_CLAIMS` |
| --- | --- | --- |
| evidence | `ofac-screen` | `operator-attestation` |
| what happens | the lists are fetched and the address is screened | nothing is screened |
| needs the admin token | no | **yes** |
| needs a written `basis` | no | **yes**, recorded verbatim |
| stored against the credential | the screening, with its provenance | the operator's basis and the time |
| what it is worth | what the check was worth | what the operator's word is worth |

`ISSUER_ATTESTED_CLAIMS` is empty by default, so a service brought up with only a signing key can
do nothing but screen. The two paths are separate functions taking different arguments — `issue`
takes a `Screening` and cannot be reached without one, `attest` takes no screening at all — so
nothing can drift into attaching a screening record to a credential that was never screened. A
test asserts the attested path cannot reach the OFAC code even when a caller sends an address.

The alternative was to leave those claims to a second issuer under a second id, which is cleaner in
principle and is still the right answer in production. It is not the right answer for a service
somebody has to run to demonstrate a gate: it would mean a second key, a second registration and a
second deployment to assert something a human decided anyway. What matters is that the register
never implies a check that did not happen, and it does not.

Two honest limits on the screened claim, stated because they matter:

- **OFAC lists no Starknet addresses today.** The 1,007 digital-currency addresses on the current
  SDN list are filed under 20 assets — `XBT`, `ETH`, `TRX`, `USDT`, `SOL` and others — and `STRK`
  is not among them. The applicant's address is screened against the entire set regardless, in
  padded, unpadded and prefixless forms, so the day OFAC adds one it is caught with no code change.
  `GET /health` prints the asset list so this is visible rather than assumed.
- **The screening covers the address you give it.** It is an address screen, not an identity
  screen: it does not check names, does not do fuzzy matching on people, and does not trace funds.
  It answers exactly one question — is this address on the list — and says so.

## Privacy

The address is screened and recorded. It never enters the credential.

What the credential carries is the subject's **pseudonym**: a STARK-curve public key the holder
generated locally, with no link to any wallet. That is what makes it presentable on chain without
tying the subject to the wallet that was screened, and there is a test asserting the screened
address does not appear anywhere in the issued credential.

## Running it

```sh
cp .env.example .env      # then set ISSUER_PRIVATE_KEY
npm install
npm run refresh           # optional: warm the sanctions cache and print its provenance
npm run dev               # or: npm run build && npm start
```

`.env` is read by Node itself (`--env-file-if-exists`), so a missing one is not an error — the
service falls back to the ambient environment and, failing that, exits with a message naming what
it needed. The SDK is a workspace dependency (`file:../../packages/sdk`) and builds itself on
install.

Nothing reaches this service from a browser until `ISSUER_ALLOWED_ORIGINS` names an origin. That
default is deliberate: the process holds an attesting key, and the only thing worse than a console
that cannot reach it is a page on any origin that can. The allowlist is exact — no wildcard, no
reflecting whatever `Origin` arrived, and no credentials.

`npm run refresh` prints exactly what was fetched, which is what you want in front of an audience:

```
fetched 2026-08-26T21:20:11.029Z

  https://www.treasury.gov/ofac/downloads/sdn.xml
    resolved to   https://…/SDN.XML
    published     08/26/2026
    records       19319
    entries       19319
    addresses     1007
    bytes         28966364

  https://www.treasury.gov/ofac/downloads/consolidated/consolidated.xml
    published     07/27/2026
    records       481
    addresses     0

  1007 digital-currency addresses across 20 assets:
    ARB BCH BNB BSC BSV BTG DASH DOGE ETC ETH LTC SOL TRX USDC USDT XBT XMR XRP XVG ZEC
```

## Endpoints

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/issuer` | The four arguments a registry owner needs for `register_issuer`, and the claim catalogue |
| `GET` | `/health` | Whether the sanctions snapshot is fresh enough to issue against. 503 when it is not |
| `POST` | `/credentials` | Screen an address, then sign or refuse |
| `GET` | `/credentials` | Every credential issued, with the screening that justified it |
| `GET` | `/credentials/:id` | One credential |
| `POST` | `/credentials/:id/revoke` | Withdraw a credential. Admin token |
| `GET` | `/refusals` | Every screening that did not produce a credential |
| `POST` | `/ofac/refresh` | Force a snapshot refresh. Admin token |

### Requesting a credential

```sh
curl -X POST localhost:8787/credentials -H 'content-type: application/json' -d '{
  "subjectPublicKey": "0x1ce8adcb0d0e5e0d0a3e2b8b8f9e5c3b2a1908070605040302010f0e0d0c0b0",
  "address": "0x0511f0e5d0ce2b0b1e1a3d4c5b6a79887766554433221100ffeeddccbbaa9988"
}'
```

Add `"claim"` to ask for something other than `NOT_SANCTIONED`. An attested claim takes a `basis`
and the admin token instead of an `address`:

```sh
curl -X POST localhost:8787/credentials   -H 'content-type: application/json' -H 'authorization: Bearer $ISSUER_ADMIN_TOKEN' -d '{
  "subjectPublicKey": "0x1ce8adcb0d0e5e0d0a3e2b8b8f9e5c3b2a1908070605040302010f0e0d0c0b0",
  "claim": "ACCREDITED",
  "credentialId": "0x50415945525f4143435f31",
  "basis": "Reg D questionnaire, reviewed 2026-08-29"
}'
```

`201` — signed, with the credential, its compact form for a QR code, and the screening:

```json
{
  "issued": true,
  "claim": "NOT_SANCTIONED",
  "credential": { "issuerId": "0x434f52444f4e5f4f464143", "…": "…" },
  "compact": "AQAAAAAAAAAA…",
  "screening": {
    "status": "clear",
    "comparedForms": ["0x0511f0…", "0x00…0511f0…", "0511f0…"],
    "provenance": {
      "fetchedAt": "2026-08-26T21:20:11.029Z",
      "ageSeconds": 85,
      "addressCount": 1007,
      "assets": ["ARB", "BCH", "…"],
      "sources": [{ "url": "https://www.treasury.gov/ofac/downloads/sdn.xml", "publishDate": "08/26/2026" }]
    }
  }
}
```

`403` — the address is listed. This is a real response to a real SDN entry:

```json
{
  "issued": false,
  "error": "sanctioned",
  "message": "Listed by OFAC under Behzad MESRI. No credential will be issued.",
  "screening": {
    "status": "match",
    "matches": [{ "asset": "ETH", "name": "Behzad MESRI", "programs": ["CYBER2", "HRIT-IR"], "entryUid": "24003" }]
  }
}
```

`503` — nothing was concluded, so nothing was signed:

```json
{
  "issued": false,
  "error": "unavailable",
  "message": "Sanctions screening is unavailable, so nothing was checked and nothing will be issued. …"
}
```

The two are deliberately different status codes. `403` is a decision the caller should act on.
`503` is the absence of a decision and the caller should retry, not conclude anything.

## Signing

Credentials are signed by `@cordon/sdk`'s `issueCredential`, which hashes the fields with the same
Poseidon preimage `PolicyGate` verifies against and signs it with the STARK curve. This service
contains no hash function of its own — reimplementing one would be the single most likely way to
produce credentials the chain refuses as `CORDON_BAD_CRED` with no explanation.

To put this issuer into service on chain, take the four arguments from `GET /issuer` and register
it. The response includes them under `registerIssuer`, in order:

```cairo
IssuerRegistry::register_issuer(
    'CORDON_OFAC',              // issuer_id
    <publicKey>,                // the key this service signs with
    <operator>,                 // ISSUER_OPERATOR_ADDRESS
    "https://…/issuer.json",    // metadata_uri
)
```

**The operator matters.** It is the only address that may revoke this issuer's credentials — not
even the registry owner can — and the only one that may hand the role on. It is a wallet you
control, not this service: revocation is an on-chain transaction, and this service holds an
attesting key, not an account. Register without one and nobody can ever withdraw an attestation;
`GET /issuer` warns when `ISSUER_OPERATOR_ADDRESS` is unset.

Then publish a policy that requires the claim, pinned to the token you intend to settle:

```cairo
PolicyRegistry::publish_policy('PAY_CLEAN_V1', Policy {
    required_claim: 'NOT_SANCTIONED',
    issuer_id: 'CORDON_OFAC',
    token: STRK,
    ..
})
```

## Revocation

`POST /credentials/:id/revoke` records the issuer's decision and requires a reason — a revocation
without one is unauditable. It does **not**, on its own, stop the credential settling: the gate
reads the on-chain `RevocationRegistry`, so the registered operator still has to call `revoke`
there, from the address `register_issuer` recorded. The response names that address rather than
implying the credential is already dead everywhere.

## Key handling

- The signing key comes from `ISSUER_PRIVATE_KEY` and nowhere else. There is no file fallback and
  no default.
- It is never logged. `redactConfig` — what the service actually logs at startup — does not merely
  mask the key, it omits the field, because a masked field is one refactor away from an unmasked
  one. A test asserts the key does not appear in it.
- No endpoint returns it. A test asserts `GET /issuer` does not contain it.
- `.env` is gitignored; `.env.example` is what is committed.

## Storage

One JSON file, written atomically, holding every issued credential with its screening, and every
refusal. The refusals are the more interesting half: an issuer that can only show you its successes
cannot show you it was ever working.

## Tests

```sh
npm test                  # the unit and HTTP suites, no network
OFAC_LIVE=1 npm test      # …plus the live Treasury endpoints
```

The default suite drives the real parser, the real cache and the real HTTP surface against an
injected source, so nothing that matters is stubbed. The live suite is opt-in because a unit suite
that fails when a government web server is slow tells you nothing about your code; run it before a
deployment to confirm the sources still answer and still have the shape this service parses. It
asserts nothing about *which* addresses are listed — that changes whenever OFAC publishes, and a
test that pinned today's list would be a test that fails for being right.

## Licence

MIT.
