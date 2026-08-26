# @cordon/web

The Cordon web app and the STRK20 wallet layer it is built on.

```bash
cp .env.example .env.local   # optional; the defaults target mainnet
npm install
npm run dev                  # http://localhost:3000
npm run build                # production build, type-checked
npm run lint
```

## Layout

```
src/lib/strk20/   the wallet layer — plain TypeScript, no React, no DOM rendering
src/hooks/        React bindings over that layer
src/components/   presentational pieces
src/app/          routes; /debug is the engineering console
```

`src/lib/strk20/` is the seed of the package Cordon publishes, so it must stay
framework-free. Nothing in it may import React or reach for app state.

| module | what it owns |
| --- | --- |
| `types.ts` | the four action shapes, the capability and error records |
| `spec-compat.ts` | compile-time proof those shapes match the wallet API |
| `config.ts` | chain constants, RPC, pool address, pool fee, explorer links |
| `wallet.ts` | wallet-standard discovery, connect, disconnect |
| `capability.ts` | the read-only STRK20 support probe |
| `balances.ts` | shielded balances (wallet) and public balances (RPC) |
| `actions.ts` | typed builders and the local pre-flight validator |
| `client.ts` | submit, wait for the receipt, read it back |
| `errors.ts` | JSON-RPC codes, Cairo revert reasons, panic-code decoding |

## /debug

Connects a wallet, runs the capability probe, shows public and shielded
balances, and builds each of the four action arrays — rendering the exact JSON
that goes to the wallet before anything is submitted, and the transaction hash
with a Voyager link afterwards.

## Things worth knowing before changing this

- **`starknet` must stay on 10.4 or newer.** The `latest` tag on npm still points
  at 10.0.2, which has none of the STRK20 API, so the dependency is pinned to
  `^10.4.0` on purpose. Do not "fix" it to `latest`.
- **The wallet picker does not use starknetkit's `connect()`.** It builds the
  wallet-standard registry directly with
  `createStore({ eip1193Adapters: [] })`. The default adapter list bridges
  EIP-6963 providers in, which makes MetaMask's Starknet Snap get probed on every
  discovery pass and spams its unlock popup.
- **Use an RPC endpoint that serves one spec version.** The default,
  `https://api.cartridge.gg/x/starknet/mainnet`, serves 0.10.2 consistently.
  `https://rpc.starknet.lava.build` is a load-balanced mixed pool that
  intermittently answers 0.8.1 and breaks 0.10-style calls mid-session.
- **The STRK20 methods are optional.** A wallet can speak the whole Starknet
  wallet API and still not implement them — Braavos answers
  `wallet_strk20Balances` with "Not implemented". The app probes rather than
  assumes, and renders an explanatory state when support is absent.
- **An `invoke`-only action array is rejected** with `INVALID_REQUEST_PAYLOAD`.
  Value has to route through the contract first: `withdraw` → `transfer("OPEN")`
  → `invoke`.
- **`"OPEN"`, `"${poolAddress}"` and `"${openNoteIds[0]}"` are literal strings**
  the wallet substitutes while assembling the transaction. Hex-encoding them
  breaks the substitution.
- **Confirmation is slow.** A STRK20 transaction has a STARK proof generated
  before submission and verified on-chain after it, so the wait budget is 400
  retries at 3s.
- **Every private action costs a flat 6 STRK pool fee**, charged once per
  transaction and paid from an already-shielded balance.
