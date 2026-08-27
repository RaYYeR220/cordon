# @cordon/react

Drop-in React hooks and components for **Cordon**, a credential and policy gate for shielded
STRK20 value on Starknet.

Value physically routes through a Cairo anonymizer on its way back into a private note, so the rule
is unbypassable: an unaccredited, revoked, expired, over-cap or over-velocity party cannot move pool
funds at all — the gate panics and the whole transaction reverts. This package is the front end of
that, and its main job is to make a refusal legible: the exact `CORDON_*` code, one plain sentence
about which rule fired, who can fix it, and a link to the reverted transaction.

```sh
npm install @cordon/react @cordon/sdk starknet
```

Peer dependencies: `react@^19`, `starknet@^10.4.0`, `@cordon/sdk@^0.1.0`.

## Quickstart

```tsx
import { CordonProvider, ConnectWallet, GatedPaymentButton } from "@cordon/react";
import "@cordon/react/styles.css";

<CordonProvider config={{ gateAddress: GATE }}>
  <ConnectWallet />
  <GatedPaymentButton policyId="ACCREDITED" amount={10n ** 18n} payee={PAYEE}
    credential={credential} subjectPrivateKey={subjectKey} noteId={noteId} />
</CordonProvider>
```

Only `gateAddress` is required. The pool, the token, the RPC and the chain default to the mainnet
deployment, and the three registries are read off the gate itself — it stores the addresses it
trusts, so you do not have to.

The provider also reads the chain id and `PolicyGate::privacy_pool()` before anything is signed.
Both are inside every signed message, and both are easy to get wrong from configuration — a
`chainId` default that is really Sepolia, or a pool address that is not the one the gate was
constructed against. A mismatch blocks the payment with the reason named, rather than becoming a
`CORDON_BAD_POOL` revert the user has already paid for.

## Three things to know before you wire this up

**A refusal is not an error.** It is the product working. `useGatedPayment` gives it its own
terminal state, separate from `failed` (the node was unreachable, the user declined) and
`unconfirmed` (we stopped waiting). Branch on `refusal.remedy` — `payer`, `issuer`, `operator`,
`integrator` — because telling someone to "contact your issuer" when they merely need to send less
is the difference between a useful refusal and a dead end.

**Nothing here fabricates state.** A balance, a policy or a revocation status that could not be read
renders as `unavailable`. Never a zero, never an optimistic success. `<SpendMeter>` with an
unreadable velocity counter shows a striped, valueless track rather than a full allowance, because
"you have your whole limit left" is the most dangerous thing it could say wrongly.

**The subject signs a resolved note id, and only the wallet knows it.** `${openNoteIds[0]}` is a
literal the wallet substitutes while assembling the transaction, but the gate hashes the felt it
actually received — so the subject's signature has to cover the resolved value. This package cannot
invent it. Pass `noteId` for the `direct`, `claim` and `refund` legs; without it the hook reports
itself blocked rather than signing something the gate would answer with
`CORDON_BAD_SUBJECT_SIG`. The `fund` leg reserves no note and needs nothing. See
[Gating your own flow](#gating-your-own-flow).

## Hooks first, components second

Every component is a thin render over a hook. If you dislike the visuals, take the hooks — nothing
in the logic depends on the markup.

| Hook | What it gives you |
| --- | --- |
| `useCordonWallet()` | Connect a wallet **and** probe whether it implements the STRK20 methods at all. `status` is one of `no-wallet`, `disconnected`, `connecting`, `probing`, `ready`, `unsupported`, `error`; `canPay` is true only for `ready`. |
| `useCordonCredential(options?)` | Load, store and validate a credential. `status` is `none`, `checking`, `valid`, `refused` or **`unknown`** — that last one when a registry read failed, so the credential's standing is genuinely not known. Also holds the subject pseudonym (`deriveSubject`, `generateSubject`). |
| `useCordonPolicy(policyId, options?)` | Read a published rule set, plus a subject's velocity counter. `status` distinguishes `missing` (the registry said nothing is published) from `unavailable` (the node would not answer). |
| `useGatedPayment(options?)` | Build → sign → submit one leg, with the whole machine exposed: `idle`, `building`, `awaiting-signature`, `submitted`, `confirmed`, `refused`, `failed`, `unconfirmed`. Runs a free pre-flight first and stops on a predicted refusal unless you `pay({ force: true })`. |
| `useGateFeed(options?)` | On-chain passes merged with this session's refusals, each row labelled with where it came from. |

The UI-free chain layer underneath is published separately as `@cordon/react/strk20` — wallet
discovery, the capability probe, balance reads, contract reads, gate-event decoding, error
normalisation and submission, with no React anywhere in it.

**The two entry points sit on opposite sides of React's server boundary**, deliberately.
`@cordon/react` ships with `"use client"`, because it is hooks and components. `@cordon/react/strk20`
does not, so a React Server Component, a route handler or a plain Node script can read a policy or
decode gate events without pulling a client bundle in behind it.

```ts
// server component, route handler, script — no React involved
import { readPolicy, readGateEvents } from "@cordon/react/strk20";
```

## Components

All of them accept `className`, render semantic markup, and take `headingLevel` where they own a
heading so they fit your document outline instead of hard-coding `<h3>`.

### `<CordonProvider>`

| Prop | Type | Default | What it does |
| --- | --- | --- | --- |
| `config` | `{ gateAddress, rpcUrl?, poolAddress?, token?, tokenDecimals?, chainId?, registries? }` | — | Required. Only `gateAddress` has no default. |
| `provider` | `CordonRpc` | a new `RpcProvider` | Use the provider your app already has, so the page holds one connection to the node rather than two. |
| `storage` | `CordonStorage \| null` | `window.localStorage` | Where credentials persist. `null` disables persistence entirely. |
| `discoverWallets` | `boolean` | `true` | Turn off if your app already owns the wallet connection. |

### `<ConnectWallet>`

| Prop | Type | Default | What it does |
| --- | --- | --- | --- |
| `title` | `ReactNode \| null` | `"Wallet"` | `null` renders no heading. |
| `headingLevel` | `1…6` | `3` | |
| `noWalletMessage` | `ReactNode` | a sentence about installing one | Shown when no wallet announced itself. |
| `focusOnConnect` | `boolean` | `true` | Moves focus to the connected account, since the button the user pressed has just disappeared. |
| `onConnected` | `(address: string) => void` | — | |

### `<PassportCard>`

| Prop | Type | Default | What it does |
| --- | --- | --- | --- |
| `credential` | `UseCordonCredential` | its own `useCordonCredential()` | Pass one in when you are managing the credential. |
| `allowImport` | `boolean` | `false` | Shows a paste box accepting JSON, the compact encoding, or a `cordon-credential:` URI. |
| `showRefusal` | `boolean` | `true` | Renders the first refusal in full below the fields. |
| `title`, `headingLevel`, `className` | | | |

### `<PolicyBadge>`

| Prop | Type | Default | What it does |
| --- | --- | --- | --- |
| `policyId` | `FeltLike \| null` | — | The policy to read. |
| `policy` | `UseCordonPolicy` | — | An already-read policy; overrides `policyId`. |
| `compact` | `boolean` | `false` | Just the pill, for inline use beside a button. |
| `decimals` | `number` | the token's | |
| `title`, `headingLevel`, `className` | | | |

### `<SpendMeter>`

The "make the enforcement visible" element: two bars, because the gate enforces two different
limits and a user who trips one needs to know which.

| Prop | Type | Default | What it does |
| --- | --- | --- | --- |
| `policyId` | `FeltLike \| null` | — | |
| `subjectPublicKey` | `FeltLike \| null` | — | Without it the velocity counter cannot be read, and the meter says so. |
| `amount` | `bigint \| null` | `null` | The payment being considered, so the cap bar shows how close it comes — and warns about `CORDON_OVER_CAP` before anything is signed. |
| `pollMs` | `number` | `15000` | `0` polls never. |
| `policy`, `decimals`, `title`, `headingLevel`, `className` | | | |

### `<GatedPaymentButton>`

Takes every `useGatedPayment` option, plus:

| Prop | Type | Default | What it does |
| --- | --- | --- | --- |
| `payment` | `UseGatedPayment` | its own | Pass one in when you are driving the machine yourself. |
| `force` | `boolean` | `false` | Submit even when the pre-flight predicted a refusal. The pool charges its fee either way, so this is off by default — turn it on when the revert is the point. |
| `showSteps` | `boolean` | `true` | The step list. Worth keeping: each STRK20 step can take minutes. |
| `showRefusal` | `boolean` | `true` | |
| `children` | `ReactNode` | `"Pay"` | Idle label. |

### `<RefusalNotice>`

| Prop | Type | Default | What it does |
| --- | --- | --- | --- |
| `refusal` | `Refusal \| null` | — | The live region stays mounted when this is `null`, so the next refusal announces. |
| `transactionHash` | `string \| null` | `null` | |
| `predicted` | `boolean` | `false` | Says the refusal was worked out locally and nothing was submitted. |
| `autoFocus` | `boolean` | `false` | Appropriate after a user-initiated payment; wrong for a refusal that appears on its own. |
| `explorerUrl` | `(hash: string) => string` | Voyager | |

### `<GateFeed>`

| Prop | Type | Default | What it does |
| --- | --- | --- | --- |
| `kinds` | `GateEventName[]` | all | `PolicyPassed`, `SettlementFunded`, `SettlementClaimed`, `SettlementRefunded`, `DustSwept`. |
| `limit` | `number` | `25` | |
| `pollMs` | `number` | `15000` | |
| `fromBlock` | `number` | `0` | |
| `chainOnly` | `boolean` | `false` | Drop this session's refusals and show only what the chain says. |
| `showProvenanceNote` | `boolean` | `true` | |
| `decimals`, `title`, `headingLevel`, `className` | | | |

**Why refusals are session-local.** A refusal panics, the panic reverts the whole pool transaction,
and a reverted transaction emits nothing. There is no refusal event and there cannot be one — that
is exactly what makes this a gate rather than a report written afterwards. So the feed reads passes
from `PolicyPassed` events and merges the refusals this session watched happen, labelling each row
with its origin rather than blending them. No gate event carries a subject pseudonym either: the log
proves the rules held, not who paid whom.

## Theming

Import the stylesheet once, then override custom properties anywhere — on `:root`, on a wrapper, or
on a single component. Every rule in the stylesheet is wrapped in `:where()`, so its specificity is
zero and one plain class of yours outranks it. There is no CSS-in-JS runtime and no Tailwind
dependency.

```css
:root {
  --cordon-accent: #4f46e5;
  --cordon-radius: 4px;
  --cordon-font: "Inter", system-ui, sans-serif;
}
```

| Variable | Default (light) | What it colours |
| --- | --- | --- |
| `--cordon-bg` | `#ffffff` | Page ground behind components |
| `--cordon-surface` | `#ffffff` | Card backgrounds |
| `--cordon-surface-subtle` | `#f6f7f9` | Hover fills, insets |
| `--cordon-border` | `#dfe3e8` | Card and row borders |
| `--cordon-border-strong` | `#c3cad3` | Secondary buttons, hover borders |
| `--cordon-text` | `#14181d` | Body text |
| `--cordon-text-muted` | `#5b6672` | Labels, notes, metadata |
| `--cordon-pass` / `--cordon-pass-bg` | `#0f7a4d` / `#e8f5ee` | A rule that held |
| `--cordon-refuse` / `--cordon-refuse-bg` | `#b3261e` / `#fdeceb` | A rule that fired |
| `--cordon-warn` / `--cordon-warn-bg` | `#8a5a00` / `#fdf3e0` | Degraded, but not refused |
| `--cordon-unknown` / `--cordon-unknown-bg` | `#55606d` / `#eef0f3` | Unavailable and idle states |
| `--cordon-accent` / `--cordon-accent-text` / `--cordon-accent-hover` | `#14181d` / `#ffffff` / `#2b323a` | Primary button |
| `--cordon-focus-ring` / `--cordon-focus-offset` | `2px solid #2f6feb` / `2px` | Focus indicator |
| `--cordon-font` / `--cordon-font-mono` | system stacks | Type |
| `--cordon-font-size` / `--cordon-font-size-sm` / `--cordon-font-size-xs` | `0.9375rem` / `0.8125rem` / `0.75rem` | Type scale |
| `--cordon-line-height` / `--cordon-weight-strong` | `1.5` / `600` | |
| `--cordon-radius` / `--cordon-radius-sm` / `--cordon-radius-pill` | `10px` / `6px` / `999px` | Corners |
| `--cordon-border-width` | `1px` | |
| `--cordon-gap` / `--cordon-gap-sm` / `--cordon-pad` / `--cordon-pad-sm` | `0.75rem` / `0.375rem` / `1rem` / `0.5rem` | Rhythm |
| `--cordon-shadow` | `none` | Card elevation |
| `--cordon-meter-height` | `10px` | Meter thickness |
| `--cordon-meter-track` | `#eef0f3` | Meter background |
| `--cordon-meter-fill` / `--cordon-meter-fill-warn` / `--cordon-meter-fill-full` | `#14181d` / `#b8860b` / `#b3261e` | Meter at normal / ≥80% / ≥100% |

A dark palette is supplied under `prefers-color-scheme: dark`. Because it only redefines the same
tokens, setting your own values on a wrapper wins in both schemes.

## Accessibility

Not an afterthought, and the test suite covers it.

- **Real labels.** Every control has an accessible name; the paste box has a `<label>`; icons are
  `alt=""` because the wallet's name is beside them.
- **Live regions.** `<RefusalNotice>` renders inside a permanent `role="alert"` container, so a
  refusal announces when it arrives rather than depending on the element mounting first.
  `<GatedPaymentButton>` has a polite `role="status"` region for progress.
- **Focus management.** `<ConnectWallet>` moves focus to the connected account, because the button
  the user pressed has just disappeared. `<GatedPaymentButton>` moves focus to the refusal — the
  user asked a question and this is the answer.
- **Reasons, not just disabled.** A blocked payment button lists every missing precondition in a
  region it is `aria-describedby`, so the reason is announced and not merely visible.
- **The meter is a `meter`.** `<SpendMeter>` uses `role="meter"` with `aria-valuetext`, and an
  unreadable counter has **no** `aria-valuenow` at all rather than a zero.
- **Colour is never the only signal.** Every verdict pill states its verdict in words; an
  unavailable meter track is striped as well as uncoloured.
- **Headings fit your outline.** `headingLevel` everywhere.
- `prefers-reduced-motion` is honoured.

## Gating your own flow

The worked example. A payer with a credential moves shielded STRK to a payee, under a published
policy, with the enforcement shown live and the refusal named if one fires.

```tsx
import {
  CordonProvider, ConnectWallet, PassportCard, PolicyBadge,
  SpendMeter, GatedPaymentButton, GateFeed,
  useCordonCredential, useCordonWallet,
} from "@cordon/react";
import "@cordon/react/styles.css";

const GATE = "0x…";          // your PolicyGate deployment
const POLICY = "ACCREDITED"; // a published policy id
const PAYEE = "0x…";         // the pool user being paid

function Pay() {
  const wallet = useCordonWallet();
  const passport = useCordonCredential({ requiredClaim: POLICY });
  const amount = 10n ** 18n; // 1 STRK

  return (
    <>
      <ConnectWallet />
      <PassportCard credential={passport} allowImport />
      <PolicyBadge policyId={POLICY} />

      {/* The velocity counter is keyed by the pseudonym, not by the wallet address —
          a new wallet does not reset it. */}
      <SpendMeter
        policyId={POLICY}
        subjectPublicKey={passport.subject?.publicKey}
        amount={amount}
      />

      <GatedPaymentButton
        policyId={POLICY}
        amount={amount}
        payee={PAYEE}
        credential={passport.credential}
        subjectPrivateKey={passport.subject?.privateKey}
        noteId={resolveNoteId}
        onRefused={(refusal) => console.warn(refusal.code, refusal.title)}
      >
        Pay 1 STRK
      </GatedPaymentButton>

      <GateFeed />
    </>
  );
}

export default function App() {
  return (
    <CordonProvider config={{ gateAddress: GATE }}>
      <Pay />
    </CordonProvider>
  );
}
```

Three pieces you supply:

1. **The credential.** Issued by a registered issuer against the subject's pseudonym. Load it with
   `passport.load(text)`, or hand `useCordonCredential` one your backend already holds.
2. **The subject key.** `passport.deriveSubject()` asks the wallet to sign a SNIP-12 message and
   grinds the signature into a STARK key, so the pseudonym is reproducible on any device with
   nothing stored. `passport.generateSubject()` makes a fresh one instead — back it up, it is not
   recoverable. The private half is **not** persisted unless you pass
   `persistSubjectKey: true`.
3. **`resolveNoteId`.** The resolved `${openNoteIds[0]}` the wallet will substitute; see the note
   at the top. `useGatedPayment` accepts a literal or a function returning a promise. If you cannot
   resolve one, use the `fund` leg — it reserves no note, and the payee then presents their own
   credential on `claim`.

Prefer to build your own UI? Everything above is `useGatedPayment`:

```tsx
const payment = useGatedPayment({ policyId: POLICY, amount, payee: PAYEE, credential, subjectPrivateKey, noteId });

payment.status;      // idle | building | awaiting-signature | submitted | confirmed | refused | failed | unconfirmed
payment.blockers;    // [{ code: "NO_CREDENTIAL", message: "Load the credential this policy asks for." }, …]
payment.preflight;   // what the gate would decide, and which checks could not be run
payment.refusal;     // { code: "CORDON_OVER_CAP", title, explanation, remedy, step }
payment.voyagerUrl;
await payment.pay();
```

A copyable single-file version is in [`examples/minimal`](./examples/minimal).

### Escrowed payments, when the payee must be credentialed too

A payer cannot vouch for a payee. The gate never sees who the `transfer(OPEN)` credits, so a policy
with `requirePayeeCredential` can only be satisfied by the payee authenticating themselves. That is
the `fund` → `claim` pair: the payer clears their own policy, names the payee's pseudonym and parks
the value; the payee presents their own credential, in their own private transaction, at the moment
they take it. `refund` closes the loop once the window shuts.

```tsx
// The payer. No note id needed — a fund reserves no open note.
<GatedPaymentButton
  leg="fund"
  policyId={POLICY}
  amount={amount}
  credential={payerCredential}
  subjectPrivateKey={payerKey}
  payeeSubjectKey={PAYEE_PSEUDONYM}     // only this pseudonym can claim
  payeeClaimPolicyId={CLAIM_POLICY}     // what they will have to satisfy
  expiresAt={Math.floor(Date.now() / 1000) + 86_400}
/>

// The payee, later, with their own key and their own credential.
<GatedPaymentButton
  leg="claim"
  settlementId={settlementId}
  credential={payeeCredential}
  subjectPrivateKey={payeeKey}
  recipient={PAYEE}
  noteId={noteId}
/>
```

Leave `settlementId` off the `fund` and the SDK generates a random one. That matters: an id is
single-use forever and is the only handle in the event log, so a predictable one can be burned
ahead of you by a stranger and ties the funding to the claim to whatever record it came from. An
invoice number is refused outright. Read the generated id back from `payment.actions`, or from the
`SettlementFunded` event in `<GateFeed>`.

## Honest limits

- **Only a wallet that implements the STRK20 methods can do this.** Today that is Ready; Braavos
  answers `wallet_strk20Balances` with "Not implemented". `useCordonWallet` probes with that
  read-only call and reports `unsupported` with the wallet's own words rather than failing at
  signing time.
- **The pool charges a flat fee per transaction** (6 STRK at time of writing), taken from an
  already-shielded balance, whatever the outcome. A refused transaction still costs it — which is
  why the pre-flight runs first and why `force` is opt-in.
- **Amounts are public at the gate.** The pool hands an anonymizer a plaintext balance, never note
  amounts. Caps and velocity are genuinely enforceable because value routes through the gate; rules
  over *encrypted* amounts are not possible here and are not claimed.
- **A pre-flight is a prediction, not a promise.** Every check it could not run is listed in
  `preflight.skipped`, and a green light means "nothing we could check would refuse this", never
  "this will settle".
- **STRK20 transactions are slow.** The wallet generates a STARK proof before it can submit and the
  proof is verified on chain afterwards. The default wait is 400 × 3s; a timeout is reported as
  `unconfirmed`, never as a failure, because the transaction may well land later.

## Development

```sh
npm install
npm run build       # tsup: ESM + CJS + .d.ts, and dist/styles.css
npm run typecheck
npm test            # vitest + @testing-library/react
```

MIT.
