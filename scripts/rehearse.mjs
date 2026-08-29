#!/usr/bin/env node
//
// Rehearse the whole Cordon live path against Starknet mainnet, without a wallet and without
// spending anything.
//
// A live run does three things this script cannot: prove a STRK20 transaction, pay for it, and
// read a shielded balance. Everything else happens here for real: the chain is read, a credential
// is signed and checked against the key the registry holds, all four action arrays are built, and
// the gate's decisions are predicted against the policies as published. A mistake that would
// revert on chain for a reason knowable off chain fails here instead, before any money moves.
//
// Read-only. No transaction is sent and no account key is used.
//
//   node scripts/rehearse.mjs
//
// Set ISSUER_PRIVATE_KEY to rehearse the signing path too — the same variable the issuer service
// takes, so a service already configured needs nothing new:
//
//   node --env-file=services/issuer/.env scripts/rehearse.mjs
//
// Without it the checks that need an issuer-signed credential are skipped rather than faked, and
// the run still passes. The key is read from the environment only: never printed, never written,
// never looked for on disk.
//
import { createRequire } from "node:module";
import { deepStrictEqual } from "node:assert/strict";
import {
  DIRECT_TERMS_HASH,
  FUND_NOTE_ID,
  POOL_ADDRESS_PLACEHOLDER,
  WALLET_PLACEHOLDERS,
  authorizeClaim,
  authorizeDirect,
  authorizeFund,
  authorizeRefund,
  bindToNote,
  bindingFelt,
  buildClaimActions,
  buildDirectActions,
  buildFundActions,
  buildRefundActions,
  decodeCredential,
  decodeRefusal,
  describePolicy,
  encodeCredential,
  encodeGateCalldata,
  epochResetsAt,
  feltEquals,
  fetchGateContext,
  formatActions,
  generateSubjectKeypair,
  isFelt,
  isPlaceholder,
  issueCredential,
  padFelt,
  policyFromCalldata,
  preflight,
  randomFelt,
  readResolvedNoteId,
  shortStringToFelt,
  subjectActionHash,
  subjectPublicKey,
  toBigInt,
  toFelt,
  validateActions,
  validateCredential,
  verifyCredentialSignature,
  verifySubjectAction,
} from "@cordon/sdk";

// `@cordon/sdk` is a workspace, so it resolves from anywhere in the repository. `starknet` is not:
// it is a dependency of the workspaces, and nothing installs it at the root, so a file in
// `scripts/` cannot import it by name. Node resolves an ES module from the module's own directory
// rather than from the working directory, so no amount of `cd` fixes that. Resolve it the way Node
// would from inside the SDK, which is where it is installed.
const { RpcProvider } = createRequire(import.meta.resolve("@cordon/sdk"))("starknet");

const RPC = process.env.STARKNET_RPC ?? "https://api.cartridge.gg/x/starknet/mainnet";

const POOL = "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";
const GATE = "0x061c734fe518f4c1a0e46d3d2a35b4ff1ab0df17dec510cff401d25e67dfc6b2";
const ISSUER_REGISTRY = "0x001cc4f14b4af4f7b1d7a6b973fbe968513abf1c94a3e9602c7fdd14e3d3aae7";
const REVOCATION_REGISTRY = "0x035cc9e0dd4767aa259d6d7a6c6c10cb58fc97acdc0b45b7541807329a655c6d";
const POLICY_REGISTRY = "0x01b0cf177a70f390af44dc706e7867fa5d0be8920c14d23d4230955a027ab9ee";
const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

const PAYER = "0x0772d8087ce0128432787Ff09233aFece4D95B92bcA1efCe0da5707E7F9455c7";
const PAYEE = "0x031925A2Cb59C0F6156CdFF7A449C6Fe085000B02DA1d388da41de678E3B86de";

const ISSUER_ID = "CORDON_KYC";
const ISSUER_PUBLIC_KEY = "0x57f40850e8d731dc24a36efe9b5e54af67d2890b3a3bcf0f9f76ee461b12a7f";

const UNIT = 10n ** 18n;

// What the registry is expected to hold, field for field. Read back and compared rather than
// assumed: a policy is immutable once published, so a difference here means the demo is pointed at
// the wrong id, not that the rule changed.
const EXPECTED_POLICIES = {
  PAY_ACCREDITED_V1: {
    requiredClaim: "ACCREDITED",
    issuerId: ISSUER_ID,
    token: STRK,
    maxAmount: 3n * UNIT,
    epochLength: 3600n,
    maxPerEpoch: 9n * UNIT,
    requirePayeeCredential: false,
    active: true,
  },
  SETTLE_ACCREDITED_V1: {
    requiredClaim: "ACCREDITED",
    issuerId: ISSUER_ID,
    token: STRK,
    maxAmount: 5n * UNIT,
    epochLength: 3600n,
    maxPerEpoch: 10n * UNIT,
    requirePayeeCredential: true,
    active: true,
  },
  RECV_KYC_L2_V1: {
    requiredClaim: "KYC_L2",
    issuerId: ISSUER_ID,
    token: STRK,
    maxAmount: 5n * UNIT,
    epochLength: 3600n,
    maxPerEpoch: 10n * UNIT,
    requirePayeeCredential: false,
    active: true,
  },
};

// The pool charges this per `apply_actions`, out of the shielded balance and on top of whatever
// the actions move. Read from the pool below; the constant is here so a pool upgrade shows up as a
// failed check rather than as a budget that is quietly 6 STRK short per transaction.
const EXPECTED_POOL_FEE = 6n * UNIT;

let passed = 0;
let failed = 0;
let skippedCount = 0;

const section = (title) => console.log(`\n${title}\n${"-".repeat(title.length)}`);
const note = (text) => console.log(`  ${text}`);
const pass = (message) => {
  passed += 1;
  console.log(`  ok    ${message}`);
};
const fail = (message) => {
  failed += 1;
  process.exitCode = 1;
  console.error(`  FAIL  ${message}`);
};
const skip = (message) => {
  skippedCount += 1;
  console.log(`  skip  ${message}`);
};
const check = (ok, message, detail) => {
  if (ok) pass(message);
  else fail(detail === undefined ? message : `${message} — ${detail}`);
};

// The RPC returns addresses unpadded, so pad before shortening or two addresses of the same
// contract read as different ones.
const full = (value) => `0x${padFelt(value)}`;
const short = (value) => `${full(value).slice(0, 10)}…${full(value).slice(-6)}`;

/** An amount in whole STRK, exactly, with no floating point anywhere near it. */
const strk = (value) => {
  const whole = value / UNIT;
  const fraction = (value % UNIT).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction === "" ? `${whole} STRK` : `${whole}.${fraction} STRK`;
};

const iso = (unixSeconds) => new Date(unixSeconds * 1000).toISOString().replace(".000", "");

const provider = new RpcProvider({ nodeUrl: RPC });

async function call(contract, entrypoint, calldata = []) {
  const raw = await provider.callContract({ contractAddress: contract, entrypoint, calldata });
  return Array.isArray(raw) ? raw : raw.result;
}

/** An ERC20 `u256` return, as one bigint. */
const u256 = (result) => toBigInt(result[0]) + (toBigInt(result[1] ?? 0) << 128n);

const now = Math.floor(Date.now() / 1000);
const DAY = 86_400;

console.log(`rpc     ${RPC}`);
console.log(`gate    ${GATE}`);
console.log(`pool    ${POOL}`);
console.log(`token   ${STRK} (STRK)`);
console.log(`clock   ${iso(now)}`);

// ---------------------------------------------------------------------------------------------
section("1. Chain context");

const context = await fetchGateContext(provider, GATE, { expectedPool: POOL });

check(
  feltEquals(context.chainId, shortStringToFelt("SN_MAIN")),
  "chain is SN_MAIN",
  `provider says ${context.chainId}`,
);
check(feltEquals(context.gate, GATE), "context gate is the deployed PolicyGate");
check(feltEquals(context.pool, POOL), "context pool is the STRK20 pool the gate was built against");

// The pool and the three registry pointers are fixed in the gate's constructor and have no
// setters, so this is the whole wiring. The RPC returns them unpadded, hence the BigInt compare.
const WIRING = {
  privacy_pool: POOL,
  issuer_registry: ISSUER_REGISTRY,
  revocation_registry: REVOCATION_REGISTRY,
  policy_registry: POLICY_REGISTRY,
};
for (const [entrypoint, expected] of Object.entries(WIRING)) {
  const [actual] = await call(GATE, entrypoint);
  check(
    feltEquals(actual, expected),
    `gate ${entrypoint}() is ${short(expected)}`,
    `it answered ${actual}`,
  );
}

// ---------------------------------------------------------------------------------------------
section("2. Issuer read-back");

const issuerIdFelt = shortStringToFelt(ISSUER_ID);
const [registeredKey] = await call(ISSUER_REGISTRY, "issuer_public_key", [issuerIdFelt]);
const [issuerActiveRaw] = await call(ISSUER_REGISTRY, "is_issuer_active", [issuerIdFelt]);
const [issuerOperator] = await call(ISSUER_REGISTRY, "issuer_operator", [issuerIdFelt]);

check(
  feltEquals(registeredKey, ISSUER_PUBLIC_KEY),
  `${ISSUER_ID} public key is the one this run expects`,
  `the registry holds ${toFelt(registeredKey)}`,
);
const issuerActive = toBigInt(issuerActiveRaw) !== 0n;
check(issuerActive, `${ISSUER_ID} is active`, "is_issuer_active() answered false");
note(`operator ${full(issuerOperator)}`);

// Every later check verifies against this value, not against the constant above and not against
// anything derived locally. The chain's copy of the key is the only one that decides a settlement.
const onChainIssuerKey = toFelt(registeredKey);

// ---------------------------------------------------------------------------------------------
section("3. Policy read-back");

const policies = {};
const testSubject = generateSubjectKeypair();

for (const [id, expected] of Object.entries(EXPECTED_POLICIES)) {
  const policyId = shortStringToFelt(id);
  const policy = policyFromCalldata(await call(POLICY_REGISTRY, "get_policy", [policyId]));
  policies[id] = { policyId, policy };

  console.log(`\n  ${id}  ${policyId}`);
  for (const line of describePolicy(policy)) note(`  ${line}`);

  check(
    feltEquals(policy.requiredClaim, expected.requiredClaim),
    `${id} requires ${expected.requiredClaim}`,
  );
  check(
    feltEquals(policy.issuerId, expected.issuerId),
    `${id} pins the issuer ${expected.issuerId}`,
  );
  check(feltEquals(policy.token, expected.token), `${id} pins STRK`);
  check(
    policy.maxAmount === expected.maxAmount,
    `${id} caps one settlement at ${strk(expected.maxAmount)}`,
    `it caps at ${policy.maxAmount}`,
  );
  check(
    policy.epochLength === expected.epochLength,
    `${id} epoch is ${expected.epochLength}s`,
    `it is ${policy.epochLength}s`,
  );
  check(
    policy.maxPerEpoch === expected.maxPerEpoch,
    `${id} allows ${strk(expected.maxPerEpoch)} per epoch`,
    `it allows ${policy.maxPerEpoch}`,
  );
  check(
    policy.requirePayeeCredential === expected.requirePayeeCredential,
    `${id} ${expected.requirePayeeCredential ? "requires" : "does not require"} a payee credential`,
  );
  check(policy.active === expected.active, `${id} is active`);

  const [epochRaw] = await call(GATE, "current_epoch", [policyId]);
  const epoch = toBigInt(epochRaw);
  const [spendRaw] = await call(GATE, "epoch_spend", [
    testSubject.publicKey,
    policyId,
    toFelt(epoch),
  ]);
  const spend = toBigInt(spendRaw);
  policies[id].epoch = epoch;
  policies[id].epochSpend = spend;

  note(`  epoch ${epoch}, resets ${iso(epochResetsAt(policy, now))}`);
  note(`  test subject has spent ${strk(spend)} in it`);
  check(
    spend === 0n,
    `${id} epoch spend for the throwaway test subject is zero`,
    `it is ${spend}, so this subject key is not new`,
  );
}

// ---------------------------------------------------------------------------------------------
section("4. Credential issue and read-back");

const issuerPrivateKey = process.env.ISSUER_PRIVATE_KEY?.trim();

/** Set once the configured issuer key is confirmed to be the registered one. */
let credentials = null;
/** Why there is no credential, for the sections that need one to say so precisely. */
let noCredentialBecause = "";

if (!issuerPrivateKey) {
  noCredentialBecause = "ISSUER_PRIVATE_KEY is not set";
  skip(
    "nothing is signed here, and the checks that need a signed credential are skipped rather " +
      "than faked. Set ISSUER_PRIVATE_KEY to rehearse them.",
  );
} else {
  let configuredKey;
  try {
    configuredKey = subjectPublicKey(issuerPrivateKey);
  } catch (error) {
    // Report the shape of the failure, never the value that caused it.
    configuredKey = null;
    noCredentialBecause = "ISSUER_PRIVATE_KEY is not a field element";
    fail(`ISSUER_PRIVATE_KEY is not a field element (${error.name})`);
  }

  if (configuredKey !== null) {
    const isRegisteredIssuer = feltEquals(configuredKey, onChainIssuerKey);
    check(
      isRegisteredIssuer,
      `the configured issuer key is the one ${ISSUER_ID} is registered under`,
      "it derives a different public key; credentials it signs are refused with CORDON_BAD_CRED",
    );
    if (!isRegisteredIssuer) {
      noCredentialBecause = "the configured issuer key is not the registered one";
    }

    if (isRegisteredIssuer) {
      const accredited = issueCredential(
        {
          issuerId: ISSUER_ID,
          credentialId: randomFelt(16),
          subjectPublicKey: testSubject.publicKey,
          claim: "ACCREDITED",
          expiresAt: now + DAY,
        },
        issuerPrivateKey,
      );

      check(
        verifyCredentialSignature(accredited, onChainIssuerKey, accredited.signature),
        "the credential verifies against the public key read from IssuerRegistry",
      );

      try {
        deepStrictEqual(decodeCredential(encodeCredential(accredited)), accredited);
        pass("encodeCredential -> decodeCredential round-trips field for field");
      } catch (error) {
        fail(`encodeCredential -> decodeCredential round-trips — ${error.message}`);
      }

      const validation = validateCredential(accredited, {
        issuerPublicKey: onChainIssuerKey,
        requiredClaim: "ACCREDITED",
        revokedCredentialIds: [],
      });
      check(
        validation.refusals.length === 0,
        "validateCredential finds nothing to refuse",
        validation.refusals.map((refusal) => refusal.code).join(", "),
      );
      note(`skipped by validateCredential: ${validation.skipped.join("; ") || "nothing"}`);

      const [revokedRaw] = await call(REVOCATION_REGISTRY, "is_revoked", [
        issuerIdFelt,
        accredited.credentialId,
      ]);
      check(
        toBigInt(revokedRaw) === 0n,
        "RevocationRegistry does not know this credential id",
        "a freshly generated id is already revoked, which means the id is not random",
      );

      // The payee's own credential, for the Claim leg. RECV_KYC_L2_V1 asks for KYC_L2, so this is
      // deliberately a different claim from the payer's.
      const payeeSubject = generateSubjectKeypair();
      const kycL2 = issueCredential(
        {
          issuerId: ISSUER_ID,
          credentialId: randomFelt(16),
          subjectPublicKey: payeeSubject.publicKey,
          claim: "KYC_L2",
          expiresAt: now + DAY,
        },
        issuerPrivateKey,
      );
      check(
        verifyCredentialSignature(kycL2, onChainIssuerKey, kycL2.signature),
        "the payee's KYC_L2 credential verifies against the same on-chain key",
      );

      credentials = { accredited, kycL2, payeeSubject };
    }
  }
}

// ---------------------------------------------------------------------------------------------
section("5. Action arrays");

/**
 * Everything that must hold of a built action array before a wallet ever sees it.
 *
 * `shape` is the exact action order the leg is defined by. `noteIdTail` is what the last calldata
 * felt — the `note_id` argument of `privacy_invoke(operation, token, pool_address, note_id)` —
 * should be: the wallet placeholder on a leg that fills a note, and a literal zero on a Fund,
 * which fills none.
 */
function checkActions({
  label,
  actions,
  authorization,
  shape,
  noteIdTail,
  signer,
  signature,
  hashInput,
}) {
  console.log(`\n  ${label}`);
  for (const line of formatActions(actions).split("\n")) console.log(`    ${line}`);

  const problems = validateActions(actions);
  check(
    problems.length === 0,
    `${label}: validateActions finds no problem`,
    problems.map((problem) => `[${problem.code}] ${problem.message}`).join(" "),
  );

  const types = actions.map((action) => action.type);
  check(
    types.join(" -> ") === shape.join(" -> "),
    `${label}: shape is ${shape.join(" -> ")}`,
    `it is ${types.join(" -> ")}`,
  );

  const withdraw = actions.find((action) => action.type === "withdraw");
  const transfer = actions.find((action) => action.type === "transfer");
  const invoke = actions.find((action) => action.type === "invoke");

  if (shape.includes("withdraw")) {
    // Not amount + the pool fee. The fee is taken from the shielded balance separately; a bigger
    // withdraw would leave the difference at the gate as dust nobody can pay out.
    check(
      withdraw !== undefined && toBigInt(withdraw.amount) === authorization.amount,
      `${label}: withdraw is exactly the signed amount, ${strk(authorization.amount)}`,
      withdraw === undefined ? "there is no withdraw" : `it withdraws ${withdraw.amount}`,
    );
    check(
      withdraw !== undefined && feltEquals(withdraw.recipient, context.gate),
      `${label}: withdraw pays the gate`,
    );
  } else {
    check(withdraw === undefined, `${label}: emits no withdraw at all`);
  }

  if (transfer !== undefined) {
    check(
      transfer.amount === WALLET_PLACEHOLDERS.openNote,
      `${label}: the open note's amount is the literal string "OPEN"`,
      `it is ${JSON.stringify(transfer.amount)}`,
    );
  }

  check(
    invoke !== undefined && feltEquals(invoke.contract, context.gate),
    `${label}: the invoke targets the gate`,
  );

  const calldata = invoke?.calldata ?? [];
  const poolSlot = calldata[calldata.length - 2];
  const noteSlot = calldata[calldata.length - 1];

  check(
    poolSlot === POOL_ADDRESS_PLACEHOLDER && isPlaceholder(poolSlot),
    `${label}: the pool argument is the literal ${POOL_ADDRESS_PLACEHOLDER}`,
    `it is ${JSON.stringify(poolSlot)}`,
  );
  check(
    noteSlot === noteIdTail,
    `${label}: the last calldata felt is the note id argument, ${noteIdTail}`,
    `it is ${JSON.stringify(noteSlot)}`,
  );
  check(
    feltEquals(calldata[calldata.length - 3], authorization.token),
    `${label}: the token argument sits before the pool argument`,
  );

  const notFelts = calldata.filter((item) => !isPlaceholder(item) && !isFelt(item));
  check(
    notFelts.length === 0,
    `${label}: every non-placeholder calldata item is a felt`,
    `${notFelts.length} are not: ${notFelts.map((item) => JSON.stringify(item)).join(", ")}`,
  );

  // The hash and the signature, both recomputed from the fields rather than read off the
  // authorisation. The two checks separate the two mistakes: a preimage that disagrees with the
  // contract's fails the first, a signature made with the wrong key fails the second. On chain
  // either one is the same opaque CORDON_BAD_SUBJECT_SIG.
  const recomputed = subjectActionHash(hashInput);
  check(
    feltEquals(recomputed, authorization.actionHash),
    `${label}: the action hash recomputes to what was signed`,
    `recomputed ${recomputed}, signed ${authorization.actionHash}`,
  );
  check(
    verifySubjectAction(hashInput, signer, signature),
    `${label}: the subject signature verifies against that hash`,
  );
}

/**
 * `readResolvedNoteId` reads the note id out of a wallet's prepared call. Feed it the same calldata
 * with the placeholder substituted, which is exactly what the wallet hands back, and it must return
 * the note that was signed.
 */
function checkResolvedNoteId(label, authorization, noteId) {
  const prepared = {
    call: {
      contractAddress: context.gate,
      entrypoint: "privacy_invoke",
      calldata: encodeGateCalldata(authorization, { noteId }),
    },
  };
  try {
    check(
      feltEquals(readResolvedNoteId(prepared), noteId),
      `${label}: readResolvedNoteId recovers the bound note from a resolved call`,
    );
  } catch (error) {
    fail(`${label}: readResolvedNoteId recovers the bound note — ${error.message}`);
  }
}

let fundAuthorization = null;
let settlement = null;

if (credentials === null) {
  skip(`action arrays need an issuer-signed credential — ${noCredentialBecause}`);
} else {
  const { accredited, kycL2, payeeSubject } = credentials;

  // Stand-ins for the ids the prepare-twice flow learns from the wallet. Only their shape matters
  // here: a note id is a Poseidon output, so any 31-byte felt is as plausible as the real one.
  const directNoteId = randomFelt(31);
  const claimNoteId = randomFelt(31);
  const refundNoteId = randomFelt(31);

  // --- Direct -------------------------------------------------------------------------------
  const direct = authorizeDirect(
    {
      context,
      token: STRK,
      policyId: policies.PAY_ACCREDITED_V1.policyId,
      credential: accredited,
      amount: 2n * UNIT,
      binding: bindToNote(directNoteId),
    },
    testSubject.privateKey,
  );
  checkActions({
    label: "Direct",
    actions: buildDirectActions({ authorization: direct, payee: PAYEE }),
    authorization: direct,
    shape: ["withdraw", "transfer", "invoke"],
    noteIdTail: WALLET_PLACEHOLDERS.openNoteId,
    signer: testSubject.publicKey,
    signature: direct.payer.signature,
    hashInput: {
      chainId: context.chainId,
      gateAddress: context.gate,
      poolAddress: context.pool,
      leg: "Direct",
      policyId: policies.PAY_ACCREDITED_V1.policyId,
      noteBinding: bindingFelt(direct.binding),
      validUntil: direct.binding.validUntil,
      token: STRK,
      amount: direct.amount,
      nonce: direct.payer.nonce,
      termsHash: DIRECT_TERMS_HASH,
    },
  });
  checkResolvedNoteId("Direct", direct, directNoteId);

  // --- Fund ---------------------------------------------------------------------------------
  const fund = authorizeFund(
    {
      context,
      token: STRK,
      policyId: policies.SETTLE_ACCREDITED_V1.policyId,
      credential: accredited,
      amount: 2n * UNIT,
      payeeSubjectKey: payeeSubject.publicKey,
      payeeClaimPolicyId: policies.RECV_KYC_L2_V1.policyId,
      expiresAt: now + DAY,
    },
    testSubject.privateKey,
  );
  fundAuthorization = fund;
  checkActions({
    label: "Fund",
    actions: buildFundActions({ authorization: fund }),
    authorization: fund,
    shape: ["withdraw", "invoke"],
    // A Fund fills no note, so there is no placeholder to survive here: both the signature and the
    // calldata carry zero, and the gate refuses anything else with CORDON_NOTE_ID_NOT_ZERO.
    noteIdTail: FUND_NOTE_ID,
    signer: testSubject.publicKey,
    signature: fund.payer.signature,
    hashInput: {
      chainId: context.chainId,
      gateAddress: context.gate,
      poolAddress: context.pool,
      leg: "Fund",
      policyId: policies.SETTLE_ACCREDITED_V1.policyId,
      noteBinding: FUND_NOTE_ID,
      validUntil: fund.binding.validUntil,
      token: STRK,
      amount: fund.amount,
      nonce: fund.payer.nonce,
      termsHash: fund.termsHash,
    },
  });
  note(`settlement id ${fund.settlementId}`);
  note(`claim window closes ${iso(fund.expiresAt)}`);
  // No readResolvedNoteId here, and that is not an omission: a Fund fills no note, so there is
  // nothing for the wallet to resolve and the SDK refuses a resolved id of zero outright.

  // The record the Fund would have booked. Both later legs read their amount and their policy off
  // this, which is where the gate reads them from too.
  settlement = {
    token: toFelt(STRK),
    amount: fund.amount,
    payerSubjectKey: testSubject.publicKey,
    payeeSubjectKey: payeeSubject.publicKey,
    payerPolicyId: policies.SETTLE_ACCREDITED_V1.policyId,
    payeeClaimPolicyId: policies.RECV_KYC_L2_V1.policyId,
    expiresAt: fund.expiresAt,
    status: "Funded",
  };

  // --- Claim --------------------------------------------------------------------------------
  const claim = authorizeClaim(
    {
      context,
      settlement,
      settlementId: fund.settlementId,
      credential: kycL2,
      binding: bindToNote(claimNoteId),
    },
    payeeSubject.privateKey,
  );
  checkActions({
    label: "Claim",
    actions: buildClaimActions({ authorization: claim, recipient: PAYEE }),
    authorization: claim,
    shape: ["transfer", "invoke"],
    noteIdTail: WALLET_PLACEHOLDERS.openNoteId,
    signer: payeeSubject.publicKey,
    signature: claim.signature,
    hashInput: {
      chainId: context.chainId,
      gateAddress: context.gate,
      poolAddress: context.pool,
      leg: "Claim",
      policyId: settlement.payeeClaimPolicyId,
      noteBinding: bindingFelt(claim.binding),
      validUntil: claim.binding.validUntil,
      token: settlement.token,
      amount: settlement.amount,
      nonce: claim.nonce,
      termsHash: claim.termsHash,
    },
  });
  checkResolvedNoteId("Claim", claim, claimNoteId);

  // --- Refund -------------------------------------------------------------------------------
  const refund = authorizeRefund(
    {
      context,
      settlement,
      settlementId: fund.settlementId,
      binding: bindToNote(refundNoteId),
    },
    testSubject.privateKey,
  );
  checkActions({
    label: "Refund",
    actions: buildRefundActions({ authorization: refund, recipient: PAYER }),
    authorization: refund,
    shape: ["transfer", "invoke"],
    noteIdTail: WALLET_PLACEHOLDERS.openNoteId,
    signer: testSubject.publicKey,
    signature: refund.signature,
    hashInput: {
      chainId: context.chainId,
      gateAddress: context.gate,
      poolAddress: context.pool,
      leg: "Refund",
      policyId: settlement.payerPolicyId,
      noteBinding: bindingFelt(refund.binding),
      validUntil: refund.binding.validUntil,
      token: settlement.token,
      amount: settlement.amount,
      nonce: refund.nonce,
      termsHash: refund.termsHash,
    },
  });
  checkResolvedNoteId("Refund", refund, refundNoteId);
}

// ---------------------------------------------------------------------------------------------
section("6. Refusal decoding");

// The two shapes a Starknet node actually prints. Cartridge and pathfinder decode the panic felt
// and print the short string beside it; other nodes, and traces spanning several frames, carry
// only the felt, padded to 64 characters. Both have to come back as the same rule.
const GATE_CLASS_HASH = "0x009191b1a66cd82e64a57bf03c3a8e1874facf90ef1bdbd79f47da7473cd97d9";

const OVER_CAP_REVERT = [
  "Transaction execution has failed:",
  `0: Error in the called contract (contract address: ${POOL}):`,
  "Error at pc=0:12345:",
  "Cairo traceback (most recent call last):",
  "Unknown location (pc=0:1234)",
  "",
  `1: Error in the called contract (contract address: ${GATE}, class hash: ${GATE_CLASS_HASH}):`,
  "Execution failed. Failure reason: 0x434f52444f4e5f4f5645525f434150 ('CORDON_OVER_CAP').",
].join("\n");

const REVOKED_REVERT = [
  "Transaction execution has failed:",
  `0: Error in the called contract (contract address: ${GATE}):`,
  "Error at pc=0:81:",
  "Got an exception while executing a hint: Execution failed. Failure reason:",
  `0x${shortStringToFelt("CORDON_REVOKED").slice(2).padStart(64, "0")}.`,
].join("\n");

for (const [label, text, expected] of [
  ["CORDON_OVER_CAP", OVER_CAP_REVERT, { step: 10, remedy: "payer" }],
  ["CORDON_REVOKED", REVOKED_REVERT, { step: 7, remedy: "issuer" }],
]) {
  const refusal = decodeRefusal(text);
  check(refusal.code === label, `decodeRefusal reads ${label}`, `it read ${refusal.code}`);
  check(
    refusal.step === expected.step,
    `${label} is step ${expected.step} of the gate`,
    `it says step ${refusal.step}`,
  );
  check(
    refusal.remedy === expected.remedy,
    `${label} is for the ${expected.remedy} to fix`,
    `it says ${refusal.remedy}`,
  );
  note(`${label}: ${refusal.title}`);
}

// ---------------------------------------------------------------------------------------------
section("7. Pre-flight predictions");

function report(label, result) {
  console.log(`\n  ${label}`);
  note(`  allowed          ${result.allowed}`);
  const { refusal, remainingThisEpoch } = result;
  note(`  refusal          ${refusal ? `${refusal.code} (step ${refusal.step ?? "—"})` : "none"}`);
  note(`  remaining epoch  ${remainingThisEpoch === null ? "unlimited" : strk(remainingThisEpoch)}`);
  note(`  epoch resets at  ${result.epochResetsAt === null ? "never" : iso(result.epochResetsAt)}`);
  if (result.skipped.length > 0) note(`  not checked      ${result.skipped.join("; ")}`);
}

if (credentials === null) {
  skip(`pre-flight predictions need an issuer-signed credential — ${noCredentialBecause}`);
} else {
  const { accredited, kycL2 } = credentials;
  const pay = policies.PAY_ACCREDITED_V1;

  // The chain state every prediction below shares. Everything supplied is read from mainnet; what
  // is not supplied is reported as skipped rather than assumed to pass.
  const base = {
    policy: pay.policy,
    token: STRK,
    issuerPublicKey: onChainIssuerKey,
    issuerActive,
    epochSpend: pay.epochSpend,
    now,
  };

  const inside = preflight({
    ...base,
    credential: accredited,
    amount: 2n * UNIT,
    revokedCredentialIds: [],
  });
  report("2 STRK under PAY_ACCREDITED_V1, ACCREDITED credential", inside);
  check(inside.allowed, "a 2 STRK payment inside the policy is allowed", inside.refusal?.code);
  check(inside.refusal === null, "and it names no rule that would stop it");

  const overCap = preflight({
    ...base,
    credential: accredited,
    amount: 5n * UNIT,
    revokedCredentialIds: [],
  });
  report("5 STRK under PAY_ACCREDITED_V1 (hero transaction 4)", overCap);
  check(
    overCap.refusal?.code === "CORDON_OVER_CAP",
    "5 STRK is predicted as CORDON_OVER_CAP",
    overCap.refusal?.code,
  );

  const revoked = preflight({
    ...base,
    credential: accredited,
    amount: 2n * UNIT,
    revokedCredentialIds: [accredited.credentialId],
  });
  report("the same payment once the credential is revoked (hero transaction 5)", revoked);
  check(
    revoked.refusal?.code === "CORDON_REVOKED",
    "a revoked credential is predicted as CORDON_REVOKED",
    revoked.refusal?.code,
  );

  // A genuine credential for the wrong policy. The issuer pin still matches, so the only thing
  // wrong with it is the claim.
  const wrongClaim = preflight({
    ...base,
    credential: kycL2,
    amount: 2n * UNIT,
    revokedCredentialIds: [],
  });
  report("a KYC_L2 credential against PAY_ACCREDITED_V1", wrongClaim);
  check(
    wrongClaim.refusal?.code === "CORDON_CLAIM_MISMATCH",
    "a KYC_L2 credential is predicted as CORDON_CLAIM_MISMATCH",
    wrongClaim.refusal?.code,
  );
}

// ---------------------------------------------------------------------------------------------
section("8. Budget");

const [poolFeeRaw] = await call(POOL, "get_fee_amount");
const poolFee = toBigInt(poolFeeRaw);
check(
  poolFee === EXPECTED_POOL_FEE,
  `the pool charges ${strk(EXPECTED_POOL_FEE)} per apply_actions`,
  `it charges ${strk(poolFee)}; every figure below is wrong by the difference`,
);

const payerPublic = u256(await call(STRK, "balanceOf", [PAYER]));
const payeePublic = u256(await call(STRK, "balanceOf", [PAYEE]));

console.log();
note(`payer ${short(PAYER)}`);
note(`  public STRK    ${strk(payerPublic)}`);
note("  shielded STRK  unavailable (needs the wallet's viewing key)");
note(`payee ${short(PAYEE)}`);
note(`  public STRK    ${strk(payeePublic)}`);
note("  shielded STRK  unavailable (needs the wallet's viewing key)");

// Fees only. The 2 STRK a Direct moves and the 2 STRK a Fund parks come back to the payee or to
// the payer, so they are not a cost; the pool fee is.
const PAYER_ACTIONS = 4;
const PAYEE_ACTIONS = 2;

console.log();
note(`plan: ${PAYER_ACTIONS} payer apply_actions`);
note("        2 STRK direct, fund, 5 STRK direct that reverts, headroom");
note(`      ${PAYEE_ACTIONS} payee apply_actions`);
note("        claim, revoked claim retry");
note(`payer needs ${strk(BigInt(PAYER_ACTIONS) * poolFee)} shielded for fees, plus 4 STRK in flight`);
note(`payee needs ${strk(BigInt(PAYEE_ACTIONS) * poolFee)} shielded for fees`);
note(`total pool fees ${strk(BigInt(PAYER_ACTIONS + PAYEE_ACTIONS) * poolFee)}`);
note("a reverted apply_actions refunds its pool fee; the gas it burned is gone either way");
note("none of this is asserted — the shielded side is the number to check in the wallet");

// ---------------------------------------------------------------------------------------------
console.log(`\n${passed} checks passed, ${failed} failed, ${skippedCount} skipped`);
console.log(failed === 0 ? "rehearsal clean" : "rehearsal FAILED");
