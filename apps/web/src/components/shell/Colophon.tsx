"use client";

import { useCordonContext } from "@cordon/react";

import { ContractRef } from "@/components/record/TxRef";
import { Rule, SectionHead, Unavailable } from "@/components/record/primitives";
import { formatUnits } from "@/lib/record/format";
import { HONEST_LIMITS, POOL_FEE, SAMPLE_CONTRACTS } from "@/lib/record/sample";
import { useRecordSource } from "@/lib/record/source";

type Ref = { name: string; address: string | null; live: boolean };

/**
 * The colophon.
 *
 * Where the record says what it is made of and — the part that matters — what
 * it does not claim. A product that measures its own anonymity set at 1.00 and
 * prints the number is making a different kind of promise than one that does
 * not mention it.
 *
 * The addresses follow the record on the page. In live mode they are the gate
 * this build is configured against and the three registries read off it; in
 * sample mode they are the sample ones, printed and marked rather than linked.
 */
export function Colophon() {
  const source = useRecordSource();
  const { config, registries } = useCordonContext();

  const read = (key: "policyRegistry" | "issuerRegistry" | "revocationRegistry") =>
    registries && registries.available ? registries.value[key] : null;

  const refs: Ref[] = source.live
    ? [
        { name: "PolicyGate", address: config.gateAddress || null, live: true },
        { name: "PolicyRegistry", address: read("policyRegistry"), live: true },
        { name: "IssuerRegistry", address: read("issuerRegistry"), live: true },
        { name: "RevocationRegistry", address: read("revocationRegistry"), live: true },
        { name: "Privacy pool · STRK20", address: config.poolAddress, live: true },
        { name: "STRK token", address: config.token, live: true },
      ]
    : SAMPLE_CONTRACTS.map((contract) => ({ ...contract }));

  return (
    <footer className="pt-pad pb-run">
      <SectionHead title="Colophon" right="Cordon · Cairo 2.18.0 · Starknet mainnet · SN_MAIN" />
      <Rule />
      <div className="grid4 pt-bl text-agate leading-[15px] text-ink-3">
        <div className="space-y-bl">
          <p className="max-w-[52ch]">
            <strong className="text-ink">Honest limits.</strong> {HONEST_LIMITS}
          </p>
          <p className="max-w-[52ch]">
            <strong className="text-ink">Pool fee.</strong> {formatUnits(POOL_FEE)} STRK per
            apply_actions, charged once per transaction and paid from the shielded balance —
            whatever the gate decides.
          </p>
          <p className="max-w-[52ch]">
            <strong className="text-ink">References.</strong> A deployed address links to Voyager. A
            sample one is printed and marked, because a link to something that does not exist is
            worse than no link.
          </p>
        </div>

        {[0, 2, 4].map((start) => (
          <div key={start} className="space-y-tick">
            {refs.slice(start, start + 2).map((ref) => (
              <p key={ref.name}>
                <strong className="text-ink">{ref.name}</strong>
                <br />
                {ref.address === null ? (
                  <Unavailable reason="not read from the gate" />
                ) : (
                  <ContractRef address={ref.address} live={ref.live} />
                )}
              </p>
            ))}
          </div>
        ))}
      </div>
    </footer>
  );
}
