# Minimal Cordon example

A whole gated private payment in one file. Copy the directory, change four constants, run it.

```sh
npm install
npm run dev
```

## What to change

Everything you need to edit is at the top of [`App.tsx`](./App.tsx):

| Constant | What it is |
| --- | --- |
| `GATE` | Your deployed `PolicyGate`. The pool, token, RPC and chain default to the mainnet deployment, and the three registries are read off the gate itself. |
| `POLICY` | A policy id published in the `PolicyRegistry`. |
| `PAYEE` | The pool user being paid. |
| `resolveNoteId` | The resolved `${openNoteIds[0]}` the wallet will substitute. See below. |

## What you will see before it works

Open it with none of that filled in and the page still renders — that is the point. The payment
button is disabled and lists exactly what is missing: no wallet, no credential, no subject key, no
note id. Nothing shows a zero balance or a fake success while it waits.

You will need:

- **A wallet that implements the STRK20 methods.** Today that is Ready. `<ConnectWallet>` probes
  with a read-only call and says so plainly if the wallet cannot do private actions at all.
- **A credential** from an issuer registered in the `IssuerRegistry`, attesting the claim the
  policy requires, about your subject pseudonym. Paste it into the passport card — JSON, the
  compact encoding, or a `cordon-credential:` URI all work.
- **A subject key.** Press "Derive my subject key": the wallet signs a SNIP-12 message and the
  signature is ground into a STARK key, so the same pseudonym comes back on any device without
  anything being stored.
- **A note id.** This is the one piece the package cannot supply.

## Why `resolveNoteId` is your job

`"${openNoteIds[0]}"` is a literal string the *wallet* substitutes while assembling the
transaction. The gate, though, hashes the felt it actually received — so the subject's signature
has to cover the resolved value, which the app does not know at signing time.

Rather than guess, the button stays blocked and says why. Signing the placeholder instead would
produce a transaction that reverts with `CORDON_BAD_SUBJECT_SIG` after the pool has already charged
its fee.

If your flow cannot resolve one, use the `fund` leg instead: it reserves no open note, so it needs
no note id, and the payee presents their own credential later on `claim`.

```tsx
<GatedPaymentButton
  leg="fund"
  policyId={POLICY}
  amount={amount}
  credential={passport.credential}
  subjectPrivateKey={passport.subject?.privateKey}
  payeeSubjectKey={PAYEE_PSEUDONYM}   // only this pseudonym can claim
  payeeClaimPolicyId={POLICY}
  expiresAt={Math.floor(Date.now() / 1000) + 86_400}
/>
```

Note what is absent: a settlement id. The SDK generates a random one, and that is not a
convenience. An id is single-use forever and is the only handle in the event log, so a memorable
one can be burned ahead of you by a stranger and ties the funding to the claim to whatever record
it came from. Passing an invoice number is refused outright. Read the generated id back from
`payment.actions`, or from the `SettlementFunded` row in `<GateFeed>`, and give it to the payee.

## Seeing a refusal

The most useful thing to try. Set the amount above the policy's per-transaction cap and press pay:
the pre-flight catches it before the wallet is ever asked, and `<RefusalNotice>` names
`CORDON_OVER_CAP` — for free, with no transaction and no fee.

To make it an on-chain fact instead of a prediction, pass `force`:

```tsx
<GatedPaymentButton force … />
```

That submits the transaction, the gate panics, the whole thing reverts, the value stays shielded,
and the notice links the reverted transaction on Voyager.
