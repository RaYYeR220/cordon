//! Shared fixtures for the Cordon test suite.
//!
//! The world these helpers build is the mainnet one in miniature: an issuer registry with one live
//! issuer, a revocation registry that reads operator rights from it, a payer policy and a payee
//! claim policy, a gate wired to all three registries *and to the mock pool*, and that pool
//! holding the tokens. Every test starts from [`setup`] and then breaks exactly one thing.

use snforge_std::signature::stark_curve::{StarkCurveKeyPairImpl, StarkCurveSignerImpl};
use snforge_std::signature::{KeyPair, KeyPairTrait, SignerTrait};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_block_timestamp_global,
    start_cheat_caller_address, start_cheat_chain_id_global, stop_cheat_caller_address,
};
use starknet::ContractAddress;
use crate::hashing;
use crate::hashing::legs;
use crate::interfaces::{
    IIssuerRegistryDispatcher, IIssuerRegistryDispatcherTrait, IPolicyGateDispatcher,
    IPolicyRegistryDispatcher, IPolicyRegistryDispatcherTrait, IRevocationRegistryDispatcher,
};
use crate::mocks::mock_erc20::{IMockERC20MintDispatcher, IMockERC20MintDispatcherTrait};
use crate::mocks::mock_pool::{IMockPoolDispatcher, IMockPoolDispatcherTrait};
use crate::types::{
    ClaimTerms, Credential, FundTerms, GateOperation, OpenNoteDeposit, Policy, RefundTerms,
    SubjectAuthorization,
};

/// Deterministic secret keys, so a failure is always reproducible.
pub const ISSUER_SECRET: felt252 = 0x1517;
pub const SUBJECT_SECRET: felt252 = 0x5ec4e7;
pub const PAYEE_SECRET: felt252 = 0xa11ce;
pub const IMPOSTER_SECRET: felt252 = 0xbad;

pub const ISSUER_ID: felt252 = 'CORDON_KYC';
pub const OTHER_ISSUER_ID: felt252 = 'OTHER_KYC';
pub const CREDENTIAL_ID: felt252 = 'CRED_0001';
pub const PAYEE_CREDENTIAL_ID: felt252 = 'CRED_0002';

pub const POLICY_ID: felt252 = 'PAY_ACCREDITED_V1';
pub const CLAIM: felt252 = 'ACCREDITED';
/// The policy a payee has to satisfy to take a funded settlement.
pub const CLAIM_POLICY_ID: felt252 = 'RECV_KYC_L2_V1';
pub const PAYEE_CLAIM: felt252 = 'KYC_L2';

pub const NOTE_ID: felt252 = 'note_0';
pub const PAYEE_NOTE_ID: felt252 = 'note_1';
pub const NONCE: felt252 = 'nonce_0';
pub const PAYEE_NONCE: felt252 = 'nonce_p';
pub const SETTLEMENT_ID: felt252 = 'stl_0';

/// The chain the suite pretends to be on, so the `:V4` action hash is reproducible.
pub const CHAIN_ID: felt252 = 'SN_MAIN';

/// One hour, in seconds. Long enough to be a realistic velocity window.
pub const EPOCH_LENGTH: u64 = 3600;
/// Per-transaction cap used by both fixture policies.
pub const MAX_AMOUNT: u128 = 1_000;
/// Per-epoch aggregate used by both fixture policies.
pub const MAX_PER_EPOCH: u128 = 2_500;
/// A settlement comfortably inside both limits.
pub const SETTLE_AMOUNT: u128 = 400;
/// The timestamp the suite pins by default, so epoch arithmetic is predictable.
pub const START_TIME: u64 = 1_800_000_000;
/// The default credential's expiry: a day past `START_TIME`.
pub const EXPIRES_AT: u64 = START_TIME + 86_400;
/// How long a funded settlement stays claimable. Two epochs, so the two clocks stay distinct.
pub const CLAIM_WINDOW: u64 = EPOCH_LENGTH * 2;
/// When the fixture settlement stops being claimable and starts being refundable.
pub const SETTLEMENT_EXPIRES_AT: u64 = START_TIME + CLAIM_WINDOW;
/// The gate's ceiling on how long an authorisation that names no note may live.
pub const MAX_UNBOUND_WINDOW: u64 = 600;
/// The deadline a bound authorisation carries: none.
///
/// An authorisation that names its destination note is not redirectable, so it does not need to
/// die on a clock — the nonce is enough. Only the unbound mode is required to carry a deadline,
/// and those tests set their own.
pub const NO_DEADLINE: u64 = 0;
/// A deadline comfortably inside the gate's ceiling, for the unbound-mode tests.
pub const UNBOUND_DEADLINE: u64 = START_TIME + 300;

pub fn owner() -> ContractAddress {
    'OWNER'.try_into().unwrap()
}

pub fn issuer_operator() -> ContractAddress {
    'ISSUER_OP'.try_into().unwrap()
}

pub fn stranger() -> ContractAddress {
    'STRANGER'.try_into().unwrap()
}

/// The whole deployed world one test operates on.
#[derive(Copy, Drop)]
pub struct Cordon {
    pub issuer_registry: IIssuerRegistryDispatcher,
    pub revocation_registry: IRevocationRegistryDispatcher,
    pub policy_registry: IPolicyRegistryDispatcher,
    pub gate: IPolicyGateDispatcher,
    pub pool: IMockPoolDispatcher,
    pub token: ContractAddress,
    pub issuer_key: KeyPair<felt252, felt252>,
    pub subject_key: KeyPair<felt252, felt252>,
    pub payee_key: KeyPair<felt252, felt252>,
}

/// A payer policy with a per-transaction cap and an hourly velocity window, pinned to one issuer.
///
/// `token` is left open here so the bulk of the suite exercises policy logic rather than the
/// allowlist; the allowlist has its own tests.
pub fn default_policy() -> Policy {
    Policy {
        required_claim: CLAIM,
        issuer_id: ISSUER_ID,
        token: 0.try_into().unwrap(),
        max_amount: MAX_AMOUNT,
        epoch_length: EPOCH_LENGTH,
        max_per_epoch: MAX_PER_EPOCH,
        require_payee_credential: false,
        active: true,
    }
}

/// The policy a payee has to satisfy on the claim leg. Same limits, different claim: a receiving
/// cap is a real control, and the gate enforces it against the payee exactly as it does the payer.
pub fn default_claim_policy() -> Policy {
    Policy { required_claim: PAYEE_CLAIM, ..default_policy() }
}

fn deploy(name: ByteArray, calldata: @Array<felt252>) -> ContractAddress {
    let class = declare(name).unwrap().contract_class();
    let (address, _) = class.deploy(calldata).unwrap();
    address
}

/// Deploys the four contracts, the mock pool and a mock ERC20, registers one active issuer with an
/// operator, publishes both fixture policies and funds the pool.
pub fn setup() -> Cordon {
    setup_with_policies(default_policy(), default_claim_policy())
}

/// As [`setup`], but with a caller-chosen payer policy published under [`POLICY_ID`].
pub fn setup_with_policy(policy: Policy) -> Cordon {
    setup_with_policies(policy, default_claim_policy())
}

/// As [`setup`], with both policies chosen by the caller.
pub fn setup_with_policies(policy: Policy, claim_policy: Policy) -> Cordon {
    // Pin the clock and the chain so credential expiry, epoch arithmetic and the `:V3` action hash
    // all mean something.
    start_cheat_block_timestamp_global(START_TIME);
    start_cheat_chain_id_global(CHAIN_ID);

    let owner_address = owner();

    // The pool is deployed first: the gate takes its address at construction and never lets it
    // change, so there is no bootstrap order in which the gate learns it later.
    let pool_address = deploy("MockPool", @array![]);
    let token = deploy("MockERC20", @array![]);

    let issuer_registry_address = deploy("IssuerRegistry", @array![owner_address.into()]);
    let revocation_registry_address = deploy(
        "RevocationRegistry", @array![owner_address.into(), issuer_registry_address.into()],
    );
    let policy_registry_address = deploy("PolicyRegistry", @array![owner_address.into()]);
    let gate_address = deploy(
        "PolicyGate",
        @array![
            owner_address.into(), pool_address.into(), issuer_registry_address.into(),
            revocation_registry_address.into(), policy_registry_address.into(),
        ],
    );

    let issuer_key = KeyPairTrait::<felt252, felt252>::from_secret_key(ISSUER_SECRET);
    let subject_key = KeyPairTrait::<felt252, felt252>::from_secret_key(SUBJECT_SECRET);
    let payee_key = KeyPairTrait::<felt252, felt252>::from_secret_key(PAYEE_SECRET);

    let issuer_registry = IIssuerRegistryDispatcher { contract_address: issuer_registry_address };
    let policy_registry = IPolicyRegistryDispatcher { contract_address: policy_registry_address };

    start_cheat_caller_address(issuer_registry_address, owner_address);
    issuer_registry
        .register_issuer(ISSUER_ID, issuer_key.public_key, issuer_operator(), "ipfs://cordon-kyc");
    stop_cheat_caller_address(issuer_registry_address);

    start_cheat_caller_address(policy_registry_address, owner_address);
    policy_registry.publish_policy(POLICY_ID, policy);
    policy_registry.publish_policy(CLAIM_POLICY_ID, claim_policy);
    stop_cheat_caller_address(policy_registry_address);

    // The pool holds the shielded value it is about to route through the gate.
    IMockERC20MintDispatcher { contract_address: token }.mint(pool_address, 1_000_000);

    Cordon {
        issuer_registry,
        revocation_registry: IRevocationRegistryDispatcher {
            contract_address: revocation_registry_address,
        },
        policy_registry,
        gate: IPolicyGateDispatcher { contract_address: gate_address },
        pool: IMockPoolDispatcher { contract_address: pool_address },
        token,
        issuer_key,
        subject_key,
        payee_key,
    }
}

#[generate_trait]
pub impl CordonImpl of CordonTrait {
    //
    // Credentials
    //

    /// A credential signed by the fixture issuer for the fixture payer.
    fn credential(self: @Cordon) -> Credential {
        self
            .sign_credential(
                *self.issuer_key, CREDENTIAL_ID, (*self.subject_key).public_key, CLAIM, EXPIRES_AT,
            )
    }

    /// A payer credential with a caller-chosen claim and expiry, signed by `signer`.
    ///
    /// Signing with a key that is not the registered issuer's is how the suite produces a forgery;
    /// changing `claim` is how it produces a mismatch.
    fn credential_signed_by(
        self: @Cordon, signer: KeyPair<felt252, felt252>, claim: felt252, expires_at: u64,
    ) -> Credential {
        self
            .sign_credential(
                signer, CREDENTIAL_ID, (*self.subject_key).public_key, claim, expires_at,
            )
    }

    /// A credential for the fixture payee, which the claim policy accepts.
    fn payee_credential(self: @Cordon) -> Credential {
        self
            .sign_credential(
                *self.issuer_key,
                PAYEE_CREDENTIAL_ID,
                (*self.payee_key).public_key,
                PAYEE_CLAIM,
                EXPIRES_AT,
            )
    }

    /// The general form: any issuer key, any credential id, any subject, any claim, any expiry.
    fn sign_credential(
        self: @Cordon,
        signer: KeyPair<felt252, felt252>,
        credential_id: felt252,
        subject_public_key: felt252,
        claim: felt252,
        expires_at: u64,
    ) -> Credential {
        let mut credential = Credential {
            issuer_id: ISSUER_ID,
            credential_id,
            subject_public_key,
            claim,
            expires_at,
            sig_r: 0,
            sig_s: 0,
        };
        let (sig_r, sig_s) = signer.sign(hashing::credential_hash(@credential)).unwrap();
        credential.sig_r = sig_r;
        credential.sig_s = sig_s;
        credential
    }

    //
    // Action signatures — the `:V3` hash, bound to this chain, this gate, this pool and this leg
    //

    /// The general form. Every field the gate will hash, chosen by the caller.
    fn sign_action_as(
        self: @Cordon,
        key: KeyPair<felt252, felt252>,
        leg: felt252,
        policy_id: felt252,
        note_binding: felt252,
        amount: u128,
        nonce: felt252,
        terms_hash: felt252,
    ) -> (felt252, felt252) {
        self
            .sign_action_until(
                key, leg, policy_id, note_binding, NO_DEADLINE, amount, nonce, terms_hash,
            )
    }

    /// The general form: any key, any binding, any deadline.
    fn sign_action_until(
        self: @Cordon,
        key: KeyPair<felt252, felt252>,
        leg: felt252,
        policy_id: felt252,
        note_binding: felt252,
        valid_until: u64,
        amount: u128,
        nonce: felt252,
        terms_hash: felt252,
    ) -> (felt252, felt252) {
        key
            .sign(
                hashing::subject_action_hash(
                    CHAIN_ID,
                    (*self.gate).contract_address,
                    (*self.pool).contract_address,
                    leg,
                    policy_id,
                    note_binding,
                    valid_until,
                    *self.token,
                    amount,
                    nonce,
                    terms_hash,
                ),
            )
            .unwrap()
    }

    /// A complete payer authorisation for a `Direct` leg.
    fn direct_auth(
        self: @Cordon, amount: u128, nonce: felt252, note_id: felt252,
    ) -> SubjectAuthorization {
        self.direct_auth_bound(amount, nonce, note_id, NO_DEADLINE)
    }

    /// A `Direct` authorisation with a caller-chosen binding and deadline.
    fn direct_auth_bound(
        self: @Cordon, amount: u128, nonce: felt252, note_binding: felt252, valid_until: u64,
    ) -> SubjectAuthorization {
        let credential = self.credential();
        let (sig_r, sig_s) = self
            .sign_action_until(
                *self.subject_key,
                legs::DIRECT,
                POLICY_ID,
                note_binding,
                valid_until,
                amount,
                nonce,
                0,
            );
        SubjectAuthorization {
            policy_id: POLICY_ID,
            credential,
            note_binding,
            valid_until,
            amount,
            sig_r,
            sig_s,
            nonce,
        }
    }

    //
    // Direct settlement
    //

    /// Runs a full direct settlement through the mock pool with everything correct.
    fn settle(self: @Cordon, amount: u128) -> Span<OpenNoteDeposit> {
        self.settle_with_nonce(amount, NONCE)
    }

    /// A direct settlement with a caller-chosen nonce, for replay tests.
    fn settle_with_nonce(self: @Cordon, amount: u128, nonce: felt252) -> Span<OpenNoteDeposit> {
        self.settle_auth(amount, self.direct_auth(amount, nonce, NOTE_ID))
    }

    /// The escape hatch every direct-refusal test uses: a caller-built authorisation, and a
    /// separately chosen amount for the pool to withdraw.
    fn settle_auth(
        self: @Cordon, withdrawn: u128, payer: SubjectAuthorization,
    ) -> Span<OpenNoteDeposit> {
        self.apply(GateOperation::Direct(payer), withdrawn.into(), NOTE_ID)
    }

    /// A direct settlement built from a caller-supplied credential and signature.
    fn settle_raw(
        self: @Cordon,
        withdrawn: u128,
        credential: Credential,
        amount: u128,
        sig_r: felt252,
        sig_s: felt252,
        nonce: felt252,
    ) -> Span<OpenNoteDeposit> {
        self
            .settle_auth(
                withdrawn,
                SubjectAuthorization {
                    policy_id: POLICY_ID,
                    credential,
                    note_binding: NOTE_ID,
                    valid_until: NO_DEADLINE,
                    amount,
                    sig_r,
                    sig_s,
                    nonce,
                },
            )
    }

    //
    // Two-step settlement
    //

    /// Funds the fixture settlement for the fixture payee, with everything correct.
    fn fund(self: @Cordon, amount: u128) -> Span<OpenNoteDeposit> {
        self
            .fund_terms(
                SETTLEMENT_ID,
                amount,
                (*self.payee_key).public_key,
                CLAIM_POLICY_ID,
                SETTLEMENT_EXPIRES_AT,
                NONCE,
            )
    }

    /// Funds with caller-chosen terms, signed by the fixture payer.
    ///
    /// The funding leg has no open note, so `note_id` is `0` — exactly what the SDK passes when
    /// the action array is `withdraw → invoke` — and the payer signs `0` in its place.
    fn fund_terms(
        self: @Cordon,
        settlement_id: felt252,
        amount: u128,
        payee_subject_key: felt252,
        payee_claim_policy_id: felt252,
        expires_at: u64,
        nonce: felt252,
    ) -> Span<OpenNoteDeposit> {
        let terms_hash = hashing::settlement_terms_hash(
            settlement_id, payee_subject_key, payee_claim_policy_id, expires_at,
        );
        let (sig_r, sig_s) = self
            .sign_action_as(*self.subject_key, legs::FUND, POLICY_ID, 0, amount, nonce, terms_hash);
        let payer = SubjectAuthorization {
            policy_id: POLICY_ID,
            credential: self.credential(),
            note_binding: 0,
            valid_until: NO_DEADLINE,
            amount,
            sig_r,
            sig_s,
            nonce,
        };
        self
            .apply(
                GateOperation::Fund(
                    FundTerms {
                        payer, settlement_id, payee_subject_key, payee_claim_policy_id, expires_at,
                    },
                ),
                amount.into(),
                0,
            )
    }

    /// The payee claims the fixture settlement with everything correct.
    fn claim(self: @Cordon, amount: u128) -> Span<OpenNoteDeposit> {
        self.claim_as(*self.payee_key, self.payee_credential(), SETTLEMENT_ID, amount, PAYEE_NONCE)
    }

    /// A claim with a caller-chosen credential, settlement or nonce, signed by the payee key.
    fn claim_with(
        self: @Cordon, credential: Credential, settlement_id: felt252, amount: u128, nonce: felt252,
    ) -> Span<OpenNoteDeposit> {
        self.claim_as(*self.payee_key, credential, settlement_id, amount, nonce)
    }

    /// A claim signed by any key at all — how the suite presents a third party.
    ///
    /// The payee's transaction carries no withdraw leg: `withdrawn = 0`. The value is already with
    /// the gate, put there by the funding leg.
    fn claim_as(
        self: @Cordon,
        key: KeyPair<felt252, felt252>,
        credential: Credential,
        settlement_id: felt252,
        amount: u128,
        nonce: felt252,
    ) -> Span<OpenNoteDeposit> {
        let (sig_r, sig_s) = self
            .sign_action_as(
                key,
                legs::CLAIM,
                CLAIM_POLICY_ID,
                PAYEE_NOTE_ID,
                amount,
                nonce,
                hashing::quoted_settlement_hash(settlement_id),
            );
        self
            .apply(
                GateOperation::Claim(
                    ClaimTerms {
                        settlement_id,
                        credential,
                        note_binding: PAYEE_NOTE_ID,
                        valid_until: NO_DEADLINE,
                        sig_r,
                        sig_s,
                        nonce,
                    },
                ),
                0,
                PAYEE_NOTE_ID,
            )
    }

    /// The payer takes the fixture settlement back.
    fn refund(self: @Cordon, amount: u128) -> Span<OpenNoteDeposit> {
        self.refund_with(SETTLEMENT_ID, amount, 'nonce_refund', *self.subject_key)
    }

    /// A refund signed by a caller-chosen key, so a test can prove a stranger cannot trigger one.
    fn refund_with(
        self: @Cordon,
        settlement_id: felt252,
        amount: u128,
        nonce: felt252,
        key: KeyPair<felt252, felt252>,
    ) -> Span<OpenNoteDeposit> {
        let (sig_r, sig_s) = self
            .sign_action_as(
                key,
                legs::REFUND,
                POLICY_ID,
                NOTE_ID,
                amount,
                nonce,
                hashing::quoted_settlement_hash(settlement_id),
            );
        self
            .apply(
                GateOperation::Refund(
                    RefundTerms {
                        settlement_id,
                        note_binding: NOTE_ID,
                        valid_until: NO_DEADLINE,
                        sig_r,
                        sig_s,
                        nonce,
                    },
                ),
                0,
                NOTE_ID,
            )
    }

    /// Drives the mock pool through one action array against the gate.
    fn apply(
        self: @Cordon, operation: GateOperation, withdrawn: u256, note_id: felt252,
    ) -> Span<OpenNoteDeposit> {
        (*self.pool)
            .apply_actions(
                gate: (*self.gate).contract_address,
                :operation,
                token: *self.token,
                :withdrawn,
                claimed_pool_address: (*self.pool).contract_address,
                :note_id,
            )
    }
}
