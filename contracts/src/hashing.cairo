//! Hash preimages.
//!
//! These functions define what an issuer and a subject actually sign. An off-chain SDK has to
//! reproduce them exactly — a single reordered field turns every signature into a
//! `CORDON_BAD_CRED` — so the preimages are a public contract, mirrored in `HASHING.md` and
//! pinned by fixture tests in `tests::test_hashing`.
//!
//! Every hash is Poseidon over a flat `felt252` span whose first element is a domain-separation
//! tag. Tags follow the pool's own convention, `<PURPOSE>:V<VERSION>`, so a field change is a new
//! tag rather than a silent reinterpretation of signatures already in circulation.
//!
//! ## What an authorisation binds, and why
//!
//! A signed action names the **whole** transaction it authorises: the chain, the gate, the pool
//! that will pull the value, which leg is being run, the policy, the note, the token, the amount,
//! a single-use nonce, and — for a settlement — every term of it.
//!
//! It is worth being precise about why all of that is necessary, because an earlier version of
//! this file argued otherwise. `:V2` left the leg and the settlement terms out and justified it
//! with the shared nonce registry. That argument was wrong. The nonce registry stops a signature
//! being used a *second* time; it says nothing about the *first* use being the wrong one. A payer
//! who signed a `Direct` payment into their own note had, under `:V2`, also unknowingly signed a
//! `Fund` parking that money in an escrow whose id, payee, claim policy and expiry were chosen by
//! whoever assembled the action array. One use, entirely legitimate as far as the nonce was
//! concerned, and the payer's money was gone. `:V3` puts the leg tag and a hash of the settlement
//! terms in the message, so an authorisation means one thing only.
//!
//! ## Why the credential hash is not bound to a deployment
//!
//! The action hash binds the chain id, the gate and the pool. The credential hash binds none of
//! them, deliberately:
//!
//! - A **credential** is a portable statement about a subject — "this pseudonym is accredited".
//!   It is true at every gate that trusts the same issuer, on every network, and binding it to one
//!   deployment would force an issuer to re-attest per venue for no security gain. Scoping a
//!   credential to a use is the policy's job.
//! - An **action authorisation** is the opposite: it says "move this exact value, here, once".

use core::poseidon::poseidon_hash_span;
use starknet::ContractAddress;
use crate::types::{Credential, FundTerms};

/// Domain-separation tags. Template: `CORDON_<PURPOSE>:V<VERSION>`.
pub mod domain_separation {
    /// Tag for the issuer-signed credential hash.
    pub const CREDENTIAL_TAG: felt252 = 'CORDON_CREDENTIAL:V1';
    /// Tag for the subject-signed action hash. `:V2` added the chain id and the gate address;
    /// `:V3` added the pool address, the leg tag and the settlement terms.
    pub const SUBJECT_ACTION_TAG: felt252 = 'CORDON_SUBJECT_ACTION:V3';
    /// Tag for the nested settlement-terms hash carried inside an action hash.
    ///
    /// A nested hash gets its own tag so that its digest can never be mistaken for, or collide
    /// with, a hash of some other structure that happens to have four felts in it.
    pub const SETTLEMENT_TERMS_TAG: felt252 = 'CORDON_SETTLEMENT_TERMS:V1';
}

/// Leg tags. These identify which `GateOperation` an authorisation is for.
///
/// They are short strings rather than the enum's discriminant on purpose: a discriminant is a
/// position, and positions move when someone adds a variant. A tag means the same thing forever,
/// and it is legible in a raw calldata dump.
pub mod legs {
    /// [`GateOperation::Direct`](crate::types::GateOperation::Direct).
    pub const DIRECT: felt252 = 'CORDON_LEG_DIRECT';
    /// [`GateOperation::Fund`](crate::types::GateOperation::Fund).
    pub const FUND: felt252 = 'CORDON_LEG_FUND';
    /// [`GateOperation::Claim`](crate::types::GateOperation::Claim).
    pub const CLAIM: felt252 = 'CORDON_LEG_CLAIM';
    /// [`GateOperation::Refund`](crate::types::GateOperation::Refund).
    pub const REFUND: felt252 = 'CORDON_LEG_REFUND';
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
/// the signature over it. The hash covers the whole attestation, so an issuer cannot have a claim,
/// a subject or an expiry swapped underneath their signature.
pub fn credential_hash(credential: @Credential) -> felt252 {
    poseidon_hash_span(
        [
            domain_separation::CREDENTIAL_TAG, *credential.issuer_id, *credential.credential_id,
            *credential.subject_public_key, *credential.claim, (*credential.expires_at).into(),
        ]
            .span(),
    )
}

/// The terms of a settlement, hashed for inclusion in an action hash.
///
/// ```text
/// settlement_terms_hash = poseidon_hash_span([
///     'CORDON_SETTLEMENT_TERMS:V1',
///     settlement_id,          // felt252
///     payee_subject_key,      // felt252, zero on Claim and Refund
///     payee_claim_policy_id,  // felt252, zero on Claim and Refund
///     expires_at,             // u64 widened to felt252, zero on Claim and Refund
/// ])
/// ```
///
/// `Fund` fills every field. `Claim` and `Refund` fill only `settlement_id` and zero the rest:
/// they do not set terms, they quote an id, and binding that id is what stops one claim signature
/// being valid for any open settlement that happens to share a policy, a token and an amount.
/// `Direct` has no settlement at all and uses a terms hash of literal `0`, not the hash of zeros.
pub fn settlement_terms_hash(
    settlement_id: felt252,
    payee_subject_key: felt252,
    payee_claim_policy_id: felt252,
    expires_at: u64,
) -> felt252 {
    poseidon_hash_span(
        [
            domain_separation::SETTLEMENT_TERMS_TAG, settlement_id, payee_subject_key,
            payee_claim_policy_id, expires_at.into(),
        ]
            .span(),
    )
}

/// The terms hash for a `Fund` leg: every field of [`FundTerms`] the payer chose.
pub fn fund_terms_hash(terms: @FundTerms) -> felt252 {
    settlement_terms_hash(
        *terms.settlement_id,
        *terms.payee_subject_key,
        *terms.payee_claim_policy_id,
        *terms.expires_at,
    )
}

/// The terms hash for a `Claim` or `Refund` leg: the settlement id, and nothing else to choose.
pub fn quoted_settlement_hash(settlement_id: felt252) -> felt252 {
    settlement_terms_hash(settlement_id, 0, 0, 0)
}

/// The message a subject signs to authorise one specific leg, at one specific gate.
///
/// ```text
/// subject_action_hash = poseidon_hash_span([
///     'CORDON_SUBJECT_ACTION:V3',  // domain tag
///     chain_id,                    // felt252, get_tx_info().unbox().chain_id
///     gate_address,                // ContractAddress -> felt252, the verifying PolicyGate
///     pool_address,                // ContractAddress -> felt252, the pool that will pull
///     leg,                         // felt252, one of `legs::*`
///     policy_id,                   // felt252
///     note_id,                     // felt252, the open note to fill (0 on Fund)
///     token,                       // ContractAddress -> felt252
///     amount,                      // u128 -> felt252, token base units
///     nonce,                       // felt252, chosen by the subject
///     terms_hash,                  // felt252, see `settlement_terms_hash`; 0 on Direct
/// ])
/// ```
///
/// Eleven elements. Holding a credential is not the same as authorising a payment: the credential
/// says who the subject is, and this says that this subject wants this value moved, on this leg,
/// under this policy, at this contract, through this pool, once.
///
/// - `chain_id` and `gate_address` stop the signature travelling to another network or another
///   deployment.
/// - `pool_address` stops it being executed against a different pool — and, since the gate only
///   ever approves the pool it was constructed with, keeps the signed message and the actual
///   recipient of the allowance in agreement.
/// - `leg` stops a payment being re-typed as an escrow, or a refund as a payment.
/// - `amount` is the value the subject agreed to move; the gate takes it from the signed
///   authorisation and checks its balance covers it, rather than inferring it from a balance
///   anyone can change.
/// - `terms_hash` covers everything else a settlement decides.
/// - `nonce`, consumed per `(subject_public_key, nonce)` across every leg, makes it once.
pub fn subject_action_hash(
    chain_id: felt252,
    gate_address: ContractAddress,
    pool_address: ContractAddress,
    leg: felt252,
    policy_id: felt252,
    note_id: felt252,
    token: ContractAddress,
    amount: u128,
    nonce: felt252,
    terms_hash: felt252,
) -> felt252 {
    poseidon_hash_span(
        [
            domain_separation::SUBJECT_ACTION_TAG, chain_id, gate_address.into(),
            pool_address.into(), leg, policy_id, note_id, token.into(), amount.into(), nonce,
            terms_hash,
        ]
            .span(),
    )
}
