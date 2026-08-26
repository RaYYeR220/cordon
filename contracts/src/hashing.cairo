//! Hash preimages.
//!
//! These two functions define what an issuer and a subject actually sign. An off-chain SDK has to
//! reproduce them exactly — a single reordered field turns every signature into a
//! `CORDON_BAD_CRED` — so the preimages are a public contract, mirrored in `HASHING.md` and
//! pinned by fixture tests in `tests::test_hashing`.
//!
//! Both hashes are Poseidon over a flat `felt252` span whose first element is a domain-separation
//! tag. The tag is what stops a credential signature from ever being replayed as an action
//! signature (and vice versa), since both are verified against STARK-curve keys that a subject may
//! well control in both roles.
//!
//! Domain tags follow the pool's own convention, `<PURPOSE>:V<VERSION>`, so a field change is a
//! new tag rather than a silent reinterpretation of old signatures.
//!
//! ## Why one is bound to a deployment and the other is not
//!
//! The action hash binds the chain id and the gate address. The credential hash binds neither, and
//! that asymmetry is deliberate:
//!
//! - A **credential** is a portable statement about a subject — "this pseudonym is accredited".
//!   It is true at every gate that trusts the same issuer, on every network, and binding it to one
//!   deployment would force an issuer to re-attest per venue for no security gain. Scoping a
//!   credential to a use is the policy's job.
//! - An **action authorisation** is the opposite: it says "move this exact value, here, once".
//!   Left unbound, the same signature would be replayable against a second Cordon deployment
//!   enforcing the same policy id — a different contract, holding different money. `:V2` closes
//!   that by putting the chain id and the verifying contract inside the signed message.

use core::poseidon::poseidon_hash_span;
use starknet::ContractAddress;
use crate::types::Credential;

/// Domain-separation tags. Template: `CORDON_<PURPOSE>:V<VERSION>`.
pub mod domain_separation {
    /// Tag for the issuer-signed credential hash.
    pub const CREDENTIAL_TAG: felt252 = 'CORDON_CREDENTIAL:V1';
    /// Tag for the subject-signed action hash. `:V2` added the chain id and the gate address.
    pub const SUBJECT_ACTION_TAG: felt252 = 'CORDON_SUBJECT_ACTION:V2';
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
/// The hash covers the whole attestation, so an issuer cannot have a claim, a subject or an expiry
/// swapped underneath their signature. It binds no chain id and no verifier address, on purpose:
/// see the module docs.
pub fn credential_hash(credential: @Credential) -> felt252 {
    poseidon_hash_span(
        [
            domain_separation::CREDENTIAL_TAG, *credential.issuer_id, *credential.credential_id,
            *credential.subject_public_key, *credential.claim, (*credential.expires_at).into(),
        ]
            .span(),
    )
}

/// The message a subject signs to authorise one specific settlement, at one specific gate.
///
/// ```text
/// subject_action_hash = poseidon_hash_span([
///     'CORDON_SUBJECT_ACTION:V2',  // domain tag
///     chain_id,                    // felt252, get_tx_info().unbox().chain_id
///     gate_address,                // ContractAddress widened to felt252, the verifying gate
///     policy_id,                   // felt252
///     note_id,                     // felt252, the open note the pool will fill (0 when funding)
///     token,                       // ContractAddress widened to felt252
///     amount,                      // u128 widened to felt252, in token base units
///     nonce,                       // felt252, chosen by the subject
/// ])
/// ```
///
/// Holding a credential is not the same as authorising a payment: the credential says who the
/// subject is, and this signature says that *this* subject wants *this* value moved under *this*
/// policy, at *this* contract, once.
///
/// `amount` is the plaintext value the gate is moving, so a relayer cannot inflate a settlement
/// past what the subject signed for. `chain_id` and `gate_address` stop the signature being
/// carried to another network or another deployment. `nonce` — consumed per
/// `(subject_public_key, nonce)` across every leg the gate serves — is what makes it once.
///
/// The same preimage serves all four legs (`Direct`, `Fund`, `Claim`, `Refund`); the leg itself is
/// not in the message. It does not need to be, because every leg consumes a nonce against the
/// signing subject's key, so a signature carried from one leg to another always replays its nonce
/// and is refused with `CORDON_NONCE_USED`.
pub fn subject_action_hash(
    chain_id: felt252,
    gate_address: ContractAddress,
    policy_id: felt252,
    note_id: felt252,
    token: ContractAddress,
    amount: u128,
    nonce: felt252,
) -> felt252 {
    poseidon_hash_span(
        [
            domain_separation::SUBJECT_ACTION_TAG, chain_id, gate_address.into(), policy_id,
            note_id, token.into(), amount.into(), nonce,
        ]
            .span(),
    )
}
