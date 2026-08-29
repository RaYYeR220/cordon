"use client";

/**
 * 03 · ISSUER CONSOLE, live.
 *
 * The console does not sign. It carries a pseudonym to the issuer service and carries a credential
 * back, and every value on it is read from that service or from the chain — the registered key,
 * the sanctions snapshot's provenance, the published policies. Anything that cannot be read says
 * `unavailable`.
 *
 * Two facts shape the layout. The subject key is derived in a browser from a wallet signature, so
 * the console cannot invent one and offers to paste the pseudonym the Passport screen already
 * derived. And an issued credential has to reach a *different* browser when the subject is
 * somebody else, so the compact form is the loudest thing on the page after the credential itself.
 */

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useCordonContext, useCordonCredential } from "@cordon/react";
import {
  credentialFromJson,
  feltToShortString,
  policyFromCalldata,
  shortStringToFelt,
  type Policy,
} from "@cordon/sdk";

import { Folio } from "@/components/record/Folio";
import { ProhibitedMark } from "@/components/record/Pictograms";
import { ContractRef } from "@/components/record/TxRef";
import { Agate, Row, Rows, Rule, SectionHead } from "@/components/record/primitives";
import { formatCount, formatInstant, formatUnits, shorten } from "@/lib/record/format";
import {
  fetchIssuerHealth,
  fetchIssuerIdentity,
  issueCredentialRequest,
  type IssuedCredential,
  type IssuerFailure,
  type IssuerHealth,
  type IssuerIdentity,
} from "@/lib/record/issuer-client";
import {
  LIVE_CLAIM_POLICY_ID,
  LIVE_ISSUER_URL,
  LIVE_POLICY_ID,
  LIVE_SETTLE_POLICY_ID,
} from "@/lib/record/live";

/** The published policies this build settles under, in the order the run uses them. */
const CONFIGURED_POLICIES = [LIVE_POLICY_ID, LIVE_SETTLE_POLICY_ID, LIVE_CLAIM_POLICY_ID].filter(
  (id): id is string => Boolean(id),
);

export function LiveIssuerConsole() {
  const ids = useId();
  const { provider, registries, config } = useCordonContext();
  const credential = useCordonCredential();

  const [identity, setIdentity] = useState<IssuerIdentity | null>(null);
  const [health, setHealth] = useState<IssuerHealth | null>(null);
  const [serviceError, setServiceError] = useState<IssuerFailure | null>(null);

  const [subject, setSubject] = useState("");
  // The chosen claim, once a human has chosen one. Until then the service's own first entry
  // stands in — derived rather than written into state, so a deployment that attests nothing but
  // NOT_SANCTIONED can never have this page offering ACCREDITED.
  const [chosenClaim, setChosenClaim] = useState<string | null>(null);
  const [basis, setBasis] = useState("");
  const [address, setAddress] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [working, setWorking] = useState(false);
  const [issued, setIssued] = useState<IssuedCredential | null>(null);
  const [failure, setFailure] = useState<IssuerFailure | null>(null);
  const [copied, setCopied] = useState(false);

  // The service's identity and health, read once. Both are cheap and both are preconditions: a
  // console that cannot say which key it is issuing under is not showing anything worth trusting.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([fetchIssuerIdentity(LIVE_ISSUER_URL), fetchIssuerHealth(LIVE_ISSUER_URL)]).then(
      ([who, how]) => {
        if (cancelled) return;
        if (who.ok) setIdentity(who.value);
        else setServiceError(who.error);
        if (how.ok) setHealth(how.value);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const claim = chosenClaim ?? identity?.claims[0]?.claim ?? "";

  const spec = useMemo(
    () => identity?.claims.find((entry) => entry.claim === claim) ?? null,
    [identity, claim],
  );

  const registryKey = useOnChainIssuerKey(identity?.issuerId ?? null);
  const policies = useOnChainPolicies();

  /**
   * Whether the key this service signs with is the key the chain will verify against.
   *
   * The single most expensive mistake available here: a credential signed by an unregistered key
   * verifies locally, encodes fine, travels fine, and is refused as `CORDON_BAD_CRED` inside a
   * transaction the payer has already paid for. It costs one contract read to know beforehand.
   */
  const keyMatches =
    identity && registryKey.value !== null
      ? BigInt(registryKey.value) === BigInt(identity.publicKey)
      : null;

  const submit = useCallback(async (): Promise<void> => {
    setWorking(true);
    setFailure(null);
    setIssued(null);
    setCopied(false);
    try {
      const result = await issueCredentialRequest(LIVE_ISSUER_URL, {
        subjectPublicKey: subject.trim(),
        claim,
        ...(address.trim() ? { address: address.trim() } : {}),
        ...(basis.trim() ? { basis: basis.trim() } : {}),
        ...(adminToken.trim() ? { adminToken: adminToken.trim() } : {}),
      });
      if (result.ok) setIssued(result.value);
      else setFailure(result.error);
    } finally {
      setWorking(false);
    }
  }, [subject, claim, address, basis, adminToken]);

  const ready =
    Boolean(LIVE_ISSUER_URL) &&
    /^0x[0-9a-fA-F]{1,64}$/.test(subject.trim()) &&
    claim !== "" &&
    (spec?.evidence !== "operator-attestation" || basis.trim() !== "") &&
    (spec?.evidence !== "ofac-screen" || /^0x[0-9a-fA-F]{1,64}$/.test(address.trim()));

  return (
    <article>
      <Folio
        number="03"
        running="Cordon · 03 · Issuer console"
        title="Issue, revoke, publish"
        facts={[
          { label: "Issuer service", value: LIVE_ISSUER_URL },
          {
            label: "Issuer id",
            value: identity ? `${identity.issuerName ?? identity.issuerId}` : null,
          },
          { label: "Operator", value: identity?.operator ? shorten(identity.operator) : null },
        ]}
      />

      {!LIVE_ISSUER_URL ? (
        <section className="border-y border-ink py-tick">
          <p className="font-display text-agate uppercase tracking-[var(--tracking-mega)]">
            No issuer service on this build
          </p>
          <p className="lede pt-tick max-w-[74ch]">
            The issuer holds a signing key, so it is not part of this static page and there is
            nothing here to reach. Everything below that would come from it says{" "}
            <i>unavailable</i>. Run <span className="font-mono">services/issuer</span> and set{" "}
            <span className="font-mono">NEXT_PUBLIC_CORDON_ISSUER_URL</span> to issue from this
            console. The published policies and the registered issuer are read from the chain and
            are shown regardless.
          </p>
        </section>
      ) : serviceError ? (
        <section className="border-y border-ink py-tick" role="status">
          <p className="font-display text-agate uppercase tracking-[var(--tracking-mega)]">
            The issuer service did not answer
          </p>
          <p className="lede pt-tick max-w-[74ch]">{serviceError.message}</p>
        </section>
      ) : null}

      {/* ── who is signing, and whether the chain agrees ────────────────── */}
      <section className="grid4 items-start pt-bl">
        <div className="span2">
          <SectionHead
            title="The key that will sign"
            right={
              <>
                IssuerRegistry{" "}
                {registries?.available ? (
                  <ContractRef address={registries.value.issuerRegistry} live />
                ) : (
                  "unavailable"
                )}
              </>
            }
            level={3}
          />
          <Rows>
            <Row label="Issuer id" value={identity?.issuerId ?? null} />
            <Row
              label="Service signing key"
              value={identity ? shorten(identity.publicKey, 12, 8) : null}
            />
            <Row
              label="Key registered on chain"
              value={registryKey.value === null ? null : shorten(registryKey.value, 12, 8)}
            />
            <Row
              label="The two agree"
              value={
                keyMatches === null
                  ? null
                  : keyMatches
                    ? "yes — a credential this service signs will verify at the gate"
                    : "NO — every credential signed here would be refused as CORDON_BAD_CRED"
              }
              tone={keyMatches === null ? undefined : keyMatches ? "pass" : "refuse"}
              strong
            />
            <Row
              label="Issuer active"
              value={registryKey.active === null ? null : registryKey.active ? "yes" : "no"}
              tone={registryKey.active ? "pass" : "refuse"}
            />
            <Row label="Operator" value={identity?.operator || null} />
          </Rows>
          <p className="note pt-tick">
            The operator is the only address that can revoke this issuer&rsquo;s credentials — not
            even the registry owner can — and revocation is a transaction from that account, not
            something this console can perform. What it can do is record the issuer&rsquo;s
            decision; the registry write is separate and is what the gate reads.
          </p>
        </div>

        <div className="span2">
          <SectionHead
            title="Screening feed"
            meta={health?.ofac.available ? "fresh" : "not usable"}
            right={
              health?.ofac.fetchedAt ? `fetched ${health.ofac.fetchedAt.slice(0, 19)}Z` : "unavailable"
            }
            level={3}
          />
          <Rows>
            <Row
              label="Snapshot usable"
              value={health === null ? null : health.ofac.available ? "yes" : "no — nothing will be signed against it"}
              tone={health?.ofac.available ? "pass" : "refuse"}
            />
            <Row
              label="Listed addresses"
              value={health?.ofac.addressCount == null ? null : formatCount(health.ofac.addressCount)}
            />
            <Row
              label="Assets covered"
              value={health?.ofac.assets.length ? health.ofac.assets.join(" ") : null}
            />
            <Row
              label="Sources"
              value={
                health?.ofac.sources.length
                  ? health.ofac.sources
                      .map((source) => `${new URL(source.url).pathname.split("/").pop()} ${source.publishDate ?? ""}`)
                      .join(" · ")
                  : null
              }
            />
            <Row
              label="Issued to date"
              value={health === null ? null : formatCount(health.issuedCount)}
            />
            <Row
              label="Refusals recorded"
              value={health === null ? null : formatCount(health.refusalCount)}
            />
          </Rows>
          <p className="note pt-tick">
            STRK is not among the assets OFAC files addresses under today, so no Starknet address
            can match. Every applicant is screened against the whole set regardless, in padded,
            unpadded and prefixless forms, so the day one is added it is caught with no code change.
          </p>
        </div>
      </section>

      {/* ── issue ──────────────────────────────────────────────────────── */}
      <section className="grid4 items-start pt-gut">
        <div className="span2">
          <SectionHead
            title="Issue a credential"
            meta={spec ? spec.evidence.replace("-", " ") : undefined}
            right={identity ? <>Signed with {shorten(identity.publicKey)}</> : "unavailable"}
            level={3}
          />
          <div className="form">
            <div className="field">
              <label htmlFor={`${ids}-sub`}>Subject pseudonym</label>
              <input
                id={`${ids}-sub`}
                type="text"
                value={subject}
                spellCheck={false}
                placeholder="0x… — the key the subject derived from their wallet"
                onChange={(event) => setSubject(event.target.value)}
              />
            </div>
            {credential.subject ? (
              <div className="flex flex-wrap items-baseline gap-tick pb-tick">
                <button
                  type="button"
                  className="btn"
                  onClick={() => setSubject(credential.subject?.publicKey ?? "")}
                >
                  Use this session&rsquo;s pseudonym
                </button>
                <span className="note">{shorten(credential.subject.publicKey, 12, 8)}</span>
              </div>
            ) : (
              <p className="note pb-tick">
                No pseudonym in this session. Derive one on the Passport screen, or paste the
                subject&rsquo;s key — it is a public value and carries no secret.
              </p>
            )}

            <div className="field">
              <label htmlFor={`${ids}-claim`}>Claim</label>
              <select
                id={`${ids}-claim`}
                value={claim}
                onChange={(event) => setChosenClaim(event.target.value)}
                disabled={!identity}
              >
                {identity ? (
                  identity.claims.map((entry) => (
                    <option key={entry.claim} value={entry.claim}>
                      {entry.claim}
                    </option>
                  ))
                ) : (
                  <option value="">unavailable</option>
                )}
              </select>
            </div>
            {spec ? <p className="note pb-tick">{spec.description}</p> : null}

            {spec?.evidence === "ofac-screen" ? (
              <div className="field">
                <label htmlFor={`${ids}-addr`}>Address to screen</label>
                <input
                  id={`${ids}-addr`}
                  type="text"
                  value={address}
                  spellCheck={false}
                  placeholder="0x… — screened, recorded, and never written into the credential"
                  onChange={(event) => setAddress(event.target.value)}
                />
              </div>
            ) : null}

            {spec?.evidence === "operator-attestation" ? (
              <>
                <div className="field">
                  <label htmlFor={`${ids}-basis`}>Basis</label>
                  <input
                    id={`${ids}-basis`}
                    type="text"
                    value={basis}
                    spellCheck={false}
                    placeholder="What you are relying on. Recorded verbatim."
                    onChange={(event) => setBasis(event.target.value)}
                  />
                </div>
                {spec.requiresAdmin ? (
                  <div className="field">
                    <label htmlFor={`${ids}-token`}>Admin token</label>
                    <input
                      id={`${ids}-token`}
                      type="password"
                      value={adminToken}
                      autoComplete="off"
                      placeholder="Blank when the service runs without one"
                      onChange={(event) => setAdminToken(event.target.value)}
                    />
                  </div>
                ) : null}
              </>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-bl pt-bl">
            <button
              type="button"
              className="btn btn--heavy"
              disabled={!ready || working}
              onClick={() => void submit()}
            >
              {working ? "Working" : "Sign and issue"}
            </button>
            <p className="note" role="status">
              {working
                ? "The service is screening, or signing."
                : "Issuance happens in the service, not in this browser — the signing key does not belong in a page. What the chain ever sees is the hash, verified against this issuer's registered key at the moment of settlement."}
            </p>
          </div>

          {failure ? (
            <div className="border-y border-red mt-bl py-tick" role="alert">
              <p className="font-display text-agate uppercase tracking-[var(--tracking-mega)] text-red">
                {failure.kind === "refused"
                  ? "Refused"
                  : failure.kind === "unavailable"
                    ? "Nothing was concluded"
                    : failure.kind === "unauthorized"
                      ? "Not authorised"
                      : failure.kind === "unreachable"
                        ? "The service did not answer"
                        : "Not issued"}
              </p>
              <p className="lede pt-tick">{failure.message}</p>
              {failure.kind === "unavailable" ? (
                <p className="note pt-tick">
                  A 503 is the absence of a decision, not a decision. Retry rather than concluding
                  anything from it.
                </p>
              ) : null}
            </div>
          ) : null}

          {issued ? <IssuedPanel issued={issued} copied={copied} onCopied={setCopied} /> : null}
        </div>

        {/* ── revoke ───────────────────────────────────────────────────── */}
        <div className="span2">
          <SectionHead
            title="Revoke a credential"
            meta="Irreversible"
            right={
              <>
                RevocationRegistry{" "}
                {registries?.available ? (
                  <ContractRef address={registries.value.revocationRegistry} live />
                ) : (
                  "unavailable"
                )}
              </>
            }
            level={3}
          />
          <Rule weight="heavy" />
          <div className="order mt-bl">
            <div className="flex items-start gap-bl pb-bl">
              <span className="shrink-0">
                <ProhibitedMark size={64} />
              </span>
              <p className="lede">
                Revocation is a public, permanent write, and it is not this console&rsquo;s to make.
                It is an invoke on the <span className="font-mono">RevocationRegistry</span> from
                the address registered as this issuer&rsquo;s operator — a wallet, not a service —
                and no browser page holds that account.
              </p>
            </div>
            <Rows>
              <Row label="Contract" value={registries?.available ? registries.value.revocationRegistry : null} />
              <Row label="Entrypoint" value="revoke(issuer_id, credential_id)" />
              <Row label="Caller must be" value={identity?.operator || null} />
              <Row
                label="Effect"
                value="From the next block every gate reads the credential as dead — mid-flight transactions included."
              />
            </Rows>
            <p className="note pt-tick">
              From that block on, every settlement the bearer attempts is refused with{" "}
              <span className="font-mono text-red">CORDON_REVOKED</span>, and the whole pool
              transaction reverts. There is no un-revoke.
            </p>
          </div>
        </div>
      </section>

      {/* ── the published policies, read from the chain ─────────────────── */}
      <SectionHead
        title="Published policies"
        meta={
          <>
            PolicyRegistry{" "}
            {registries?.available ? (
              <ContractRef address={registries.value.policyRegistry} live />
            ) : (
              "unavailable"
            )}
          </>
        }
        right={`${CONFIGURED_POLICIES.length} configured for this build`}
      />
      <Agate caption="Published policies, read from the chain">
        <thead>
          <tr>
            <th>Policy id</th>
            <th>Required claim</th>
            <th>Issuer</th>
            <th className="num">Per-transfer cap</th>
            <th className="num">Velocity limit</th>
            <th>Payee cred</th>
            <th>Active</th>
          </tr>
        </thead>
        <tbody>
          {CONFIGURED_POLICIES.map((id) => {
            const entry = policies[id];
            return (
              <tr key={id} data-verdict={entry?.policy?.active ? "pass" : undefined}>
                <td>{id}</td>
                <td className="code">
                  {entry?.policy ? `'${feltToShortString(entry.policy.requiredClaim) ?? entry.policy.requiredClaim}'` : "unavailable"}
                </td>
                <td>
                  {entry?.policy
                    ? feltToShortString(entry.policy.issuerId) ?? "any active issuer"
                    : "unavailable"}
                </td>
                <td className="num amount">
                  {entry?.policy
                    ? entry.policy.maxAmount === 0n
                      ? "unlimited"
                      : formatUnits(entry.policy.maxAmount)
                    : "unavailable"}
                </td>
                <td className="num">
                  {entry?.policy
                    ? entry.policy.maxPerEpoch === 0n
                      ? "—"
                      : `${formatUnits(entry.policy.maxPerEpoch)} / ${Number(entry.policy.epochLength) / 3600}h`
                    : "unavailable"}
                </td>
                <td className={entry?.policy?.requirePayeeCredential ? "" : "text-ink-3"}>
                  {entry?.policy ? (entry.policy.requirePayeeCredential ? "required" : "no") : "—"}
                </td>
                <td className="decision">
                  {entry?.policy ? (entry.policy.active ? "Active" : "Retired") : "unavailable"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </Agate>
      <p className="note pt-bl">
        Read from {config.gateAddress ? shorten(config.gateAddress) : "the gate"} at{" "}
        {provider ? "the configured node" : "no node"}. A policy is immutable once published;
        changing one means publishing a new version under a new id.
      </p>
    </article>
  );
}

/* ── pieces ─────────────────────────────────────────────────────────────── */

/**
 * What was issued, and how it reaches the subject.
 *
 * The compact form gets the most space on purpose. The subject is frequently a different person on
 * a different machine, so the credential has to travel as text — 268 characters, safe in a URL, a
 * QR code or a chat message — and the Passport screen's paste box is the other end of it.
 */
function IssuedPanel({
  issued,
  copied,
  onCopied,
}: {
  issued: IssuedCredential;
  copied: boolean;
  onCopied: (value: boolean) => void;
}) {
  const credential = useCordonCredential();
  const [loaded, setLoaded] = useState(false);

  const decoded = useMemo(() => {
    try {
      return credentialFromJson(issued.credential);
    } catch {
      return null;
    }
  }, [issued]);

  const mine =
    decoded !== null &&
    credential.subject !== null &&
    BigInt(decoded.subjectPublicKey) === BigInt(credential.subject.publicKey);

  return (
    <div className="border-y border-ink mt-bl py-tick">
      <p className="font-display text-agate uppercase tracking-[var(--tracking-mega)] text-green">
        Issued
      </p>
      <Rows className="mt-tick">
        <Row label="Claim" value={`'${issued.claim}'`} big strong />
        <Row label="Credential id" value={issued.credential.credentialId} />
        <Row label="Subject" value={issued.credential.subjectPublicKey} />
        <Row
          label="Expires"
          value={formatInstant(Number(issued.credential.expiresAt))}
        />
        <Row
          label="Evidence"
          value={
            issued.evidence === "ofac-screen"
              ? `OFAC screen · ${issued.screening?.status ?? "unavailable"}${
                  issued.screening?.provenance
                    ? ` · ${formatCount(issued.screening.provenance.addressCount)} listed addresses fetched ${issued.screening.provenance.fetchedAt.slice(0, 10)}`
                    : ""
                }`
              : `Operator attestation · ${issued.attestation?.basis ?? "unavailable"}`
          }
        />
      </Rows>

      <p className="label pt-bl">Compact form — this is what travels</p>
      <textarea
        readOnly
        rows={4}
        className="w-full font-mono text-fine mt-hair border border-rule p-tick break-all"
        value={issued.compact}
        onFocus={(event) => event.currentTarget.select()}
      />
      <div className="flex flex-wrap items-center gap-tick pt-tick">
        <button
          type="button"
          className="btn"
          onClick={() => {
            void navigator.clipboard
              .writeText(issued.compact)
              .then(() => onCopied(true))
              .catch(() => undefined);
          }}
        >
          {copied ? "Copied" : "Copy credential"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={loaded || !decoded}
          onClick={() => {
            if (!decoded) return;
            credential.set(decoded);
            setLoaded(true);
          }}
        >
          {loaded ? "Held in this browser" : "Hold it in this browser"}
        </button>
      </div>
      <p className="note pt-tick">
        {mine
          ? "This credential names the pseudonym this session holds, so holding it here is enough — the Pay screen will find it."
          : "This credential names a pseudonym this session does not hold. Send the compact form to whoever derived it; they paste it on their own Passport screen. Holding it here would give this browser a document it cannot sign for."}
      </p>
    </div>
  );
}

/* ── chain reads ────────────────────────────────────────────────────────── */

/** The issuer's registered key and standing, straight off the `IssuerRegistry`. */
function useOnChainIssuerKey(issuerId: string | null): {
  value: string | null;
  active: boolean | null;
} {
  const { provider, registries } = useCordonContext();
  const [state, setState] = useState<{ value: string | null; active: boolean | null }>({
    value: null,
    active: null,
  });

  useEffect(() => {
    const registry = registries?.available ? registries.value.issuerRegistry : null;
    if (!issuerId || !registry) return;
    let cancelled = false;
    void Promise.all([
      provider.callContract({
        contractAddress: registry,
        entrypoint: "issuer_public_key",
        calldata: [issuerId],
      }),
      provider.callContract({
        contractAddress: registry,
        entrypoint: "is_issuer_active",
        calldata: [issuerId],
      }),
    ])
      .then(([key, active]) => {
        if (cancelled) return;
        setState({ value: key[0] ?? null, active: active[0] ? BigInt(active[0]) === 1n : null });
      })
      .catch(() => {
        // An unread registry stays null and renders as `unavailable`. It is never guessed at:
        // "the key matches" is the one claim on this screen worth being certain about.
        if (!cancelled) setState({ value: null, active: null });
      });
    return () => {
      cancelled = true;
    };
  }, [provider, registries, issuerId]);

  return state;
}

/** Every configured policy, read from the `PolicyRegistry`. */
function useOnChainPolicies(): Record<string, { policy: Policy | null }> {
  const { provider, registries } = useCordonContext();
  const [state, setState] = useState<Record<string, { policy: Policy | null }>>({});

  useEffect(() => {
    const registry = registries?.available ? registries.value.policyRegistry : null;
    if (!registry) return;
    let cancelled = false;
    void Promise.all(
      CONFIGURED_POLICIES.map(async (id) => {
        try {
          const raw = await provider.callContract({
            contractAddress: registry,
            entrypoint: "get_policy",
            calldata: [shortStringToFelt(id)],
          });
          return [id, { policy: policyFromCalldata(raw) }] as const;
        } catch {
          return [id, { policy: null }] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setState(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [provider, registries]);

  return state;
}
