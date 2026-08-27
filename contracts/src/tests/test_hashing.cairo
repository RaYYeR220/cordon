//! Pinned hash vectors.
//!
//! `@cordon/sdk` recomputes every preimage in TypeScript. These tests fix the numbers the two
//! implementations have to agree on, so a field reorder or a changed tag fails here — loudly,
//! with a diff — instead of failing in production as an unexplainable `CORDON_BAD_CRED`.
//!
//! The same fixtures and the same expected values are reproduced in `contracts/HASHING.md`.

use core::poseidon::poseidon_hash_span;
use starknet::ContractAddress;
use crate::hashing::domain_separation::{CREDENTIAL_TAG, SETTLEMENT_TERMS_TAG, SUBJECT_ACTION_TAG};
use crate::hashing::{
    NOTE_ANY, credential_hash, legs, quoted_settlement_hash, settlement_terms_hash,
    subject_action_hash,
};
use crate::types::Credential;

/// The pinned credential hash of [`fixture_credential`].
pub const FIXTURE_CREDENTIAL_HASH: felt252 =
    0x33416da028165a7c7d2799315f717493f4ffe5379a4f1efe7fb85e1244db1b5;
/// The pinned settlement-terms hash of the fixture `Fund`.
pub const FIXTURE_TERMS_HASH: felt252 =
    0x4d1dba11f958448bb5b3d4b7e39ebba33b79ca80ea191539bc1868a628f7d3d;
/// The deadline the fixture authorisation carries.
pub const FIXTURE_VALID_UNTIL: u64 = 1_800_000_300;
/// The pinned action hash of [`fixture_action_hash`].
pub const FIXTURE_ACTION_HASH: felt252 =
    0x15954b6b284f2575533fda03c443131d11a5217061cf1cae05b5055af9c6a22;

/// The fixture credential. Every field is a value a human can read back out of a hex dump.
fn fixture_credential() -> Credential {
    Credential {
        issuer_id: 'CORDON_KYC',
        credential_id: 'CRED_0001',
        subject_public_key: 0x1ce8adcb0d0e5e0d0a3e2b8b8f9e5c3b2a1908070605040302010f0e0d0c0b0,
        claim: 'ACCREDITED',
        expires_at: 1_800_086_400,
        // Signature fields are outside the preimage; junk here must not move the hash.
        sig_r: 0xdead,
        sig_s: 0xbeef,
    }
}

fn fixture_token() -> ContractAddress {
    // The STRK fee token, identical on every Starknet network.
    0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d.try_into().unwrap()
}

/// The gate the fixture action is bound to. An arbitrary but fixed deployment address — the point
/// of the binding is that changing this changes the hash.
fn fixture_gate() -> ContractAddress {
    0x02c0de00c0de00c0de00c0de00c0de00c0de00c0de00c0de00c0de00c0de001.try_into().unwrap()
}

/// The pool the fixture action will be pulled by.
fn fixture_pool() -> ContractAddress {
    0x0900100c0011ea1100c0011ea1100c0011ea1100c0011ea1100c0011ea11002.try_into().unwrap()
}

/// The payee the fixture settlement names.
fn fixture_payee_key() -> felt252 {
    0x066ee00a11ce00a11ce00a11ce00a11ce00a11ce00a11ce00a11ce00a11ce00
}

/// The fixture settlement's terms: id, payee, claim policy, expiry.
fn fixture_terms_hash() -> felt252 {
    settlement_terms_hash('stl_0', fixture_payee_key(), 'RECV_KYC_L2_V1', 1_800_007_200)
}

/// The fixture authorisation: a `Fund` leg on mainnet, at the gate above, through the pool above.
fn fixture_action_hash() -> felt252 {
    subject_action_hash(
        'SN_MAIN',
        fixture_gate(),
        fixture_pool(),
        legs::FUND,
        'PAY_ACCREDITED_V1',
        0,
        FIXTURE_VALID_UNTIL,
        fixture_token(),
        400,
        'nonce_0',
        fixture_terms_hash(),
    )
}

#[test]
fn credential_hash_matches_pinned_vector() {
    assert_eq!(credential_hash(@fixture_credential()), FIXTURE_CREDENTIAL_HASH);
}

#[test]
fn settlement_terms_hash_matches_pinned_vector() {
    assert_eq!(fixture_terms_hash(), FIXTURE_TERMS_HASH);
}

#[test]
fn subject_action_hash_matches_pinned_vector() {
    assert_eq!(fixture_action_hash(), FIXTURE_ACTION_HASH);
}

/// The preimage exactly as `HASHING.md` writes it, spelled out as raw felts.
///
/// This is the test that keeps the documentation honest: it recomputes the hash from a literal
/// span instead of going through [`credential_hash`], so if the function ever grows, loses or
/// reorders a field, the two stop agreeing.
#[test]
fn credential_preimage_is_the_documented_field_list() {
    let tag_cordon_credential_v1: felt252 = 0x434f52444f4e5f43524544454e5449414c3a5631;
    let issuer_id_cordon_kyc: felt252 = 0x434f52444f4e5f4b5943;
    let credential_id_cred_0001: felt252 = 0x435245445f30303031;
    let subject_public_key: felt252 =
        0x1ce8adcb0d0e5e0d0a3e2b8b8f9e5c3b2a1908070605040302010f0e0d0c0b0;
    let claim_accredited: felt252 = 0x41434352454449544544;
    let expires_at: felt252 = 1_800_086_400;

    let preimage = [
        tag_cordon_credential_v1, issuer_id_cordon_kyc, credential_id_cred_0001, subject_public_key,
        claim_accredited, expires_at,
    ]
        .span();

    assert_eq!(poseidon_hash_span(preimage), FIXTURE_CREDENTIAL_HASH);
    assert_eq!(poseidon_hash_span(preimage), credential_hash(@fixture_credential()));
}

/// The settlement-terms preimage, spelled out.
#[test]
fn terms_preimage_is_the_documented_field_list() {
    let tag: felt252 = 0x434f52444f4e5f534554544c454d454e545f5445524d533a5631;
    let settlement_id_stl_0: felt252 = 0x73746c5f30;
    let payee_subject_key: felt252 = fixture_payee_key();
    let claim_policy_recv_kyc_l2_v1: felt252 = 0x524543565f4b59435f4c325f5631;
    let expires_at: felt252 = 1_800_007_200;

    let preimage = [
        tag, settlement_id_stl_0, payee_subject_key, claim_policy_recv_kyc_l2_v1, expires_at,
    ]
        .span();

    assert_eq!(poseidon_hash_span(preimage), FIXTURE_TERMS_HASH);
    assert_eq!(poseidon_hash_span(preimage), fixture_terms_hash());
}

/// The action preimage, likewise spelled out — twelve elements since `:V4`.
#[test]
fn action_preimage_is_the_documented_field_list() {
    let tag: felt252 = 0x434f52444f4e5f5355424a4543545f414354494f4e3a5634;
    let chain_id_sn_main: felt252 = 0x534e5f4d41494e;
    let gate_address: felt252 = 0x02c0de00c0de00c0de00c0de00c0de00c0de00c0de00c0de00c0de00c0de001;
    let pool_address: felt252 = 0x0900100c0011ea1100c0011ea1100c0011ea1100c0011ea1100c0011ea11002;
    let leg_fund: felt252 = 0x434f52444f4e5f4c45475f46554e44;
    let policy_id_pay_accredited_v1: felt252 = 0x5041595f414343524544495445445f5631;
    let note_binding: felt252 = 0;
    let strk_token: felt252 = 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d;
    let amount: felt252 = 400;
    let nonce_nonce_0: felt252 = 0x6e6f6e63655f30;
    let valid_until: felt252 = 1_800_000_300;

    let preimage = [
        tag, chain_id_sn_main, gate_address, pool_address, leg_fund, policy_id_pay_accredited_v1,
        note_binding, valid_until, strk_token, amount, nonce_nonce_0, FIXTURE_TERMS_HASH,
    ]
        .span();

    assert_eq!(poseidon_hash_span(preimage), FIXTURE_ACTION_HASH);
    assert_eq!(poseidon_hash_span(preimage), fixture_action_hash());
}

#[test]
fn signature_fields_are_outside_the_credential_preimage() {
    let mut other = fixture_credential();
    other.sig_r = 0x1111;
    other.sig_s = 0x2222;
    assert_eq!(credential_hash(@fixture_credential()), credential_hash(@other));
}

#[test]
fn every_credential_field_moves_the_hash() {
    let base = credential_hash(@fixture_credential());

    let mut c = fixture_credential();
    c.issuer_id = 'OTHER_KYC';
    assert_ne!(credential_hash(@c), base);

    let mut c = fixture_credential();
    c.credential_id = 'CRED_0002';
    assert_ne!(credential_hash(@c), base);

    let mut c = fixture_credential();
    c.subject_public_key += 1;
    assert_ne!(credential_hash(@c), base);

    let mut c = fixture_credential();
    c.claim = 'KYC_L2';
    assert_ne!(credential_hash(@c), base);

    let mut c = fixture_credential();
    c.expires_at += 1;
    assert_ne!(credential_hash(@c), base);
}

#[test]
fn every_terms_field_moves_the_hash() {
    let base = fixture_terms_hash();
    let payee = fixture_payee_key();

    assert_ne!(settlement_terms_hash('stl_1', payee, 'RECV_KYC_L2_V1', 1_800_007_200), base);
    assert_ne!(settlement_terms_hash('stl_0', payee + 1, 'RECV_KYC_L2_V1', 1_800_007_200), base);
    assert_ne!(settlement_terms_hash('stl_0', payee, 'RECV_OTHER_V1', 1_800_007_200), base);
    assert_ne!(settlement_terms_hash('stl_0', payee, 'RECV_KYC_L2_V1', 1_800_007_201), base);
}

#[test]
fn every_action_field_moves_the_hash() {
    let chain = 'SN_MAIN';
    let gate = fixture_gate();
    let pool = fixture_pool();
    let policy = 'PAY_ACCREDITED_V1';
    let token = fixture_token();
    let terms = fixture_terms_hash();
    let base = fixture_action_hash();

    let other: ContractAddress = 0x1234.try_into().unwrap();

    assert_ne!(
        subject_action_hash(
            'SN_SEPOLIA',
            gate,
            pool,
            legs::FUND,
            policy,
            0,
            FIXTURE_VALID_UNTIL,
            token,
            400,
            'nonce_0',
            terms,
        ),
        base,
    );
    assert_ne!(
        subject_action_hash(
            chain,
            other,
            pool,
            legs::FUND,
            policy,
            0,
            FIXTURE_VALID_UNTIL,
            token,
            400,
            'nonce_0',
            terms,
        ),
        base,
    );
    assert_ne!(
        subject_action_hash(
            chain,
            gate,
            other,
            legs::FUND,
            policy,
            0,
            FIXTURE_VALID_UNTIL,
            token,
            400,
            'nonce_0',
            terms,
        ),
        base,
    );
    assert_ne!(
        subject_action_hash(
            chain,
            gate,
            pool,
            legs::DIRECT,
            policy,
            0,
            FIXTURE_VALID_UNTIL,
            token,
            400,
            'nonce_0',
            terms,
        ),
        base,
    );
    assert_ne!(
        subject_action_hash(
            chain,
            gate,
            pool,
            legs::FUND,
            'PAY_KYC_L2_V1',
            0,
            FIXTURE_VALID_UNTIL,
            token,
            400,
            'nonce_0',
            terms,
        ),
        base,
    );
    assert_ne!(
        subject_action_hash(
            chain,
            gate,
            pool,
            legs::FUND,
            policy,
            'note_0',
            FIXTURE_VALID_UNTIL,
            token,
            400,
            'nonce_0',
            terms,
        ),
        base,
    );
    assert_ne!(
        subject_action_hash(
            chain,
            gate,
            pool,
            legs::FUND,
            policy,
            0,
            FIXTURE_VALID_UNTIL,
            other,
            400,
            'nonce_0',
            terms,
        ),
        base,
    );
    assert_ne!(
        subject_action_hash(
            chain,
            gate,
            pool,
            legs::FUND,
            policy,
            0,
            FIXTURE_VALID_UNTIL,
            token,
            401,
            'nonce_0',
            terms,
        ),
        base,
    );
    assert_ne!(
        subject_action_hash(
            chain,
            gate,
            pool,
            legs::FUND,
            policy,
            0,
            FIXTURE_VALID_UNTIL,
            token,
            400,
            'nonce_1',
            terms,
        ),
        base,
    );
    assert_ne!(
        subject_action_hash(
            chain, gate, pool, legs::FUND, policy, 0, FIXTURE_VALID_UNTIL, token, 400, 'nonce_0', 0,
        ),
        base,
    );
    assert_ne!(
        subject_action_hash(
            chain,
            gate,
            pool,
            legs::FUND,
            policy,
            0,
            FIXTURE_VALID_UNTIL + 1,
            token,
            400,
            'nonce_0',
            terms,
        ),
        base,
    );
}

/// The binding is what a redirection attack would have to forge, so it has to move the hash — and
/// the `NOTE_ANY` sentinel has to be distinguishable from every real note id.
#[test]
fn the_note_binding_moves_the_hash_and_the_sentinel_is_distinct() {
    let chain = 'SN_MAIN';
    let gate = fixture_gate();
    let pool = fixture_pool();
    let policy = 'PAY_ACCREDITED_V1';
    let token = fixture_token();

    let bound = subject_action_hash(
        chain,
        gate,
        pool,
        legs::DIRECT,
        policy,
        'note_0',
        FIXTURE_VALID_UNTIL,
        token,
        400,
        'nonce_0',
        0,
    );
    let other_note = subject_action_hash(
        chain,
        gate,
        pool,
        legs::DIRECT,
        policy,
        'note_1',
        FIXTURE_VALID_UNTIL,
        token,
        400,
        'nonce_0',
        0,
    );
    let unbound = subject_action_hash(
        chain,
        gate,
        pool,
        legs::DIRECT,
        policy,
        NOTE_ANY,
        FIXTURE_VALID_UNTIL,
        token,
        400,
        'nonce_0',
        0,
    );

    assert_ne!(bound, other_note);
    assert_ne!(bound, unbound);
    assert_ne!(other_note, unbound);
    assert_eq!(NOTE_ANY, 'CORDON_NOTE_ANY');
}

/// The four leg tags are distinct, which is what stops one authorisation being executed as
/// another leg. Under `:V2` they were absent, and a payer's direct payment doubled as a funding
/// instruction whose every term the submitter chose.
#[test]
fn the_four_leg_tags_are_distinct() {
    assert_ne!(legs::DIRECT, legs::FUND);
    assert_ne!(legs::DIRECT, legs::CLAIM);
    assert_ne!(legs::DIRECT, legs::REFUND);
    assert_ne!(legs::FUND, legs::CLAIM);
    assert_ne!(legs::FUND, legs::REFUND);
    assert_ne!(legs::CLAIM, legs::REFUND);
}

/// `Direct` uses a literal zero terms hash, not the hash of four zeros — so a `Direct`
/// authorisation and a settlement-quoting one can never coincide.
#[test]
fn the_direct_terms_hash_is_zero_not_a_hash_of_zeros() {
    assert_ne!(quoted_settlement_hash(0), 0);
    assert_ne!(settlement_terms_hash(0, 0, 0, 0), 0);
}

/// A quoted settlement hash names its settlement and nothing else, so a claim signature is valid
/// for exactly one escrow.
#[test]
fn a_quoted_settlement_hash_is_bound_to_its_id() {
    assert_ne!(quoted_settlement_hash('stl_0'), quoted_settlement_hash('stl_1'));
    assert_eq!(quoted_settlement_hash('stl_0'), settlement_terms_hash('stl_0', 0, 0, 0));
}

/// The tags are what stop one preimage being replayed as another. If they ever collided, a subject
/// who signs a credential-shaped message would be authorising payments.
#[test]
fn domain_tags_are_distinct() {
    assert_ne!(CREDENTIAL_TAG, SUBJECT_ACTION_TAG);
    assert_ne!(CREDENTIAL_TAG, SETTLEMENT_TERMS_TAG);
    assert_ne!(SUBJECT_ACTION_TAG, SETTLEMENT_TERMS_TAG);
}

/// A credential is portable by design and an authorisation is not, so only one of them carries a
/// version bump. Pinning the tags here makes an accidental edit to either a test failure.
#[test]
fn domain_tags_are_the_documented_versions() {
    assert_eq!(CREDENTIAL_TAG, 'CORDON_CREDENTIAL:V1');
    assert_eq!(SUBJECT_ACTION_TAG, 'CORDON_SUBJECT_ACTION:V4');
    assert_eq!(SETTLEMENT_TERMS_TAG, 'CORDON_SETTLEMENT_TERMS:V1');
}
