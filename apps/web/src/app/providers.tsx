"use client";

import { useMemo, type ReactNode } from "react";
import { CordonProvider } from "@cordon/react";

import { loadConfig } from "@/lib/strk20";
import { RecordSourceProvider } from "@/lib/record/source";

/**
 * Everything the record needs in scope.
 *
 * `<CordonProvider>` owns the wallet connection, the STRK20 capability probe
 * and the session's refusal journal, and it is mounted even when this build has
 * no gate address — with nothing to read it simply reports every read as
 * unavailable, which is the honest state and the one the source strip
 * describes. What it must never do is silently invent a gate.
 */
export function Providers({ children }: { children: ReactNode }) {
  const app = useMemo(() => loadConfig(), []);

  const config = useMemo(
    () => ({
      gateAddress: app.gateAddress ?? "",
      ...(app.registries ? { registries: app.registries } : {}),
      poolAddress: app.poolAddress,
      rpcUrl: app.rpcUrl,
      token: app.token,
      chainId: app.chainId,
    }),
    [app]
  );

  return (
    <CordonProvider config={config}>
      <RecordSourceProvider gateConfigured={Boolean(app.gateAddress)}>{children}</RecordSourceProvider>
    </CordonProvider>
  );
}
