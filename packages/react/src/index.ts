/**
 * `@cordon/react` — drop-in React hooks and components for Cordon.
 *
 * Cordon is a credential and policy gate for shielded STRK20 value. Value physically routes
 * through a Cairo anonymizer on its way back into a note, so the rule is unbypassable: an
 * unaccredited, revoked, expired, over-cap or over-velocity party cannot move pool funds at all —
 * the gate panics and the whole transaction reverts.
 *
 * This package is the front end of that. Three things shape it:
 *
 * - **Hooks first.** Every component is a thin render over a hook. If you dislike the visuals,
 *   take `useCordonWallet`, `useCordonCredential`, `useCordonPolicy` and `useGatedPayment` and
 *   build your own; nothing in the logic depends on the markup.
 * - **A refusal is a first-class state.** Not an error — the product working. It gets its own
 *   terminal state in the payment machine, its own component, and the exact `CORDON_*` code.
 * - **Nothing is fabricated.** A balance, a policy or a revocation status that cannot be read
 *   renders as `unavailable`. Never a zero, never an optimistic success.
 *
 * ```tsx
 * import { CordonProvider, ConnectWallet, GatedPaymentButton } from "@cordon/react";
 * import "@cordon/react/styles.css";
 *
 * <CordonProvider config={{ gateAddress: GATE }}>
 *   <ConnectWallet />
 *   <GatedPaymentButton policyId="ACCREDITED" amount={10n ** 18n} payee={PAYEE}
 *     credential={credential} subjectPrivateKey={key} noteId={noteId} />
 * </CordonProvider>
 * ```
 *
 * @packageDocumentation
 */

export {
  CordonProvider,
  useCordonConfig,
  useCordonContext,
  type CordonContextValue,
  type CordonProviderProps,
  type CordonStorage,
  type SessionRefusal,
} from "./context/CordonProvider.js";

export {
  useCordonWallet,
  type CordonWalletStatus,
  type UseCordonWallet,
} from "./hooks/useCordonWallet.js";

export {
  useCordonCredential,
  type CredentialStatus,
  type UseCordonCredential,
  type UseCordonCredentialOptions,
} from "./hooks/useCordonCredential.js";

export {
  useCordonPolicy,
  type PolicyStatus,
  type UseCordonPolicy,
  type UseCordonPolicyOptions,
} from "./hooks/useCordonPolicy.js";

export {
  useGatedPayment,
  type PayOptions,
  type PaymentBlocker,
  type PaymentLeg,
  type PaymentStatus,
  type UseGatedPayment,
  type UseGatedPaymentOptions,
} from "./hooks/useGatedPayment.js";

export {
  useGateFeed,
  type GateFeedEntry,
  type GateFeedStatus,
  type UseGateFeed,
  type UseGateFeedOptions,
} from "./hooks/useGateFeed.js";

export { ConnectWallet, type ConnectWalletProps } from "./components/ConnectWallet.js";
export { GateFeed, type GateFeedProps } from "./components/GateFeed.js";
export {
  GatedPaymentButton,
  type GatedPaymentButtonProps,
} from "./components/GatedPaymentButton.js";
export { PassportCard, type PassportCardProps } from "./components/PassportCard.js";
export { PolicyBadge, type PolicyBadgeProps } from "./components/PolicyBadge.js";
export { RefusalNotice, type RefusalNoticeProps } from "./components/RefusalNotice.js";
export { SpendMeter, type SpendMeterProps } from "./components/SpendMeter.js";
export {
  Badge,
  Fields,
  Heading,
  Unavailable,
  cx,
  type BadgeProps,
  type FieldsProps,
  type HeadingProps,
  type Verdict,
} from "./components/primitives.js";

/**
 * The chain layer, re-exported for convenience.
 *
 * It is UI-free and also published on its own as `@cordon/react/strk20`, for an app that wants the
 * wallet plumbing, the capability probe, the contract reads and the gate events without any React
 * at all.
 */
export * from "./strk20/index.js";
