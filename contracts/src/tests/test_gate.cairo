//! The gate: one happy path, and every way a settlement is refused.
//!
//! Each refusal gets its own test with its own expected panic code, because "it reverted" is not a
//! result a user can act on — the whole point of the code table is that the UI can say *why*.

use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use snforge_std::signature::stark_curve::{StarkCurveKeyPairImpl, StarkCurveSignerImpl};
use snforge_std::signature::{KeyPair, KeyPairTrait, SignerTrait};
use snforge_std::{
    start_cheat_block_timestamp_global, start_cheat_caller_address, stop_cheat_caller_address,
};
use crate::hashing;
use crate::interfaces::{
    IIssuerRegistryDispatcherTrait, IPolicyGateDispatcherTrait, IPolicyRegistryDispatcherTrait,
    IRevocationRegistryDispatcherTrait,
};
use crate::mocks::mock_pool::IMockPoolDispatcherTrait;
use crate::tests::common::{
    CLAIM, CREDENTIAL_ID, CordonTrait, EPOCH_LENGTH, EXPIRES_AT, IMPOSTER_SECRET, ISSUER_ID,
    MAX_AMOUNT, NONCE, NOTE_ID, OTHER_ISSUER_ID, POLICY_ID, SETTLE_AMOUNT, START_TIME,
    default_policy, issuer_operator, owner, setup, setup_with_policy, stranger,
};
use crate::types::{Credential, OpenNoteDeposit};

/// Signs a credential with `key`, ignoring whatever signature fields it arrives with.
fn sign_credential(key: KeyPair<felt252, felt252>, credential: Credential) -> Credential {
    let mut signed = credential;
    signed.sig_r = 0;
    signed.sig_s = 0;
    let (sig_r, sig_s) = key.sign(hashing::credential_hash(@signed)).unwrap();
    signed.sig_r = sig_r;
    signed.sig_s = sig_s;
    signed
}

//
// Happy path
//

/// The end-to-end shape of a real transaction: the pool transfers in, calls `privacy_invoke`,
/// and pulls the approved amount back out to fill the open note.
#[test]
fn settlement_passes_and_the_pool_reclaims_the_value() {
    let cordon = setup();
    let erc20 = IERC20Dispatcher { contract_address: cordon.token };
    let pool_balance_before = erc20.balance_of(cordon.pool.contract_address);

    let deposits = cordon.settle(SETTLE_AMOUNT);

    assert_eq!(
        deposits,
        [OpenNoteDeposit { note_id: NOTE_ID, token: cordon.token, amount: SETTLE_AMOUNT }].span(),
    );
    // The gate is a conduit, never a vault: it ends every settlement holding nothing.
    assert_eq!(erc20.balance_of(cordon.gate.contract_address), 0);
    assert_eq!(erc20.balance_of(cordon.pool.contract_address), pool_balance_before);
    assert_eq!(cordon.pool.total_deposited(), SETTLE_AMOUNT);
}

#[test]
fn a_passing_settlement_books_the_nonce_and_the_spend() {
    let cordon = setup();
    let subject = cordon.subject_key.public_key;
    let epoch = START_TIME / EPOCH_LENGTH;

    assert!(!cordon.gate.is_nonce_used(subject, NONCE));
    assert_eq!(cordon.gate.epoch_spend(subject, POLICY_ID, epoch), 0);

    cordon.settle(SETTLE_AMOUNT);

    assert!(cordon.gate.is_nonce_used(subject, NONCE));
    assert_eq!(cordon.gate.epoch_spend(subject, POLICY_ID, epoch), SETTLE_AMOUNT);
    assert_eq!(cordon.gate.current_epoch(POLICY_ID), epoch);
}

/// A policy pinned to no particular issuer accepts any active one.
#[test]
fn a_policy_open_to_any_issuer_accepts_the_registered_one() {
    let mut policy = default_policy();
    policy.issuer_id = 0;
    let cordon = setup_with_policy(policy);

    cordon.settle(SETTLE_AMOUNT);

    assert_eq!(cordon.pool.total_deposited(), SETTLE_AMOUNT);
}

/// Zero `max_amount` and zero `epoch_length` mean unlimited, not blocked.
#[test]
fn an_unlimited_policy_settles_and_books_no_epoch_spend() {
    let mut policy = default_policy();
    policy.max_amount = 0;
    policy.epoch_length = 0;
    policy.max_per_epoch = 0;
    let cordon = setup_with_policy(policy);

    cordon.settle(MAX_AMOUNT * 100);

    assert_eq!(cordon.pool.total_deposited(), MAX_AMOUNT * 100);
    assert_eq!(cordon.gate.current_epoch(POLICY_ID), 0);
    assert_eq!(cordon.gate.epoch_spend(cordon.subject_key.public_key, POLICY_ID, 0), 0);
}

#[test]
fn spend_accumulates_across_settlements_inside_one_epoch() {
    let cordon = setup();
    let subject = cordon.subject_key.public_key;
    let epoch = START_TIME / EPOCH_LENGTH;

    cordon.settle_with_nonce(MAX_AMOUNT, 'nonce_a');
    cordon.settle_with_nonce(MAX_AMOUNT, 'nonce_b');

    assert_eq!(cordon.gate.epoch_spend(subject, POLICY_ID, epoch), MAX_AMOUNT * 2);
}

//
// Negative control
//
// If the refusal tests below were vacuous — say the gate ignored signatures entirely — this
// test would pass too, and the suite would be worthless. It differs from `settlement_passes` by
// exactly one bit.
//

#[test]
#[should_panic(expected: 'CORDON_BAD_CRED')]
fn one_flipped_bit_in_the_issuer_signature_is_refused() {
    let cordon = setup();

    let mut credential = cordon.credential();
    credential.sig_r = credential.sig_r + 1;

    let (payer_sig_r, payer_sig_s) = cordon.sign_action(SETTLE_AMOUNT, NONCE, NOTE_ID);
    cordon.settle_raw(SETTLE_AMOUNT, credential, payer_sig_r, payer_sig_s, NONCE);
}

#[test]
#[should_panic(expected: 'CORDON_BAD_SUBJECT_SIG')]
fn one_flipped_bit_in_the_subject_signature_is_refused() {
    let cordon = setup();

    let credential = cordon.credential();
    let (payer_sig_r, payer_sig_s) = cordon.sign_action(SETTLE_AMOUNT, NONCE, NOTE_ID);
    cordon.settle_raw(SETTLE_AMOUNT, credential, payer_sig_r + 1, payer_sig_s, NONCE);
}

//
// Refusals, in enforcement order
//

/// 1. Nobody but the pool drives the gate. Anyone else would be gating tokens they sent
///    themselves, which proves nothing.
#[test]
#[should_panic(expected: 'CORDON_BAD_POOL')]
fn a_direct_call_from_a_non_pool_caller_is_refused() {
    let cordon = setup();

    let credential = cordon.credential();
    let (payer_sig_r, payer_sig_s) = cordon.sign_action(SETTLE_AMOUNT, NONCE, NOTE_ID);

    start_cheat_caller_address(cordon.gate.contract_address, stranger());
    cordon
        .gate
        .privacy_invoke(
            cordon.token,
            cordon.pool.contract_address,
            NOTE_ID,
            POLICY_ID,
            credential,
            payer_sig_r,
            payer_sig_s,
            NONCE,
        );
}

/// 1b. The wallet substitutes `${poolAddress}`; the gate refuses to trust a substitution that
///     does not match who is actually calling.
#[test]
#[should_panic(expected: 'CORDON_BAD_POOL')]
fn a_pool_address_that_is_not_the_caller_is_refused() {
    let cordon = setup();

    let credential = cordon.credential();
    let (payer_sig_r, payer_sig_s) = cordon.sign_action(SETTLE_AMOUNT, NONCE, NOTE_ID);

    cordon
        .pool
        .settle(
            gate: cordon.gate.contract_address,
            token: cordon.token,
            amount: SETTLE_AMOUNT.into(),
            claimed_pool_address: stranger(),
            note_id: NOTE_ID,
            policy_id: POLICY_ID,
            payer: credential,
            :payer_sig_r,
            :payer_sig_s,
            nonce: NONCE,
        );
}

/// 2. A retired policy stops settling immediately.
#[test]
#[should_panic(expected: 'CORDON_NO_POLICY')]
fn a_retired_policy_is_refused() {
    let cordon = setup();

    start_cheat_caller_address(cordon.policy_registry.contract_address, owner());
    cordon.policy_registry.retire_policy(POLICY_ID);
    stop_cheat_caller_address(cordon.policy_registry.contract_address);

    cordon.settle(SETTLE_AMOUNT);
}

/// 2b. This entrypoint carries no payee credential, so a policy that needs one fails closed
///     rather than silently dropping the requirement.
#[test]
#[should_panic(expected: 'CORDON_PAYEE_REQUIRED')]
fn a_policy_needing_a_payee_credential_is_refused() {
    let mut policy = default_policy();
    policy.require_payee_credential = true;
    let cordon = setup_with_policy(policy);

    cordon.settle(SETTLE_AMOUNT);
}

/// 3. The pool sending nothing is a malformed action, not a free pass.
#[test]
#[should_panic(expected: 'CORDON_NO_VALUE')]
fn a_zero_value_settlement_is_refused() {
    let cordon = setup();

    cordon.settle(0);
}

/// 4. Deactivating an issuer invalidates its whole book at once.
#[test]
#[should_panic(expected: 'CORDON_BAD_ISSUER')]
fn a_deactivated_issuer_is_refused() {
    let cordon = setup();

    start_cheat_caller_address(cordon.issuer_registry.contract_address, owner());
    cordon.issuer_registry.deactivate_issuer(ISSUER_ID);
    stop_cheat_caller_address(cordon.issuer_registry.contract_address);

    cordon.settle(SETTLE_AMOUNT);
}

/// 4b. A credential from an issuer nobody registered.
#[test]
#[should_panic(expected: 'CORDON_BAD_ISSUER')]
fn an_unknown_issuer_is_refused() {
    let cordon = setup();

    let mut credential = cordon.credential();
    credential.issuer_id = OTHER_ISSUER_ID;
    let (payer_sig_r, payer_sig_s) = cordon.sign_action(SETTLE_AMOUNT, NONCE, NOTE_ID);

    cordon.settle_raw(SETTLE_AMOUNT, credential, payer_sig_r, payer_sig_s, NONCE);
}

/// 4c. A policy pinned to one issuer does not accept another issuer's credential, however valid.
#[test]
#[should_panic(expected: 'CORDON_BAD_ISSUER')]
fn a_credential_from_an_issuer_the_policy_does_not_pin_is_refused() {
    let cordon = setup();

    // Register a second, entirely legitimate issuer and have it attest the same claim.
    let other_key = KeyPairTrait::<felt252, felt252>::from_secret_key(IMPOSTER_SECRET);
    start_cheat_caller_address(cordon.issuer_registry.contract_address, owner());
    cordon.issuer_registry.register_issuer(OTHER_ISSUER_ID, other_key.public_key, "ipfs://other");
    stop_cheat_caller_address(cordon.issuer_registry.contract_address);

    let credential = sign_credential(
        other_key,
        Credential {
            issuer_id: OTHER_ISSUER_ID,
            credential_id: CREDENTIAL_ID,
            subject_public_key: cordon.subject_key.public_key,
            claim: CLAIM,
            expires_at: EXPIRES_AT,
            sig_r: 0,
            sig_s: 0,
        },
    );

    let (payer_sig_r, payer_sig_s) = cordon.sign_action(SETTLE_AMOUNT, NONCE, NOTE_ID);
    cordon.settle_raw(SETTLE_AMOUNT, credential, payer_sig_r, payer_sig_s, NONCE);
}

/// 5. A credential signed by anyone but the registered issuer key.
#[test]
#[should_panic(expected: 'CORDON_BAD_CRED')]
fn a_forged_issuer_signature_is_refused() {
    let cordon = setup();

    let imposter = KeyPairTrait::<felt252, felt252>::from_secret_key(IMPOSTER_SECRET);
    let credential = cordon.credential_signed_by(imposter, CLAIM, EXPIRES_AT);
    let (payer_sig_r, payer_sig_s) = cordon.sign_action(SETTLE_AMOUNT, NONCE, NOTE_ID);

    cordon.settle_raw(SETTLE_AMOUNT, credential, payer_sig_r, payer_sig_s, NONCE);
}

/// 5b. Editing a field after signing breaks the hash the signature covers.
#[test]
#[should_panic(expected: 'CORDON_BAD_CRED')]
fn extending_the_expiry_after_signing_is_refused() {
    let cordon = setup();

    let mut credential = cordon.credential();
    credential.expires_at = EXPIRES_AT * 2;
    let (payer_sig_r, payer_sig_s) = cordon.sign_action(SETTLE_AMOUNT, NONCE, NOTE_ID);

    cordon.settle_raw(SETTLE_AMOUNT, credential, payer_sig_r, payer_sig_s, NONCE);
}

/// 6. A properly signed credential that has simply run out.
#[test]
#[should_panic(expected: 'CORDON_EXPIRED')]
fn an_expired_credential_is_refused() {
    let cordon = setup();

    let credential = cordon.credential_signed_by(cordon.issuer_key, CLAIM, START_TIME - 1);
    let (payer_sig_r, payer_sig_s) = cordon.sign_action(SETTLE_AMOUNT, NONCE, NOTE_ID);

    cordon.settle_raw(SETTLE_AMOUNT, credential, payer_sig_r, payer_sig_s, NONCE);
}

/// 7. Revocation is how an issuer withdraws an attestation before it expires.
#[test]
#[should_panic(expected: 'CORDON_REVOKED')]
fn a_revoked_credential_is_refused() {
    let cordon = setup();

    start_cheat_caller_address(cordon.revocation_registry.contract_address, issuer_operator());
    cordon.revocation_registry.revoke(ISSUER_ID, CREDENTIAL_ID);
    stop_cheat_caller_address(cordon.revocation_registry.contract_address);

    cordon.settle(SETTLE_AMOUNT);
}

/// 8. A perfectly valid credential for the wrong thing.
#[test]
#[should_panic(expected: 'CORDON_CLAIM_MISMATCH')]
fn the_wrong_claim_is_refused() {
    let cordon = setup();

    let credential = cordon.credential_signed_by(cordon.issuer_key, 'KYC_L2', EXPIRES_AT);
    let (payer_sig_r, payer_sig_s) = cordon.sign_action(SETTLE_AMOUNT, NONCE, NOTE_ID);

    cordon.settle_raw(SETTLE_AMOUNT, credential, payer_sig_r, payer_sig_s, NONCE);
}

/// 9. Holding a credential is not authorising a payment. A relayer that inflates the amount past
///    what the subject signed for is refused.
#[test]
#[should_panic(expected: 'CORDON_BAD_SUBJECT_SIG')]
fn an_amount_the_subject_did_not_sign_for_is_refused() {
    let cordon = setup();

    let credential = cordon.credential();
    let (payer_sig_r, payer_sig_s) = cordon.sign_action(SETTLE_AMOUNT, NONCE, NOTE_ID);

    cordon.settle_raw(SETTLE_AMOUNT + 1, credential, payer_sig_r, payer_sig_s, NONCE);
}

/// 9b. A signature over a different note is not a signature over this one.
#[test]
#[should_panic(expected: 'CORDON_BAD_SUBJECT_SIG')]
fn a_signature_bound_to_another_note_is_refused() {
    let cordon = setup();

    let credential = cordon.credential();
    let (payer_sig_r, payer_sig_s) = cordon.sign_action(SETTLE_AMOUNT, NONCE, 'note_9');

    cordon.settle_raw(SETTLE_AMOUNT, credential, payer_sig_r, payer_sig_s, NONCE);
}

/// 9c. Nonce replay: the second settlement under the same nonce is refused even though every
///     signature still verifies.
#[test]
#[should_panic(expected: 'CORDON_NONCE_USED')]
fn a_reused_nonce_is_refused() {
    let cordon = setup();

    cordon.settle(SETTLE_AMOUNT);
    cordon.settle(SETTLE_AMOUNT);
}

/// 10. The hero revert: fully credentialed, correctly signed, simply too large.
#[test]
#[should_panic(expected: 'CORDON_OVER_CAP')]
fn a_settlement_over_the_per_transaction_cap_is_refused() {
    let cordon = setup();

    cordon.settle(MAX_AMOUNT + 1);
}

/// 11. Three settlements that each fit the cap, whose sum does not fit the epoch.
#[test]
#[should_panic(expected: 'CORDON_OVER_VELOCITY')]
fn exceeding_the_epoch_aggregate_is_refused() {
    let cordon = setup();

    cordon.settle_with_nonce(MAX_AMOUNT, 'nonce_a');
    cordon.settle_with_nonce(MAX_AMOUNT, 'nonce_b');
    cordon.settle_with_nonce(MAX_AMOUNT, 'nonce_c');
}

//
// Epoch rollover
//

/// Velocity is a rate, not a lifetime budget: the same spend that overflows one epoch fits
/// comfortably in the next.
#[test]
fn spend_resets_when_the_epoch_advances() {
    let cordon = setup();
    let subject = cordon.subject_key.public_key;
    let first_epoch = START_TIME / EPOCH_LENGTH;

    cordon.settle_with_nonce(MAX_AMOUNT, 'nonce_a');
    cordon.settle_with_nonce(MAX_AMOUNT, 'nonce_b');
    assert_eq!(cordon.gate.epoch_spend(subject, POLICY_ID, first_epoch), MAX_AMOUNT * 2);

    start_cheat_block_timestamp_global(START_TIME + EPOCH_LENGTH);
    let second_epoch = (START_TIME + EPOCH_LENGTH) / EPOCH_LENGTH;
    assert_ne!(second_epoch, first_epoch);
    assert_eq!(cordon.gate.current_epoch(POLICY_ID), second_epoch);

    // A third `MAX_AMOUNT` would have blown the 2_500 aggregate in the first epoch.
    cordon.settle_with_nonce(MAX_AMOUNT, 'nonce_c');

    assert_eq!(cordon.gate.epoch_spend(subject, POLICY_ID, second_epoch), MAX_AMOUNT);
    assert_eq!(cordon.gate.epoch_spend(subject, POLICY_ID, first_epoch), MAX_AMOUNT * 2);
}

/// Rolling into a new epoch does not forgive a nonce. Replay protection is for the lifetime of the
/// gate; the epoch only governs how much value flows.
#[test]
#[should_panic(expected: 'CORDON_NONCE_USED')]
fn a_new_epoch_does_not_free_a_spent_nonce() {
    let cordon = setup();

    cordon.settle(SETTLE_AMOUNT);
    start_cheat_block_timestamp_global(START_TIME + EPOCH_LENGTH * 10);
    cordon.settle(SETTLE_AMOUNT);
}

//
// Admin surface
//

#[test]
fn the_gate_reports_the_registries_it_trusts() {
    let cordon = setup();

    let (issuer, revocation, policy) = cordon.gate.registries();
    assert_eq!(issuer, cordon.issuer_registry.contract_address);
    assert_eq!(revocation, cordon.revocation_registry.contract_address);
    assert_eq!(policy, cordon.policy_registry.contract_address);
}

#[test]
#[should_panic(expected: 'Caller is not the owner')]
fn stranger_cannot_repoint_the_gate_registries() {
    let cordon = setup();

    start_cheat_caller_address(cordon.gate.contract_address, stranger());
    cordon.gate.set_registries(stranger(), stranger(), stranger());
}
