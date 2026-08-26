//! Hash preimages.
//!
//! These two functions define what an issuer and a subject actually sign. An off-chain SDK has to
//! reproduce them exactly — a single reordered field turns every signature into a
//! `CORDON_BAD_CRED` — so the preimages are a public contract, mirrored in `HASHING.md` and
//! pinned by a fixture test in `tests::test_hashing`.
//!
//! Both hashes are Poseidon over a flat `felt252` span whose first element is a domain-separation
//! tag. The tag is what stops a credential signature from ever being replayed as an action
//! signature (and vice versa), since both are verified against STARK-curve keys that a subject may
//! well control in both roles.
//!
//! Domain tags follow the pool's own convention, `<PURPOSE>:V<VERSION>`, so a future field change
//! is a new tag rather than a silent reinterpretation of old signatures.

use core::poseidon::poseidon_hash_span;
use starknet::ContractAddress;
use crate::types::Credential;

/// Domain-separation tags. Template: `CORDON_<PURPOSE>:V<VERSION>`.
pub mod domain_separation {
    /// Tag for the issuer-signed credential hash.
    pub const CREDENTIAL_TAG: felt252 = 'CORDON_CREDENTIAL:V1';
    /// Tag for the subject-signed action hash.
    pub const SUBJECT_ACTION_TAG: felt252 = 'CORDON_SUBJECT_ACTION:V1';
}

/// The message an issuer signs to attest a credential.
///
/// ```text
/// credential_hash = poseidon_hash_span([
///     'CORDON_CREDENTIAL:V1',   // domain tag
///     issuer_id,                // felt252
///     credential_id,            // felt252
///     subject_public_key,       // felt252, STARK-curve public key
///     claim,                    // felt252, short string such as 'ACCREDITED'
///     expires_at,               // u64 widened to felt252, unix seconds
/// ])
/// ```
///
/// The signature fields of [`Credential`] are deliberately *not* part of the preimage — they are
/// the signature over it.
///
/// Note what this binds and what it does not. The hash covers the whole attestation, so an issuer
/// cannot have a claim, a subject or an expiry swapped underneath their signature. It does not
/// bind a chain id or a verifier address: a Cordon credential is a portable statement about a
/// subject, valid at any gate that trusts the same issuer registry. Scoping is the policy's job.
pub fn credential_hash(credential: @Credential) -> felt252 {
    poseidon_hash_span(
        [
            domain_separation::CREDENTIAL_TAG, *credential.issuer_id, *credential.credential_id,
            *credential.subject_public_key, *credential.claim, (*credential.expires_at).into(),
        ]
            .span(),
    )
}

/// The message a subject signs to authorise one specific settlement.
///
/// ```text
/// subject_action_hash = poseidon_hash_span([
///     'CORDON_SUBJECT_ACTION:V1',  // domain tag
///     policy_id,                   // felt252
///     note_id,                     // felt252, the open note the pool will fill
///     token,                       // ContractAddress widened to felt252
///     amount,                      // u128 widened to felt252, in token base units
///     nonce,                       // felt252, chosen by the subject
/// ])
/// ```
///
/// Holding a credential is not the same as authorising a payment: the credential says who the
/// subject is, and this signature says that *this* subject wants *this* value moved under *this*
/// policy, once. `amount` is the plaintext balance the pool handed the gate, so a relayer cannot
/// inflate a settlement past what the subject signed for, and `nonce` — consumed per
/// `(subject_public_key, nonce)` — is what makes it once.
pub fn subject_action_hash(
    policy_id: felt252, note_id: felt252, token: ContractAddress, amount: u128, nonce: felt252,
) -> felt252 {
    poseidon_hash_span(
        [
            domain_separation::SUBJECT_ACTION_TAG, policy_id, note_id, token.into(), amount.into(),
            nonce,
        ]
            .span(),
    )
}
