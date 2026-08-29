# @cordon/web

Cordon's product surface: five screens set as a public record, plus an
engineering console.

```bash
cp .env.example .env.local   # optional; the defaults target mainnet
npm install
npm run dev                  # http://localhost:3000
npm run build                # production build, type-checked
npm run lint
```

## The screens

| route | what it is |
| --- | --- |
| `/` | the cover: the thesis, the cordon line drawn once, one link to the money shot |
| `/pay` | compose a gated payment and watch the gate's pipeline run against it |
| `/passport` | derive the pseudonym, hold the credential, see precisely why it fails the policies it fails |
| `/issuer` | issue, revoke, publish — and what revocation costs |
| `/monitor` | the public record of decisions |
| `/auditor` | verify a scoped disclosure without handing over a viewing key |
| `/debug` | the STRK20 engineering console, in its own skin |

## Two records, never blended

The app renders either the **seeded sample record** or the **chain**, and the
strip under the masthead says which before a reader has looked at a number.

Sample mode is the default, because a judge arrives with no wallet and still has
to be able to read the whole product. What it seeds is data, not verdicts: the
policies and credentials in `src/lib/record/sample.ts` are real `@cordon/sdk`
objects carrying real STARK-curve signatures, and every decision on the page is
computed by the same `preflight()` the live path runs. Sample transaction hashes
are printed and marked rather than linked — a link to a transaction that does not
exist is worse than no link.

Live mode is offered only when `NEXT_PUBLIC_CORDON_GATE_ADDRESS` is set. Without
a gate there is nothing to read, and a switch that leads to a page of
`unavailable` would be a worse answer than saying so.

Nothing is ever filled in on the chain's behalf. A value that could not be read
renders as `unavailable`, a meter with no readable value is striped and is not a
`meter`, and a velocity bar never shows a full allowance it did not read.

That extends to verdicts, which is the easier one to get wrong. With no
credential loaded the pre-flight has nothing to run, so `/pay` says the
enforcement order was **not assessed** and prints no rung as passed. A green
light nobody earned is worse than a refusal.

## The order a live run goes in

The pseudonym comes first and everything follows from it. It is a STARK-curve
key derived in the browser from one wallet signature — never a wallet address,
never generated at random, so the same wallet reproduces it on any device.

1. `/passport` — connect a wallet, **derive the pseudonym**, copy it.
2. `/issuer` — paste it, pick a claim, issue. The console cross-checks the
   service's signing key against the one the `IssuerRegistry` holds before you
   spend anything on a credential the gate would refuse.
3. `/passport` (the subject's own browser) — paste the compact credential back.
   It is 268 characters, which is what lets a credential reach a payee who is
   somebody else on another machine.
4. `/pay` — pick the leg, compose the amount, submit.

The pseudonym is held for the session and is not written to disk: it can be
re-derived from the wallet at any time, so persisting it would add a stealable
secret and buy a click.

## The design system

`src/app/globals.css` holds the whole of it as Tailwind v4 theme tokens: nine
colours, three faces, a `10 / 12 / 14 / 16 / 20 / 28 / 44 / 96 / 216` type scale,
an 11px baseline unit, and two motion speeds. There are no cards, no shadows and
no rounded corners — `border-radius` is `0` everywhere, enforced by an unlayered
rule at the bottom of the file.

Two devices carry the product and no more:

- **The cordon line** (`src/components/record/CordonLine.tsx`). Every limit is
  one hard boundary with 45° hatching over the prohibited region and the amount
  visibly crossing it. Four fixed lanes in the track — cap label, bars, zone
  words, amount endcap — so no two labels can collide at any width. A
  per-transfer cap, an epoch budget, an authorisation deadline and a disclosure
  scope are all the same picture.
- **The signal-word panel** (`src/components/record/SignalPanel.tsx`). Spent on
  refusal and nothing else. It arrives as a hard cut, because a revert is not a
  transition.

Red is reserved for refusal: a named refusal, a count of refusals, the region
past a limit, and the cordon line's cap marker. Nothing else, ever.

## Where the enforcement comes from

Not from this app. `src/lib/record/enforcement.ts` builds the pipeline from
`allRefusals()` in `@cordon/sdk`, grouped by the gate's own step numbers, so the
ladder is the contract's order or it is nothing — and new refusal codes appear
without a change here. `src/lib/record/verdict.ts` asks `preflight()` for the
decision. The count of steps is never written down in copy; it is read from
`STEP_COUNT`.

`src/components/record/RefusalSignal.tsx` renders any refusal the gate can
raise, using the SDK's own title, explanation and remedy. There is no
code-to-copy mapping in this app to fall out of date.

## Consuming `@cordon/react`

The app takes the package's hooks for everything with logic in it —
`useCordonWallet`, `useCordonCredential`, `useCordonPolicy`, `useGatedPayment`,
`useGateFeed` — and its components where their shape suits the page
(`<ConnectWallet>`, `<PassportCard>`). It dresses them entirely through the
`--cordon-*` custom properties in `globals.css`; the package stylesheet is
imported into its own cascade layer so those overrides win.

## Environment

| variable | what it does |
| --- | --- |
| `NEXT_PUBLIC_STARKNET_RPC_URL` | read RPC. Cartridge answers spec 0.10.2 consistently. |
| `NEXT_PUBLIC_STRK20_POOL_ADDRESS` | the STRK20 privacy pool. |
| `NEXT_PUBLIC_CORDON_GATE_ADDRESS` | the `PolicyGate`. Unset means sample mode only. |
| `NEXT_PUBLIC_CORDON_POLICY_ID` | the published policy the `Direct` leg settles under. |
| `NEXT_PUBLIC_CORDON_SETTLE_POLICY_ID` | the policy the `Fund` leg settles under. |
| `NEXT_PUBLIC_CORDON_CLAIM_POLICY_ID` | the policy a payee is judged against when they claim. |
| `NEXT_PUBLIC_CORDON_PAYEE` | the pool user a live demo payment credits. |
| `NEXT_PUBLIC_CORDON_ISSUER_URL` | where the issuer service answers. Unset means the console says so. |

The issuer URL is deliberately absent from the published build. That service
holds an attesting key and belongs on a host its operator controls, not behind
a static page — so the console reports issuance as unavailable rather than
pointing a reader's browser at a service that is not there. Run it locally to
use the console:

```bash
cd ../../services/issuer
cp .env.example .env          # set ISSUER_PRIVATE_KEY, and ISSUER_ALLOWED_ORIGINS=http://localhost:3000
npm run dev                   # http://localhost:8787
```

then set `NEXT_PUBLIC_CORDON_ISSUER_URL=http://localhost:8787` in `.env.local`.

## Layout

```
src/app/(record)/   the five screens and the cover, under the record's chrome
src/app/debug/      the engineering console, with its own dark layout
src/components/record/  the design system: cordon line, signal panel, ladder, tables
src/components/screens/ one component per screen
src/components/shell/   masthead, contents strip, source strip, colophon
src/lib/record/     the sample record, the enforcement ladder, formatting
src/lib/strk20/     app configuration and the demo action builders; the rest of
                    the wallet layer lives in @cordon/react/strk20
```
