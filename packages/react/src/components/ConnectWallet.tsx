"use client";

/**
 * `<ConnectWallet>` — pick a wallet, and be told immediately whether it can do this.
 *
 * Most connect buttons stop at "connected". This one keeps going, because on STRK20 being
 * connected is not the same as being able to pay: the private methods are optional and today only
 * Ready implements them. A wallet that answers `wallet_strk20Balances` with "Not implemented" gets
 * an explanatory state here rather than a payment button that fails later.
 */

import { useEffect, useRef, type ReactNode } from "react";

import { useCordonWallet } from "../hooks/useCordonWallet.js";
import { shortHex, type DiscoveredWallet } from "../strk20/index.js";
import { Badge, Heading, cx } from "./primitives.js";

export interface ConnectWalletProps {
  className?: string;
  /** Heading level for the card title, so it fits the host page's outline. */
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  /** Card title. Pass null to render no heading at all. */
  title?: ReactNode | null;
  /** Rendered when no wallet has announced itself. Overrides the default explanation. */
  noWalletMessage?: ReactNode;
  /**
   * Move focus to the connected account once a connection lands.
   *
   * On by default: the user pressed a button, the button vanished, and focus would otherwise fall
   * back to the document body with nothing announced.
   */
  focusOnConnect?: boolean;
  onConnected?: (address: string) => void;
}

const VERDICT = {
  ready: "pass",
  unsupported: "refuse",
  error: "refuse",
  probing: "warn",
  connecting: "warn",
  disconnected: "unknown",
  "no-wallet": "unknown",
} as const;

const LABEL = {
  ready: "STRK20 ready",
  unsupported: "no STRK20 support",
  error: "connection failed",
  probing: "checking support",
  connecting: "connecting",
  disconnected: "not connected",
  "no-wallet": "no wallet found",
} as const;

export function ConnectWallet({
  className,
  headingLevel = 3,
  title = "Wallet",
  noWalletMessage,
  focusOnConnect = true,
  onConnected,
}: ConnectWalletProps): ReactNode {
  const wallet = useCordonWallet();
  const accountRef = useRef<HTMLDivElement>(null);
  const wasConnected = useRef(false);

  useEffect(() => {
    const connected = wallet.connection !== null;
    if (connected && !wasConnected.current) {
      if (focusOnConnect) accountRef.current?.focus();
      if (wallet.address) onConnected?.(wallet.address);
    }
    wasConnected.current = connected;
  }, [wallet.connection, wallet.address, focusOnConnect, onConnected]);

  const status = wallet.status;

  return (
    <section className={cx("cordon", "cordon-card", className)} aria-label="Wallet connection">
      <div className="cordon-card__header">
        {title !== null ? <Heading level={headingLevel}>{title}</Heading> : null}
        <Badge verdict={VERDICT[status]} srLabel="Wallet status">
          {LABEL[status]}
        </Badge>
      </div>

      {/* One live region for the whole card. Connecting, probing and refusing all announce here. */}
      <p className="cordon-note" role="status" aria-live="polite">
        {wallet.explanation ??
          (wallet.connection
            ? `${wallet.connection.name} connected on ${wallet.network ?? "an unknown chain"}.`
            : "Choose a wallet to connect.")}
      </p>

      {wallet.connection ? (
        <div className="cordon-account" ref={accountRef} tabIndex={-1}>
          <span className="cordon-mono">{shortHex(wallet.connection.address, 8, 6)}</span>
          <button
            type="button"
            className="cordon-button cordon-button--secondary"
            onClick={() => void wallet.disconnect()}
          >
            Disconnect
          </button>
        </div>
      ) : wallet.wallets.length === 0 ? (
        // The live region above already carries the explanation, so this says what to do about it
        // rather than repeating it.
        <p className="cordon-empty">
          {noWalletMessage ?? "Install a wallet that implements them, then reload this page."}
        </p>
      ) : (
        <ul className="cordon-wallets">
          {wallet.wallets.map((entry: DiscoveredWallet) => (
            <li key={entry.name}>
              <button
                type="button"
                className="cordon-wallet-button"
                disabled={wallet.status === "connecting"}
                onClick={() => void wallet.connect(entry)}
              >
                {entry.icon ? (
                  <img className="cordon-wallet-button__icon" src={entry.icon} alt="" />
                ) : null}
                <span>{entry.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {wallet.capability && wallet.capability.status !== "supported" ? (
        <p className="cordon-note">{wallet.capability.reason}</p>
      ) : null}
    </section>
  );
}
