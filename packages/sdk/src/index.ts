/**
 * `@cordon/sdk` — credential and policy gate for shielded STRK20 value on Starknet.
 *
 * Everything here is pure and browser-safe: no network, no filesystem, no Node built-ins. The one
 * runtime dependency is `starknet`, for Poseidon and the STARK curve.
 *
 * The four things this package does:
 *
 * 1. **Hashes** that match `contracts/src/hashing.cairo` exactly — {@link credentialHash} and
 *    {@link subjectActionHash}. Pinned against the Cairo fixture vectors in the test suite.
 * 2. **Keys and signatures** — subject pseudonyms, wallet-derived keys, STARK-curve sign/verify.
 * 3. **Calldata** — the four `GateOperation` variants and the STRK20 action arrays that carry
 *    them, placeholders intact.
 * 4. **Refusals** — every `CORDON_*` panic code decoded into the rule that fired.
 *
 * @packageDocumentation
 */

export {
  FIELD_PRIME,
  FeltError,
  U128_MAX,
  U64_MAX,
  feltEquals,
  feltToShortString,
  isFelt,
  padFelt,
  shortStringToFelt,
  toAddress,
  toBigInt,
  toFelt,
  toU128Felt,
  toU64Felt,
  type Address,
  type Felt,
  type FeltLike,
} from "./felt.js";

export { Base64UrlError, decodeBase64Url, encodeBase64Url } from "./base64url.js";

export {
  CREDENTIAL_TAG,
  DIRECT_TERMS_HASH,
  DOMAIN_TAGS,
  LEG_TAGS,
  SETTLEMENT_TERMS_TAG,
  SUBJECT_ACTION_TAG,
  credentialHash,
  credentialPreimage,
  poseidon,
  quotedSettlementHash,
  settlementTermsHash,
  settlementTermsPreimage,
  subjectActionHash,
  subjectActionPreimage,
  type CredentialHashInput,
  type Leg,
  type SettlementTermsHashInput,
  type SubjectActionHashInput,
} from "./hashing.js";

export {
  KeyError,
  deriveSubjectKeypair,
  generateSubjectKeypair,
  randomNonce,
  signCredential,
  signHash,
  signSubjectAction,
  subjectKeyMessageHash,
  subjectKeyTypedData,
  subjectPublicKey,
  verifyCredentialSignature,
  verifyHash,
  verifySubjectAction,
  type Signature,
  type SubjectKeypair,
} from "./keys.js";

export {
  CREDENTIAL_ENCODING_VERSION,
  CREDENTIAL_URI_SCHEME,
  CredentialError,
  createCredential,
  credentialCalldata,
  credentialFromCalldata,
  credentialFromJson,
  credentialToJson,
  credentialUri,
  decodeCredential,
  encodeCredential,
  issueCredential,
  summarizeCredential,
  validateCredential,
  type Credential,
  type CredentialCheck,
  type CredentialCheckOptions,
  type CredentialInput,
  type CredentialJson,
  type CredentialSummary,
} from "./credential.js";

export {
  PolicyError,
  createPolicy,
  currentEpoch,
  describePolicy,
  epochResetsAt,
  policyCalldata,
  policyFromCalldata,
  preflight,
  type Policy,
  type PolicyInput,
  type Preflight,
  type PreflightInput,
} from "./policy.js";

export {
  OPEN_NOTE,
  POOL_ADDRESS_PLACEHOLDER,
  WALLET_PLACEHOLDERS,
  assertValidActions,
  calldataItem,
  depositAction,
  formatActions,
  invokeAction,
  isPlaceholder,
  openNoteAction,
  openNoteIdPlaceholder,
  transferAction,
  validateActions,
  withdrawAction,
  type ActionProblem,
  type CalldataItem,
  type DepositAction,
  type InvokeAction,
  type Strk20Action,
  type TransferAction,
  type WithdrawAction,
} from "./actions.js";

export {
  FUND_NOTE_ID,
  GATE_OPERATION_VARIANT,
  OperationError,
  authorizeClaim,
  authorizeDirect,
  authorizeFund,
  authorizeRefund,
  buildActions,
  buildClaimActions,
  buildDirectActions,
  buildFundActions,
  buildRefundActions,
  encodeGateCalldata,
  encodeGateOperation,
  encodeSubjectAuthorization,
  type BuildActionsParams,
  type CalldataOverrides,
  type ClaimAuthorization,
  type DirectAuthorization,
  type FundAuthorization,
  type GateAuthorization,
  type RefundAuthorization,
  type SubjectAuthorization,
} from "./operations.js";

export {
  GateContextError,
  assertGateContext,
  createGateContext,
  fetchGateContext,
  type GateContext,
  type GateReader,
} from "./context.js";

export { randomFelt } from "./random.js";

export {
  SETTLEMENT_STATUS_VARIANT,
  SettlementError,
  assertUnguessableSettlementId,
  randomSettlementId,
  settlementCalldata,
  settlementFromCalldata,
  settlementOptions,
  settlementStatusFromFelt,
  type Settlement,
  type SettlementOptions,
  type SettlementStatus,
} from "./settlement.js";

export {
  allRefusals,
  decodeRefusal,
  decodeRefusalFromError,
  decodeRefusals,
  refusalCodes,
  refusalForCode,
  unknownRefusal,
  type Refusal,
  type RefusalRemedy,
  type RefusalSource,
} from "./refusals.js";
