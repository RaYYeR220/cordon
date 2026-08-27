/**
 * The whole thing, in one file.
 *
 * Copy this, put your three constants at the top, and you have a gated private payment with the
 * enforcement visible and the refusal named. Nothing below is Cordon-specific plumbing — it is all
 * just the components.
 *
 * The note this payment is allowed to land in is resolved by asking the wallet, so there is
 * nothing to wire up for it. A wallet that cannot answer is reported, never worked around.
 */

import { useState } from "react";
import {
  ConnectWallet,
  CordonProvider,
  GateFeed,
  GatedPaymentButton,
  PassportCard,
  PolicyBadge,
  SpendMeter,
  parseUnits,
  useCordonCredential,
  useCordonWallet,
} from "@cordon/react";
// Plain import is right here because this example has no cascade layers of its own.
// In an app that does — Tailwind v4, for instance — import it into a layer instead,
// or the package's unlayered rules will outrank your theme. See the README's Theming section.
import "@cordon/react/styles.css";

// ---------------------------------------------------------------- configure me

/** Your deployed PolicyGate. Everything else defaults to the mainnet deployment. */
const GATE = "0x0000000000000000000000000000000000000000000000000000000000000000";
/** A policy id published in the PolicyRegistry. */
const POLICY = "ACCREDITED";
/** The pool user being paid. */
const PAYEE = "0x0000000000000000000000000000000000000000000000000000000000000000";

// ---------------------------------------------------------------------- the page

function Pay() {
  const wallet = useCordonWallet();
  const passport = useCordonCredential();
  const [input, setInput] = useState("1");

  let amount: bigint | null = null;
  try {
    amount = parseUnits(input);
  } catch {
    // An unparseable amount is not an error state to shout about — the button stays blocked and
    // says why.
    amount = null;
  }

  return (
    <main style={{ display: "grid", gap: "1rem", maxWidth: "34rem", margin: "3rem auto" }}>
      <h1>Gated private payment</h1>

      <ConnectWallet />

      {/* The pseudonym the credential is about. Derived from a wallet signature, so it is
          reproducible on any device with nothing stored. */}
      {wallet.canPay && !passport.subject ? (
        <button
          type="button"
          className="cordon-button"
          onClick={() => void passport.deriveSubject()}
        >
          Derive my subject key
        </button>
      ) : null}

      <PassportCard credential={passport} allowImport />
      <PolicyBadge policyId={POLICY} />

      <SpendMeter
        policyId={POLICY}
        subjectPublicKey={passport.subject?.publicKey ?? null}
        amount={amount}
      />

      <label className="cordon-note" htmlFor="amount">
        Amount in STRK
      </label>
      <input
        id="amount"
        className="cordon-mono"
        inputMode="decimal"
        value={input}
        onChange={(event) => setInput(event.target.value)}
      />

      <GatedPaymentButton
        policyId={POLICY}
        amount={amount}
        payee={PAYEE}
        credential={passport.credential}
        subjectPrivateKey={passport.subject?.privateKey ?? null}
      >
        Pay {input || "0"} STRK
      </GatedPaymentButton>

      <GateFeed />
    </main>
  );
}

export default function App() {
  return (
    <CordonProvider config={{ gateAddress: GATE }}>
      <Pay />
    </CordonProvider>
  );
}
