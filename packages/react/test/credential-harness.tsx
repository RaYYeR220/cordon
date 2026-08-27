/**
 * A `<PassportCard>` driven by a credential the test supplies.
 *
 * `useCordonCredential` normally owns the credential; here the test hands it one directly, which
 * is the same path a host app takes when the credential arrives from its own backend.
 */

import type { ReactNode } from "react";
import type { Credential, Felt } from "@cordon/sdk";

import { PassportCard, useCordonCredential } from "../src/index.js";

export function CredentialHarness({
  credential,
  requiredClaim,
}: {
  credential: Credential;
  requiredClaim?: Felt;
}): ReactNode {
  const state = useCordonCredential({
    credential,
    ...(requiredClaim !== undefined ? { requiredClaim } : {}),
  });
  return <PassportCard credential={state} />;
}
