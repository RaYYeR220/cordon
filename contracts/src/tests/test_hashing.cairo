//! Pinned hash vectors.
//!
//! `@cordon/sdk` recomputes both preimages in TypeScript. These tests fix the numbers that the two
//! implementations have to agree on, so a field reorder or a changed tag fails here — loudly,
//! with a diff — instead of failing in production as an unexplainable `CORDON_BAD_CRED`.
//!
//! The same fixture and the same expected values are reproduced in `contracts/HASHING.md`.

use core::poseidon::poseidon_hash_span;
use starknet::ContractAddress;
use crate::hashing::domain_separation::{CREDENTIAL_TAG, SUBJECT_ACTION_TAG};
use crate::hashing::{credential_hash, subject_action_hash};
use crate::types::Credential;

/// The pinned credential hash of [`fixture_credential`].
pub const FIXTURE_CREDENTIAL_HASH: felt252 =
    0x33416da028165a7c7d2799315f717493f4ffe5379a4f1efe7fb85e1244db1b5;
/// The pinned action hash of the fixture settlement.
pub const FIXTURE_ACTION_HASH: felt252 =
    0x796cff5d741e86cd5fb0cd9f48186501141039ae4ea33ee094b639d19e30621;

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

#[test]
fn credential_hash_matches_pinned_vector() {
    assert_eq!(credential_hash(@fixture_credential()), FIXTURE_CREDENTIAL_HASH);
}

#[test]
fn subject_action_hash_matches_pinned_vector() {
    assert_eq!(
        subject_action_hash('PAY_ACCREDITED_V1', 'note_0', fixture_token(), 400, 'nonce_0'),
        FIXTURE_ACTION_HASH,
    );
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

/// The action preimage, likewise spelled out.
#[test]
fn action_preimage_is_the_documented_field_list() {
    let tag_cordon_subject_action_v1: felt252 = 0x434f52444f4e5f5355424a4543545f414354494f4e3a5631;
    let policy_id_pay_accredited_v1: felt252 = 0x5041595f414343524544495445445f5631;
    let note_id_note_0: felt252 = 0x6e6f74655f30;
    let strk_token: felt252 = 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d;
    let amount: felt252 = 400;
    let nonce_nonce_0: felt252 = 0x6e6f6e63655f30;

    let preimage = [
        tag_cordon_subject_action_v1, policy_id_pay_accredited_v1, note_id_note_0, strk_token,
        amount, nonce_nonce_0,
    ]
        .span();

    assert_eq!(poseidon_hash_span(preimage), FIXTURE_ACTION_HASH);
    assert_eq!(
        poseidon_hash_span(preimage),
        subject_action_hash('PAY_ACCREDITED_V1', 'note_0', fixture_token(), 400, 'nonce_0'),
    );
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
fn every_action_field_moves_the_hash() {
    let token = fixture_token();
    let base = subject_action_hash('PAY_ACCREDITED_V1', 'note_0', token, 400, 'nonce_0');

    assert_ne!(subject_action_hash('PAY_KYC_L2_V1', 'note_0', token, 400, 'nonce_0'), base);
    assert_ne!(subject_action_hash('PAY_ACCREDITED_V1', 'note_1', token, 400, 'nonce_0'), base);
    assert_ne!(
        subject_action_hash(
            'PAY_ACCREDITED_V1', 'note_0', 0x1234.try_into().unwrap(), 400, 'nonce_0',
        ),
        base,
    );
    assert_ne!(subject_action_hash('PAY_ACCREDITED_V1', 'note_0', token, 401, 'nonce_0'), base);
    assert_ne!(subject_action_hash('PAY_ACCREDITED_V1', 'note_0', token, 400, 'nonce_1'), base);
}

/// The tags are what stop a credential signature being replayed as an action signature. If they
/// ever collided, a subject who signs a credential-shaped message would be authorising payments.
#[test]
fn domain_tags_are_distinct() {
    assert_ne!(CREDENTIAL_TAG, SUBJECT_ACTION_TAG);
}
