import Link from "next/link";

import { DEFAULT_POOL_ADDRESS, POOL_FEE_STRK, voyagerContractUrl } from "@/lib/strk20";

export default function HomePage() {
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">Cordon</h1>
        <p className="max-w-2xl text-neutral-300">
          A credential and policy layer for shielded STRK20 value. Value routes through a Cairo
          anonymizer, so a payer who fails the policy cannot move pool funds at all — the
          transaction reverts.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
          Status
        </h2>
        <p className="max-w-2xl text-neutral-300">
          This is the engineering shell. The wallet layer and a debug console are in place; the
          product surfaces are not built yet.
        </p>
        <Link
          href="/debug"
          className="inline-block rounded border border-neutral-700 px-4 py-2 text-sm hover:bg-neutral-900"
        >
          Open the debug console
        </Link>
      </section>

      <section className="space-y-2 text-sm text-neutral-400">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
          What is true today
        </h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Private actions go through the wallet API. Only a wallet that implements the STRK20
            methods can perform them; the app probes for that rather than assuming it.
          </li>
          <li>
            Each private transaction costs a flat {POOL_FEE_STRK.toString()} STRK pool fee, paid
            from an already-shielded balance.
          </li>
          <li>
            Amounts are public at the anonymizer. Cordon enforces caps and velocity on plaintext
            amounts; it does not evaluate rules over encrypted amounts.
          </li>
          <li>
            Pool:{" "}
            <a
              className="underline hover:text-neutral-200"
              href={voyagerContractUrl(DEFAULT_POOL_ADDRESS)}
              target="_blank"
              rel="noreferrer"
            >
              {DEFAULT_POOL_ADDRESS}
            </a>
          </li>
        </ul>
      </section>
    </div>
  );
}
