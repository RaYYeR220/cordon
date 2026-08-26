//! Shared fixtures for the Cordon test suite.
//!
//! The world these helpers build is the mainnet one in miniature: an issuer registry with one
//! live issuer, a revocation registry that reads operator rights from it, one published policy,
//! a gate wired to all three, and a mock pool holding the tokens. Every test starts from
//! [`setup`] and then breaks exactly one thing.

use snforge_std::signature::stark_curve::{StarkCurveKeyPairImpl, StarkCurveSignerImpl};
use snforge_std::signature::{KeyPair, KeyPairTrait, SignerTrait};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_block_timestamp_global,
    start_cheat_caller_address, stop_cheat_caller_address,
};
use starknet::ContractAddress;
use crate::hashing;
use crate::interfaces::{
    IIssuerRegistryDispatcher, IIssuerRegistryDispatcherTrait, IPolicyGateDispatcher,
    IPolicyRegistryDispatcher, IPolicyRegistryDispatcherTrait, IRevocationRegistryDispatcher,
};
use crate::mocks::mock_erc20::{IMockERC20MintDispatcher, IMockERC20MintDispatcherTrait};
use crate::mocks::mock_pool::{IMockPoolDispatcher, IMockPoolDispatcherTrait};
use crate::types::{Credential, OpenNoteDeposit, Policy};

/// Deterministic secret keys, so a failure is always reproducible.
pub const ISSUER_SECRET: felt252 = 0x1517;
pub const SUBJECT_SECRET: felt252 = 0x5ec4e7;
pub const IMPOSTER_SECRET: felt252 = 0xbad;

pub const ISSUER_ID: felt252 = 'CORDON_KYC';
pub const OTHER_ISSUER_ID: felt252 = 'OTHER_KYC';
pub const CREDENTIAL_ID: felt252 = 'CRED_0001';
pub const POLICY_ID: felt252 = 'PAY_ACCREDITED_V1';
pub const CLAIM: felt252 = 'ACCREDITED';
pub const NOTE_ID: felt252 = 'note_0';
pub const NONCE: felt252 = 'nonce_0';

/// One hour, in seconds. Long enough to be a realistic velocity window.
pub const EPOCH_LENGTH: u64 = 3600;
/// Per-transaction cap used by the default policy.
pub const MAX_AMOUNT: u128 = 1_000;
/// Per-epoch aggregate used by the default policy.
pub const MAX_PER_EPOCH: u128 = 2_500;
/// A settlement comfortably inside both limits.
pub const SETTLE_AMOUNT: u128 = 400;
/// The timestamp the suite pins by default, so epoch arithmetic is predictable.
pub const START_TIME: u64 = 1_800_000_000;
/// The default credential's expiry: a day past `START_TIME`.
pub const EXPIRES_AT: u64 = START_TIME + 86_400;

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
}

/// A policy with a per-transaction cap and an hourly velocity window, pinned to one issuer.
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

fn deploy(name: ByteArray, calldata: @Array<felt252>) -> ContractAddress {
    let class = declare(name).unwrap().contract_class();
    let (address, _) = class.deploy(calldata).unwrap();
    address
}

/// Deploys the four contracts, the mock pool and a mock ERC20, registers one active issuer with an
/// operator, publishes [`default_policy`] and funds the pool.
pub fn setup() -> Cordon {
    setup_with_policy(default_policy())
}

/// As [`setup`], but with a caller-chosen policy published under [`POLICY_ID`].
pub fn setup_with_policy(policy: Policy) -> Cordon {
    // Pin the clock so credential expiry and epoch arithmetic mean something.
    start_cheat_block_timestamp_global(START_TIME);

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

    let issuer_registry = IIssuerRegistryDispatcher { contract_address: issuer_registry_address };
    let policy_registry = IPolicyRegistryDispatcher { contract_address: policy_registry_address };

    start_cheat_caller_address(issuer_registry_address, owner_address);
    issuer_registry.register_issuer(ISSUER_ID, issuer_key.public_key, "ipfs://cordon-kyc");
    issuer_registry.set_issuer_operator(ISSUER_ID, issuer_operator());
    stop_cheat_caller_address(issuer_registry_address);

    start_cheat_caller_address(policy_registry_address, owner_address);
    policy_registry.publish_policy(POLICY_ID, policy);
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
    }
}

#[generate_trait]
pub impl CordonImpl of CordonTrait {
    /// A credential signed by the fixture issuer for the fixture subject.
    fn credential(self: @Cordon) -> Credential {
        self.credential_signed_by(*self.issuer_key, CLAIM, EXPIRES_AT)
    }

    /// A credential with a caller-chosen claim and expiry, signed by `signer`.
    ///
    /// Signing with a key that is not the registered issuer's is how the suite produces a
    /// forgery; changing `claim` is how it produces a mismatch.
    fn credential_signed_by(
        self: @Cordon, signer: KeyPair<felt252, felt252>, claim: felt252, expires_at: u64,
    ) -> Credential {
        let mut credential = Credential {
            issuer_id: ISSUER_ID,
            credential_id: CREDENTIAL_ID,
            subject_public_key: (*self.subject_key).public_key,
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

    /// The subject's authorisation for one settlement.
    fn sign_action(
        self: @Cordon, amount: u128, nonce: felt252, note_id: felt252,
    ) -> (felt252, felt252) {
        (*self.subject_key)
            .sign(hashing::subject_action_hash(POLICY_ID, note_id, *self.token, amount, nonce))
            .unwrap()
    }

    /// Runs a full settlement through the mock pool with everything correct.
    fn settle(self: @Cordon, amount: u128) -> Span<OpenNoteDeposit> {
        self.settle_with_nonce(amount, NONCE)
    }

    /// A settlement with a caller-chosen nonce, for replay tests.
    fn settle_with_nonce(self: @Cordon, amount: u128, nonce: felt252) -> Span<OpenNoteDeposit> {
        let credential = self.credential();
        let (payer_sig_r, payer_sig_s) = self.sign_action(amount, nonce, NOTE_ID);
        self.settle_raw(amount, credential, payer_sig_r, payer_sig_s, nonce)
    }

    /// The escape hatch every refusal test uses: settle with one component swapped out.
    fn settle_raw(
        self: @Cordon,
        amount: u128,
        payer: Credential,
        payer_sig_r: felt252,
        payer_sig_s: felt252,
        nonce: felt252,
    ) -> Span<OpenNoteDeposit> {
        (*self.pool)
            .settle(
                gate: (*self.gate).contract_address,
                token: *self.token,
                amount: amount.into(),
                claimed_pool_address: (*self.pool).contract_address,
                note_id: NOTE_ID,
                policy_id: POLICY_ID,
                :payer,
                :payer_sig_r,
                :payer_sig_s,
                :nonce,
            )
    }
}
