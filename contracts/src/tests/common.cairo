//! Shared fixtures for the Cordon test suite.
//!
//! The world these helpers build is the mainnet one in miniature: an issuer registry with one live
//! issuer, a revocation registry that reads operator rights from it, a payer policy and a payee
//! claim policy, a gate wired to all three registries, and a mock pool holding the tokens. Every
//! test starts from [`setup`] and then breaks exactly one thing.

use snforge_std::signature::stark_curve::{StarkCurveKeyPairImpl, StarkCurveSignerImpl};
use snforge_std::signature::{KeyPair, KeyPairTrait, SignerTrait};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_block_timestamp_global,
    start_cheat_caller_address, start_cheat_chain_id_global, stop_cheat_caller_address,
};
use starknet::ContractAddress;
use crate::hashing;
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

/// The chain the suite pretends to be on, so the `:V2` action hash is reproducible.
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
pub fn default_policy() -> Policy {
    Policy {
        required_claim: CLAIM,
        issuer_id: ISSUER_ID,
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
    // Pin the clock and the chain so credential expiry, epoch arithmetic and the `:V2` action hash
    // all mean something.
    start_cheat_block_timestamp_global(START_TIME);
    start_cheat_chain_id_global(CHAIN_ID);

    let owner_address = owner();

    let issuer_registry_address = deploy("IssuerRegistry", @array![owner_address.into()]);
    let revocation_registry_address = deploy(
        "RevocationRegistry", @array![owner_address.into(), issuer_registry_address.into()],
    );
    let policy_registry_address = deploy("PolicyRegistry", @array![owner_address.into()]);
    let gate_address = deploy(
        "PolicyGate",
        @array![
            owner_address.into(), issuer_registry_address.into(),
            revocation_registry_address.into(), policy_registry_address.into(),
        ],
    );
    let pool_address = deploy("MockPool", @array![]);
    let token = deploy("MockERC20", @array![]);

    let issuer_key = KeyPairTrait::<felt252, felt252>::from_secret_key(ISSUER_SECRET);
    let subject_key = KeyPairTrait::<felt252, felt252>::from_secret_key(SUBJECT_SECRET);
    let payee_key = KeyPairTrait::<felt252, felt252>::from_secret_key(PAYEE_SECRET);

    let issuer_registry = IIssuerRegistryDispatcher { contract_address: issuer_registry_address };
    let policy_registry = IPolicyRegistryDispatcher { contract_address: policy_registry_address };

    start_cheat_caller_address(issuer_registry_address, owner_address);
    issuer_registry.register_issuer(ISSUER_ID, issuer_key.public_key, "ipfs://cordon-kyc");
    issuer_registry.set_issuer_operator(ISSUER_ID, issuer_operator());
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
    // Action signatures — the `:V2` hash, bound to this chain and this gate
    //

    /// The payer's authorisation for one settlement under [`POLICY_ID`].
    fn sign_action(
        self: @Cordon, amount: u128, nonce: felt252, note_id: felt252,
    ) -> (felt252, felt252) {
        self.sign_action_as(*self.subject_key, POLICY_ID, note_id, amount, nonce)
    }

    /// The general form: any key, any policy, any note.
    fn sign_action_as(
        self: @Cordon,
        key: KeyPair<felt252, felt252>,
        policy_id: felt252,
        note_id: felt252,
        amount: u128,
        nonce: felt252,
    ) -> (felt252, felt252) {
        key
            .sign(
                hashing::subject_action_hash(
                    CHAIN_ID,
                    (*self.gate).contract_address,
                    policy_id,
                    note_id,
                    *self.token,
                    amount,
                    nonce,
                ),
            )
            .unwrap()
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
        let credential = self.credential();
        let (sig_r, sig_s) = self.sign_action(amount, nonce, NOTE_ID);
        self.settle_raw(amount, credential, sig_r, sig_s, nonce)
    }

    /// The escape hatch every direct-refusal test uses: settle with one component swapped out.
    fn settle_raw(
        self: @Cordon,
        amount: u128,
        credential: Credential,
        sig_r: felt252,
        sig_s: felt252,
        nonce: felt252,
    ) -> Span<OpenNoteDeposit> {
        let payer = SubjectAuthorization { policy_id: POLICY_ID, credential, sig_r, sig_s, nonce };
        self.apply(GateOperation::Direct(payer), amount.into(), NOTE_ID)
    }

    //
    // Two-step settlement
    //

    /// Funds the fixture settlement with everything correct.
    fn fund(self: @Cordon, amount: u128) -> Span<OpenNoteDeposit> {
        self.fund_terms(SETTLEMENT_ID, amount, CLAIM_POLICY_ID, SETTLEMENT_EXPIRES_AT, NONCE)
    }

    /// Funds with caller-chosen terms.
    ///
    /// The funding leg has no open note, so the payer signs `note_id = 0` — exactly what the SDK
    /// passes when the action array is `withdraw → invoke`.
    fn fund_terms(
        self: @Cordon,
        settlement_id: felt252,
        amount: u128,
        payee_claim_policy_id: felt252,
        expires_at: u64,
        nonce: felt252,
    ) -> Span<OpenNoteDeposit> {
        let credential = self.credential();
        let (sig_r, sig_s) = self.sign_action(amount, nonce, 0);
        let payer = SubjectAuthorization { policy_id: POLICY_ID, credential, sig_r, sig_s, nonce };
        self
            .apply(
                GateOperation::Fund(
                    FundTerms { payer, settlement_id, payee_claim_policy_id, expires_at },
                ),
                amount.into(),
                0,
            )
    }

    /// The payee claims the fixture settlement with everything correct.
    fn claim(self: @Cordon, amount: u128) -> Span<OpenNoteDeposit> {
        self.claim_with(self.payee_credential(), SETTLEMENT_ID, amount, PAYEE_NONCE)
    }

    /// A claim with a caller-chosen credential, settlement or nonce.
    ///
    /// The payee's transaction carries no withdraw leg: `withdrawn = 0`. The value is already with
    /// the gate, put there by the funding leg.
    fn claim_with(
        self: @Cordon, credential: Credential, settlement_id: felt252, amount: u128, nonce: felt252,
    ) -> Span<OpenNoteDeposit> {
        let (sig_r, sig_s) = self
            .sign_action_as(*self.payee_key, CLAIM_POLICY_ID, PAYEE_NOTE_ID, amount, nonce);
        self
            .apply(
                GateOperation::Claim(ClaimTerms { settlement_id, credential, sig_r, sig_s, nonce }),
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
        let (sig_r, sig_s) = self.sign_action_as(key, POLICY_ID, NOTE_ID, amount, nonce);
        self
            .apply(
                GateOperation::Refund(RefundTerms { settlement_id, sig_r, sig_s, nonce }),
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
