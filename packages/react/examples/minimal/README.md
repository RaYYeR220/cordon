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

## What you will see before it works

Open it with none of that filled in and the page still renders — that is the point. The payment
button is disabled and lists exactly what is missing: no wallet, no credential, no subject key.
Nothing shows a zero balance or a fake success while it waits.

You will need:

- **A wallet that implements the STRK20 methods, including `strk20PrepareInvoke`.** Today that is
  Ready. `<ConnectWallet>` probes with a read-only call and says so plainly if the wallet cannot do
  private actions at all; the payment button separately reports a wallet that cannot do prepared
  invokes, because that is what resolves the note this payment is allowed to land in.
- **A credential** from an issuer registered in the `IssuerRegistry`, attesting the claim the
  policy requires, about your subject pseudonym. Paste it into the passport card — JSON, the
  compact encoding, or a `cordon-credential:` URI all work.
- **A subject key.** Press "Derive my subject key": the wallet signs a SNIP-12 message and the
  signature is ground into a STARK key, so the same pseudonym comes back on any device without
  anything being stored.

## Why there is no note id to supply

An authorisation names the note it may land in. That is what makes a leaked one worthless — and
they do leak: Starknet publishes reverted transactions with their full calldata and a revert does
not burn the nonce, so a claim that fails for a mundane reason would otherwise broadcast a live
authorisation anyone could redirect into a note of their own.

Nobody can know that note id in advance, because the wallet substitutes `${openNoteIds[0]}` while
it assembles the transaction. So the SDK asks the wallet: prepare once to learn the id, sign bound
to it, prepare again, and check it did not move. All of that happens inside `<GatedPaymentButton>`.

Two outcomes are worth trying deliberately:

- If the note **moves** between the two prepares — another transaction landed on your channel — the
  button reports it and relabels itself **Try again**. Nothing was submitted. That is the check
  working, not a bug.
- If your wallet has no `strk20PrepareInvoke`, the button stays disabled and says so. There is no
  fallback, on purpose: signing an authorisation that any note can satisfy is the one thing this
  package will not do quietly.

## The escrowed alternative

The `fund` leg fills no note at all, so it prepares once and has no binding to resolve. Use it when
the policy requires the payee to be credentialed too: the payer clears their own policy and names
the payee's pseudonym, and the payee authenticates themselves later on `claim`.

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
