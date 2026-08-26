"use client";

import { useCallback, useMemo, useState } from "react";

import { ActionCard, type SubmitFn } from "@/components/ActionCard";
import { Button, Code, ErrorDetail, Json, Panel, Pill, Row, Unavailable } from "@/components/ui";
import { useStrk20 } from "@/hooks/useStrk20";
import {
  balanceOf,
  buildAnonymizerRoundTrip,
  buildPrivateTransfer,
  buildShield,
  buildUnshield,
  canSubmitPrivateActions,
  chainName,
  formatUnits,
  parseUnits,
  POOL_FEE_STRK,
  shortHex,
  submitActions,
  voyagerContractUrl,
  type Strk20Capability,
} from "@/lib/strk20";

const CAPABILITY_TONE: Record<Strk20Capability["status"], "ok" | "warn" | "bad" | "idle"> = {
  supported: "ok",
  "not-implemented": "bad",
  declined: "warn",
  "wrong-chain": "warn",
  error: "bad",
};

export default function DebugPage() {
  const strk20 = useStrk20();
  const {
    config,
    provider,
    wallets,
    connection,
    connecting,
    connectError,
    capability,
    probing,
    shielded,
    publicBalance,
    refreshing,
  } = strk20;

  const [shieldAmount, setShieldAmount] = useState("10");
  const [transferAmount, setTransferAmount] = useState("1");
  const [transferRecipient, setTransferRecipient] = useState("");
  const [unshieldAmount, setUnshieldAmount] = useState("1");
  const [unshieldRecipient, setUnshieldRecipient] = useState("");
  const [gateAmount, setGateAmount] = useState("5");

  const submittable = canSubmitPrivateActions(capability);
  const network = chainName(connection?.chainId ?? null);

  const submit: SubmitFn | null = useMemo(() => {
    if (!connection || !submittable) return null;
    return async (actions, onSubmitted) => {
      const outcome = await submitActions(connection.account, provider, actions, { onSubmitted });
      if (!outcome.ok) return { ok: false as const, error: outcome.error };
      return { ok: true as const, result: outcome.result };
    };
  }, [connection, provider, submittable]);

  const blocked = useCallback((): string | null => {
    if (!connection) return "Connect a wallet to submit.";
    if (!capability) return "Waiting for the capability probe.";
    if (capability.status !== "supported") return `Blocked: ${capability.status}.`;
    return null;
  }, [capability, connection]);

  const shieldedStrk = shielded?.available ? balanceOf(shielded.value, config.token) : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">STRK20 debug console</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Connect a wallet, probe it for the STRK20 methods, and build (then submit) each action
          array against the live mainnet pool. Every value below is read from the wallet or the
          node; anything that cannot be read renders as{" "}
          <span className="text-amber-400">unavailable</span>.
        </p>
      </div>

      <Panel title="Environment" subtitle="Resolved at build time from NEXT_PUBLIC_* variables.">
        <Row label="RPC">{config.rpcUrl}</Row>
        <Row label="pool">
          <a
            className="underline hover:text-neutral-200"
            href={voyagerContractUrl(config.poolAddress)}
            target="_blank"
            rel="noreferrer"
          >
            {config.poolAddress} ↗
          </a>
        </Row>
        <Row label="token (STRK)">{config.token}</Row>
        <Row label="Cordon gate">
          {config.gateAddress ? (
            <a
              className="underline hover:text-neutral-200"
              href={voyagerContractUrl(config.gateAddress)}
              target="_blank"
              rel="noreferrer"
            >
              {config.gateAddress} ↗
            </a>
          ) : (
            <Unavailable why="NEXT_PUBLIC_CORDON_GATE_ADDRESS is not set — the anonymizer is not deployed yet." />
          )}
        </Row>
        <Row label="pool fee">{POOL_FEE_STRK.toString()} STRK per transaction</Row>
      </Panel>

      <Panel
        title="Wallet"
        subtitle={
          <>
            Discovery uses <Code>createStore({"{ eip1193Adapters: [] }"})</Code> so MetaMask&apos;s
            Snap is never probed.
          </>
        }
      >
        {connection ? (
          <>
            <Row label="wallet">{connection.name}</Row>
            <Row label="address">{connection.address}</Row>
            <Row label="chain">
              {connection.chainId} {network ? `(${network})` : "(no privacy pool here)"}
            </Row>
            <Row label="accounts permission">
              {connection.hasAccountsPermission ? <Pill tone="ok">granted</Pill> : <Pill tone="warn">not reported</Pill>}
            </Row>
            <Row label="supported specs">
              {connection.specVersions.length ? connection.specVersions.join(", ") : <Unavailable why="wallet_supportedSpecs did not answer" />}
            </Row>
            <Row label="wallet API">
              {connection.walletApiVersions.length ? connection.walletApiVersions.join(", ") : <Unavailable why="wallet_supportedWalletApi did not answer" />}
            </Row>
            <div className="flex gap-2 pt-1">
              <Button onClick={() => void strk20.refresh()} disabled={refreshing}>
                {refreshing ? "Refreshing…" : "Re-probe and refresh balances"}
              </Button>
              <Button onClick={() => void strk20.disconnect()}>Disconnect</Button>
            </div>
          </>
        ) : (
          <>
            {wallets.length === 0 ? (
              <p className="text-neutral-400">
                No Starknet wallet detected. Install{" "}
                <a className="underline" href="https://www.ready.co/" target="_blank" rel="noreferrer">
                  Ready
                </a>
                , which is the only wallet shipping the STRK20 methods today.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {wallets.map((wallet) => (
                  <button
                    key={wallet.name}
                    type="button"
                    disabled={connecting}
                    onClick={() => void strk20.connect(wallet)}
                    className="flex items-center gap-2 rounded border border-neutral-700 px-3 py-2 text-xs hover:bg-neutral-800 disabled:opacity-40"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={wallet.icon} alt="" className="h-4 w-4" />
                    {wallet.name}
                  </button>
                ))}
              </div>
            )}
            {connectError ? <ErrorDetail error={connectError} /> : null}
          </>
        )}
      </Panel>

      <Panel
        title="Capability probe"
        subtitle={
          <>
            The STRK20 methods are optional. The probe calls the read-only{" "}
            <Code>wallet_strk20Balances</Code> — it signs nothing and costs nothing — and reports
            what the wallet answered.
          </>
        }
      >
        {probing ? (
          <p className="text-neutral-400">Probing…</p>
        ) : capability ? (
          <>
            <Row label="verdict">
              <Pill tone={CAPABILITY_TONE[capability.status]}>{capability.status}</Pill>
            </Row>
            <p className="text-neutral-300">{capability.reason}</p>
            <Row label="probe">
              {capability.probe.method}{" "}
              {capability.probe.performed ? `· ${capability.probe.durationMs} ms` : "· skipped"}
            </Row>
            {capability.status === "not-implemented" ? (
              <p className="rounded border border-amber-900/60 bg-amber-950/30 p-2 text-xs text-amber-200">
                This wallet speaks the Starknet wallet API but has not implemented the STRK20
                methods. Reads and private actions on this page will stay disabled until you
                connect one that has. Nothing below is simulated to fill the gap.
              </p>
            ) : null}
            {capability.error ? <ErrorDetail error={capability.error} /> : null}
          </>
        ) : (
          <p className="text-neutral-400">Connect a wallet to run the probe.</p>
        )}
      </Panel>

      <Panel title="Balances">
        <Row label="public STRK">
          {publicBalance === null ? (
            <span className="text-neutral-500">not read</span>
          ) : publicBalance.available ? (
            `${formatUnits(publicBalance.value)} STRK`
          ) : (
            <Unavailable why={publicBalance.error.message} />
          )}
        </Row>
        <Row label="shielded STRK">
          {shielded === null ? (
            <span className="text-neutral-500">not read</span>
          ) : shielded.available ? (
            `${formatUnits(shieldedStrk ?? 0n)} STRK`
          ) : (
            <Unavailable why={shielded.error.message} />
          )}
        </Row>
        {shielded && !shielded.available ? <ErrorDetail error={shielded.error} /> : null}
        {shielded?.available ? (
          shielded.value.length ? (
            <Json
              value={shielded.value.map((entry) => ({
                token: shortHex(entry.token, 10, 6),
                amount: entry.amount,
              }))}
            />
          ) : (
            <p className="text-xs text-neutral-400">
              The wallet answered with an empty list: this account holds nothing in the pool.
            </p>
          )
        ) : null}
      </Panel>

      <div className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">Actions</h2>

        <ActionCard
          title="Shield"
          description="deposit — move public STRK into the pool. Always credited to self."
          chainId={connection?.chainId ?? config.chainId}
          fields={[
            { name: "amount", label: "Amount (STRK)", value: shieldAmount, onChange: setShieldAmount },
          ]}
          build={() => buildShield({ token: config.token, amount: parseUnits(shieldAmount) })}
          submit={submit}
          blocked={blocked()}
        />

        <ActionCard
          title="Private transfer"
          description="transfer — shielded balance to another pool user, note to note. Amounts and parties stay private."
          chainId={connection?.chainId ?? config.chainId}
          fields={[
            {
              name: "amount",
              label: "Amount (STRK)",
              value: transferAmount,
              onChange: setTransferAmount,
            },
            {
              name: "recipient",
              label: "Recipient",
              value: transferRecipient,
              placeholder: connection?.address ?? "0x…",
              onChange: setTransferRecipient,
            },
          ]}
          build={() =>
            buildPrivateTransfer({
              token: config.token,
              amount: parseUnits(transferAmount),
              recipient: transferRecipient.trim() || requireAddress(connection?.address),
            })
          }
          submit={submit}
          blocked={blocked()}
        />

        <ActionCard
          title="Unshield"
          description="withdraw — move shielded STRK back out to a public address. The destination and amount are public."
          chainId={connection?.chainId ?? config.chainId}
          fields={[
            {
              name: "amount",
              label: "Amount (STRK)",
              value: unshieldAmount,
              onChange: setUnshieldAmount,
            },
            {
              name: "recipient",
              label: "Recipient",
              value: unshieldRecipient,
              placeholder: connection?.address ?? "0x…",
              onChange: setUnshieldRecipient,
            },
          ]}
          build={() =>
            buildUnshield({
              token: config.token,
              amount: parseUnits(unshieldAmount),
              recipient: unshieldRecipient.trim() || requireAddress(connection?.address),
            })
          }
          submit={submit}
          blocked={blocked()}
        />

        <ActionCard
          title="Gate round-trip"
          description={
            'withdraw → transfer("OPEN") → invoke. Value routes through the Cordon anonymizer and ' +
            "comes back as an open note. An invoke-only array is rejected with INVALID_REQUEST_PAYLOAD, " +
            "which is why this is three actions."
          }
          chainId={connection?.chainId ?? config.chainId}
          fields={[
            { name: "amount", label: "Amount (STRK)", value: gateAmount, onChange: setGateAmount },
          ]}
          build={() =>
            buildAnonymizerRoundTrip({
              token: config.token,
              amount: parseUnits(gateAmount),
              anonymizer: requireGate(config.gateAddress),
              noteRecipient: requireAddress(connection?.address),
            })
          }
          submit={submit}
          blocked={config.gateAddress ? blocked() : "Set NEXT_PUBLIC_CORDON_GATE_ADDRESS first."}
        />
      </div>
    </div>
  );
}

function requireAddress(address: string | undefined): string {
  if (!address) throw new Error("Connect a wallet, or type a recipient address.");
  return address;
}

function requireGate(gate: string | null): string {
  if (!gate) {
    throw new Error(
      "The Cordon gate is not deployed yet. Set NEXT_PUBLIC_CORDON_GATE_ADDRESS once it is."
    );
  }
  return gate;
}
