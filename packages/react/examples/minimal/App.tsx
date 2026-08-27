/**
 * The whole thing, in one file.
 *
 * Copy this, put your gate address and policy id at the top, and you have a gated private payment
 * with the enforcement visible and the refusal named. Nothing below is Cordon-specific plumbing —
 * it is all just the components.
 *
 * The one piece you have to supply yourself is `resolveNoteId`. The subject's signature covers the
 * *resolved* open-note id, and only the wallet knows it while it assembles the transaction. Until
 * you wire it up this page stays honestly blocked rather than signing something the gate would
 * refuse with CORDON_BAD_SUBJECT_SIG.
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
import "@cordon/react/styles.css";

// ---------------------------------------------------------------- configure me

/** Your deployed PolicyGate. Everything else defaults to the mainnet deployment. */
const GATE = "0x0000000000000000000000000000000000000000000000000000000000000000";
/** A policy id published in the PolicyRegistry. */
const POLICY = "ACCREDITED";
/** The pool user being paid. */
const PAYEE = "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * The resolved `${openNoteIds[0]}` for this transaction.
 *
 * `null` leaves the payment button blocked with the reason spelled out — which is the correct
 * behaviour until you wire this up, not a bug. `noteId` also accepts a function returning a
 * promise, for an app that resolves the id per transaction:
 *
 * ```tsx
 * <GatedPaymentButton noteId={async () => myNoteIdFor(payment)} … />
 * ```
 */
const NOTE_ID: string | null = null;

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
        noteId={NOTE_ID}
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
