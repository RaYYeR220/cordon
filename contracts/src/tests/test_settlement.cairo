//! Two-step settlement: `Fund`, then `Claim` by the payee or `Refund` to the payer.
//!
//! The payer cannot vouch for the payee — the gate never sees the `transfer(OPEN)` recipient —
//! so payee compliance can only be enforced at the moment the payee takes the money, with the
//! payee's own key. These tests are about the invariants that makes necessary: value is released
//! exactly once, to exactly one of two parties, and only against a credential that still holds.

use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use snforge_std::{
    start_cheat_block_timestamp_global, start_cheat_caller_address, stop_cheat_caller_address,
};
use crate::interfaces::{
    IIssuerRegistryDispatcherTrait, IPolicyGateDispatcherTrait, IPolicyRegistryDispatcherTrait,
    IRevocationRegistryDispatcherTrait,
};
use crate::mocks::mock_pool::IMockPoolDispatcherTrait;
use crate::tests::common::{
    CLAIM_POLICY_ID, CLAIM_WINDOW, CordonTrait, EPOCH_LENGTH, EXPIRES_AT, ISSUER_ID, MAX_AMOUNT,
    MAX_PER_EPOCH, NOTE_ID, PAYEE_CLAIM, PAYEE_CREDENTIAL_ID, PAYEE_NONCE, PAYEE_NOTE_ID, POLICY_ID,
    SETTLEMENT_EXPIRES_AT, SETTLEMENT_ID, SETTLE_AMOUNT, START_TIME, default_claim_policy,
    default_policy, issuer_operator, owner, setup, setup_with_policies, setup_with_policy, stranger,
};
use crate::types::{OpenNoteDeposit, SettlementStatus};

const OTHER_SETTLEMENT_ID: felt252 = 'stl_1';

//
// Funding
//

/// The funding leg returns an empty span, which is what tells the pool to leave the value here.
/// The action array is `withdraw → invoke`: there is no open note yet, because there is no payee
/// yet.
#[test]
fn funding_parks_the_value_with_the_gate() {
    let cordon = setup();
    let erc20 = IERC20Dispatcher { contract_address: cordon.token };

    let deposits = cordon.fund(SETTLE_AMOUNT);

    assert_eq!(deposits.len(), 0);
    assert_eq!(erc20.balance_of(cordon.gate.contract_address), SETTLE_AMOUNT.into());
    assert_eq!(cordon.gate.committed_balance(cordon.token), SETTLE_AMOUNT);
    assert_eq!(cordon.pool.total_deposited(), 0);

    let settlement = cordon.gate.get_settlement(SETTLEMENT_ID);
    assert_eq!(settlement.status, SettlementStatus::Funded);
    assert_eq!(settlement.token, cordon.token);
    assert_eq!(settlement.amount, SETTLE_AMOUNT);
    assert_eq!(settlement.payer_subject_key, cordon.subject_key.public_key);
    assert_eq!(settlement.payer_policy_id, POLICY_ID);
    assert_eq!(settlement.payee_claim_policy_id, CLAIM_POLICY_ID);
    assert_eq!(settlement.expires_at, SETTLEMENT_EXPIRES_AT);
}

/// Funding enforces the payer's policy in full — the cap is not relaxed just because the value is
/// going into escrow rather than straight to a payee.
#[test]
#[should_panic(expected: 'CORDON_OVER_CAP')]
fn funding_over_the_payer_cap_is_refused() {
    let cordon = setup();

    cordon.fund(MAX_AMOUNT + 1);
}

#[test]
#[should_panic(expected: 'CORDON_OVER_VELOCITY')]
fn funding_past_the_payer_velocity_is_refused() {
    let cordon = setup();

    cordon.fund_terms('stl_a', MAX_AMOUNT, CLAIM_POLICY_ID, SETTLEMENT_EXPIRES_AT, 'n_a');
    cordon.fund_terms('stl_b', MAX_AMOUNT, CLAIM_POLICY_ID, SETTLEMENT_EXPIRES_AT, 'n_b');
    cordon.fund_terms('stl_c', MAX_AMOUNT, CLAIM_POLICY_ID, SETTLEMENT_EXPIRES_AT, 'n_c');
}

#[test]
#[should_panic(expected: 'CORDON_REVOKED')]
fn a_revoked_payer_cannot_fund() {
    let cordon = setup();

    start_cheat_caller_address(cordon.revocation_registry.contract_address, issuer_operator());
    cordon.revocation_registry.revoke(ISSUER_ID, crate::tests::common::CREDENTIAL_ID);
    stop_cheat_caller_address(cordon.revocation_registry.contract_address);

    cordon.fund(SETTLE_AMOUNT);
}

/// A policy that demands a payee credential is exactly what two-step settlement is for. `Direct`
/// refuses it; `Fund` welcomes it, because the claim leg will supply one.
#[test]
fn a_policy_needing_a_payee_credential_can_be_funded() {
    let mut policy = default_policy();
    policy.require_payee_credential = true;
    let cordon = setup_with_policy(policy);

    cordon.fund(SETTLE_AMOUNT);

    assert_eq!(cordon.gate.get_settlement(SETTLEMENT_ID).status, SettlementStatus::Funded);
}

/// Funding into a claim policy nobody can satisfy would strand the value until the refund window
/// opened, so it is caught before the money commits.
#[test]
#[should_panic(expected: 'CORDON_NO_POLICY')]
fn funding_against_an_unpublished_claim_policy_is_refused() {
    let cordon = setup();

    cordon.fund_terms(SETTLEMENT_ID, SETTLE_AMOUNT, 'NEVER_PUBLISHED', SETTLEMENT_EXPIRES_AT, 'n');
}

#[test]
#[should_panic(expected: 'CORDON_NO_POLICY')]
fn funding_against_a_retired_claim_policy_is_refused() {
    let cordon = setup();

    start_cheat_caller_address(cordon.policy_registry.contract_address, owner());
    cordon.policy_registry.retire_policy(CLAIM_POLICY_ID);
    stop_cheat_caller_address(cordon.policy_registry.contract_address);

    cordon.fund(SETTLE_AMOUNT);
}

#[test]
#[should_panic(expected: 'CORDON_BAD_EXPIRY')]
fn a_claim_window_that_closed_in_the_past_is_refused() {
    let cordon = setup();

    cordon.fund_terms(SETTLEMENT_ID, SETTLE_AMOUNT, CLAIM_POLICY_ID, START_TIME - 1, 'n');
}

#[test]
#[should_panic(expected: 'CORDON_ZERO_SETTLEMENT')]
fn settlement_id_zero_is_reserved() {
    let cordon = setup();

    cordon.fund_terms(0, SETTLE_AMOUNT, CLAIM_POLICY_ID, SETTLEMENT_EXPIRES_AT, 'n');
}

#[test]
#[should_panic(expected: 'CORDON_SETTLEMENT_EXISTS')]
fn an_open_settlement_id_cannot_be_reused() {
    let cordon = setup();

    cordon.fund_terms(SETTLEMENT_ID, SETTLE_AMOUNT, CLAIM_POLICY_ID, SETTLEMENT_EXPIRES_AT, 'n_a');
    cordon.fund_terms(SETTLEMENT_ID, SETTLE_AMOUNT, CLAIM_POLICY_ID, SETTLEMENT_EXPIRES_AT, 'n_b');
}

/// A settled id stays burned. Reusing one would let a stale claim signature — made for the first
/// settlement — be pointed at the second.
#[test]
#[should_panic(expected: 'CORDON_SETTLEMENT_EXISTS')]
fn a_claimed_settlement_id_cannot_be_reused() {
    let cordon = setup();

    cordon.fund(SETTLE_AMOUNT);
    cordon.claim(SETTLE_AMOUNT);
    cordon.fund_terms(SETTLEMENT_ID, SETTLE_AMOUNT, CLAIM_POLICY_ID, SETTLEMENT_EXPIRES_AT, 'n_b');
}

#[test]
#[should_panic(expected: 'CORDON_SETTLEMENT_EXISTS')]
fn a_refunded_settlement_id_cannot_be_reused() {
    let cordon = setup();

    cordon.fund(SETTLE_AMOUNT);
    start_cheat_block_timestamp_global(SETTLEMENT_EXPIRES_AT);
    cordon.refund(SETTLE_AMOUNT);
    cordon.fund_terms(SETTLEMENT_ID, SETTLE_AMOUNT, CLAIM_POLICY_ID, SETTLEMENT_EXPIRES_AT, 'n_b');
}

/// The gate holding one settlement must not read that value as new money on the next funding leg.
#[test]
fn a_second_settlement_does_not_see_the_first_ones_value() {
    let cordon = setup();

    cordon.fund_terms(SETTLEMENT_ID, SETTLE_AMOUNT, CLAIM_POLICY_ID, SETTLEMENT_EXPIRES_AT, 'n_a');
    cordon
        .fund_terms(
            OTHER_SETTLEMENT_ID, SETTLE_AMOUNT, CLAIM_POLICY_ID, SETTLEMENT_EXPIRES_AT, 'n_b',
        );

    assert_eq!(cordon.gate.get_settlement(SETTLEMENT_ID).amount, SETTLE_AMOUNT);
    assert_eq!(cordon.gate.get_settlement(OTHER_SETTLEMENT_ID).amount, SETTLE_AMOUNT);
    assert_eq!(cordon.gate.committed_balance(cordon.token), SETTLE_AMOUNT * 2);
}

/// The same guard the other way round: a direct settlement alongside an open one is measured on
/// what the pool just sent, not on the gate's whole balance.
#[test]
fn a_direct_settlement_alongside_an_open_one_is_measured_correctly() {
    let cordon = setup();

    cordon.fund_terms(SETTLEMENT_ID, SETTLE_AMOUNT, CLAIM_POLICY_ID, SETTLEMENT_EXPIRES_AT, 'n_a');
    let deposits = cordon.settle_with_nonce(SETTLE_AMOUNT, 'n_b');

    assert_eq!(
        deposits,
        [OpenNoteDeposit { note_id: NOTE_ID, token: cordon.token, amount: SETTLE_AMOUNT }].span(),
    );
    assert_eq!(cordon.gate.committed_balance(cordon.token), SETTLE_AMOUNT);
}

//
// Claiming — the money shot
//

/// The payee proves, with their own key and their own credential, that they satisfy the claim
/// policy, and the value moves into their note.
#[test]
fn a_credentialed_payee_can_claim() {
    let cordon = setup();
    let erc20 = IERC20Dispatcher { contract_address: cordon.token };

    cordon.fund(SETTLE_AMOUNT);
    let deposits = cordon.claim(SETTLE_AMOUNT);

    assert_eq!(
        deposits,
        [OpenNoteDeposit { note_id: PAYEE_NOTE_ID, token: cordon.token, amount: SETTLE_AMOUNT }]
            .span(),
    );
    assert_eq!(cordon.gate.get_settlement(SETTLEMENT_ID).status, SettlementStatus::Claimed);
    // The gate is a conduit, never a vault: it ends the flow holding nothing.
    assert_eq!(erc20.balance_of(cordon.gate.contract_address), 0);
    assert_eq!(cordon.gate.committed_balance(cordon.token), 0);
    assert_eq!(cordon.pool.total_deposited(), SETTLE_AMOUNT);
}

/// **The negative control for payee compliance.** Same funding, same payee, same claim
/// transaction — the only difference from `a_credentialed_payee_can_claim` is that the issuer
/// revoked the payee's credential in between. The money does not move, and the refusal is on
/// chain.
#[test]
#[should_panic(expected: 'CORDON_REVOKED')]
fn a_payee_revoked_between_funding_and_claiming_cannot_take_the_money() {
    let cordon = setup();

    cordon.fund(SETTLE_AMOUNT);

    start_cheat_caller_address(cordon.revocation_registry.contract_address, issuer_operator());
    cordon.revocation_registry.revoke(ISSUER_ID, PAYEE_CREDENTIAL_ID);
    stop_cheat_caller_address(cordon.revocation_registry.contract_address);

    cordon.claim(SETTLE_AMOUNT);
}

/// Revoking the payer's credential does not strand the payee: the claim leg is about the payee.
#[test]
fn revoking_the_payer_after_funding_does_not_block_the_payee() {
    let cordon = setup();

    cordon.fund(SETTLE_AMOUNT);

    start_cheat_caller_address(cordon.revocation_registry.contract_address, issuer_operator());
    cordon.revocation_registry.revoke(ISSUER_ID, crate::tests::common::CREDENTIAL_ID);
    stop_cheat_caller_address(cordon.revocation_registry.contract_address);

    cordon.claim(SETTLE_AMOUNT);

    assert_eq!(cordon.gate.get_settlement(SETTLEMENT_ID).status, SettlementStatus::Claimed);
}

#[test]
#[should_panic(expected: 'CORDON_BAD_ISSUER')]
fn a_payee_whose_issuer_was_deactivated_cannot_claim() {
    let cordon = setup();

    cordon.fund(SETTLE_AMOUNT);

    start_cheat_caller_address(cordon.issuer_registry.contract_address, owner());
    cordon.issuer_registry.deactivate_issuer(ISSUER_ID);
    stop_cheat_caller_address(cordon.issuer_registry.contract_address);

    cordon.claim(SETTLE_AMOUNT);
}

/// The payer's credential is not a claim credential. Presenting it here fails the claim policy's
/// required claim, which is the whole point of naming a separate policy at funding time.
#[test]
#[should_panic(expected: 'CORDON_CLAIM_MISMATCH')]
fn a_payee_with_the_wrong_claim_cannot_claim() {
    let cordon = setup();

    cordon.fund(SETTLE_AMOUNT);

    let wrong = cordon
        .sign_credential(
            cordon.issuer_key,
            PAYEE_CREDENTIAL_ID,
            cordon.payee_key.public_key,
            'ACCREDITED',
            EXPIRES_AT,
        );
    cordon.claim_with(wrong, SETTLEMENT_ID, SETTLE_AMOUNT, PAYEE_NONCE);
}

#[test]
#[should_panic(expected: 'CORDON_EXPIRED')]
fn a_payee_with_a_lapsed_credential_cannot_claim() {
    let cordon = setup();

    cordon.fund(SETTLE_AMOUNT);

    let lapsed = cordon
        .sign_credential(
            cordon.issuer_key,
            PAYEE_CREDENTIAL_ID,
            cordon.payee_key.public_key,
            PAYEE_CLAIM,
            START_TIME - 1,
        );
    cordon.claim_with(lapsed, SETTLEMENT_ID, SETTLE_AMOUNT, PAYEE_NONCE);
}

/// A credential naming somebody else's pseudonym is not a credential the claimant can use: the
/// action signature is checked against the key the credential names.
#[test]
#[should_panic(expected: 'CORDON_BAD_SUBJECT_SIG')]
fn a_payee_cannot_claim_with_someone_elses_credential() {
    let cordon = setup();

    cordon.fund(SETTLE_AMOUNT);

    let not_theirs = cordon
        .sign_credential(
            cordon.issuer_key,
            PAYEE_CREDENTIAL_ID,
            cordon.subject_key.public_key,
            PAYEE_CLAIM,
            EXPIRES_AT,
        );
    cordon.claim_with(not_theirs, SETTLEMENT_ID, SETTLE_AMOUNT, PAYEE_NONCE);
}

/// The claim policy's cap applies to the payee. A receiving limit is a real control, and honouring
/// it for a payer while ignoring it for a payee would be a silently dropped check.
#[test]
#[should_panic(expected: 'CORDON_OVER_CAP')]
fn a_claim_over_the_payee_cap_is_refused() {
    let mut claim_policy = default_policy();
    claim_policy.required_claim = PAYEE_CLAIM;
    claim_policy.max_amount = SETTLE_AMOUNT - 1;
    let cordon = crate::tests::common::setup_with_policies(default_policy(), claim_policy);

    cordon.fund(SETTLE_AMOUNT);
    cordon.claim(SETTLE_AMOUNT);
}

/// Likewise the payee's velocity: two claims that each fit the cap but together overrun the epoch.
#[test]
#[should_panic(expected: 'CORDON_OVER_VELOCITY')]
fn claims_past_the_payee_velocity_are_refused() {
    // Widen the payer's epoch first, so the only budget the third claim can exhaust is the
    // payee's. With the fixture payer policy this test would pass for the wrong reason — the
    // payer would run out of epoch before the payee did.
    let mut generous_payer = default_policy();
    generous_payer.max_per_epoch = MAX_AMOUNT * 10;
    let cordon = setup_with_policies(generous_payer, default_claim_policy());
    let epoch = START_TIME / EPOCH_LENGTH;

    cordon.fund_terms('stl_a', MAX_AMOUNT, CLAIM_POLICY_ID, SETTLEMENT_EXPIRES_AT, 'n_a');
    cordon.fund_terms('stl_b', MAX_AMOUNT, CLAIM_POLICY_ID, SETTLEMENT_EXPIRES_AT, 'n_b');
    cordon.fund_terms('stl_c', MAX_AMOUNT, CLAIM_POLICY_ID, SETTLEMENT_EXPIRES_AT, 'n_c');

    cordon.claim_with(cordon.payee_credential(), 'stl_a', MAX_AMOUNT, 'p_a');
    cordon.claim_with(cordon.payee_credential(), 'stl_b', MAX_AMOUNT, 'p_b');

    // Two claims booked `MAX_AMOUNT` each against the payee: 2_000 of a 2_500 epoch. A third does
    // not fit, even though it sits comfortably inside the per-transaction cap.
    assert_eq!(
        cordon.gate.epoch_spend(cordon.payee_key.public_key, CLAIM_POLICY_ID, epoch),
        MAX_AMOUNT * 2,
    );
    assert!(MAX_AMOUNT * 3 > MAX_PER_EPOCH);

    cordon.claim_with(cordon.payee_credential(), 'stl_c', MAX_AMOUNT, 'p_c');
}

#[test]
#[should_panic(expected: 'CORDON_ALREADY_CLAIMED')]
fn a_settlement_cannot_be_claimed_twice() {
    let cordon = setup();

    cordon.fund(SETTLE_AMOUNT);
    cordon.claim_with(cordon.payee_credential(), SETTLEMENT_ID, SETTLE_AMOUNT, 'p_a');
    cordon.claim_with(cordon.payee_credential(), SETTLEMENT_ID, SETTLE_AMOUNT, 'p_b');
}

#[test]
#[should_panic(expected: 'CORDON_NO_SETTLEMENT')]
fn claiming_an_unknown_settlement_is_refused() {
    let cordon = setup();

    cordon.fund(SETTLE_AMOUNT);
    cordon.claim_with(cordon.payee_credential(), 'never_funded', SETTLE_AMOUNT, PAYEE_NONCE);
}

#[test]
#[should_panic(expected: 'CORDON_CLAIM_EXPIRED')]
fn claiming_after_the_window_closed_is_refused() {
    let cordon = setup();

    cordon.fund(SETTLE_AMOUNT);
    start_cheat_block_timestamp_global(SETTLEMENT_EXPIRES_AT);
    cordon.claim(SETTLE_AMOUNT);
}

/// The claim leg carries no withdraw. Tokens arriving alongside it mean the caller built the wrong
/// action array, and letting it pass would strand the surplus in the gate.
#[test]
#[should_panic(expected: 'CORDON_UNEXPECTED_VALUE')]
fn a_claim_the_pool_funded_is_refused() {
    let cordon = setup();

    cordon.fund(SETTLE_AMOUNT);

    let credential = cordon.payee_credential();
    let (sig_r, sig_s) = cordon
        .sign_action_as(
            cordon.payee_key, CLAIM_POLICY_ID, PAYEE_NOTE_ID, SETTLE_AMOUNT, PAYEE_NONCE,
        );
    cordon
        .apply(
            crate::types::GateOperation::Claim(
                crate::types::ClaimTerms {
                    settlement_id: SETTLEMENT_ID, credential, sig_r, sig_s, nonce: PAYEE_NONCE,
                },
            ),
            SETTLE_AMOUNT.into(),
            PAYEE_NOTE_ID,
        );
}

//
// Refunding
//

#[test]
fn the_payer_can_refund_after_the_window_closes() {
    let cordon = setup();
    let erc20 = IERC20Dispatcher { contract_address: cordon.token };

    cordon.fund(SETTLE_AMOUNT);
    start_cheat_block_timestamp_global(SETTLEMENT_EXPIRES_AT);
    let deposits = cordon.refund(SETTLE_AMOUNT);

    assert_eq!(
        deposits,
        [OpenNoteDeposit { note_id: NOTE_ID, token: cordon.token, amount: SETTLE_AMOUNT }].span(),
    );
    assert_eq!(cordon.gate.get_settlement(SETTLEMENT_ID).status, SettlementStatus::Refunded);
    assert_eq!(erc20.balance_of(cordon.gate.contract_address), 0);
    assert_eq!(cordon.gate.committed_balance(cordon.token), 0);
}

/// A refund before the window closes would let a payer race a payee who is still entitled to the
/// value.
#[test]
#[should_panic(expected: 'CORDON_REFUND_TOO_EARLY')]
fn refunding_before_the_window_closes_is_refused() {
    let cordon = setup();

    cordon.fund(SETTLE_AMOUNT);
    start_cheat_block_timestamp_global(SETTLEMENT_EXPIRES_AT - 1);
    cordon.refund(SETTLE_AMOUNT);
}

#[test]
#[should_panic(expected: 'CORDON_ALREADY_CLAIMED')]
fn refunding_a_claimed_settlement_is_refused() {
    let cordon = setup();

    cordon.fund(SETTLE_AMOUNT);
    cordon.claim(SETTLE_AMOUNT);
    start_cheat_block_timestamp_global(SETTLEMENT_EXPIRES_AT);
    cordon.refund(SETTLE_AMOUNT);
}

#[test]
#[should_panic(expected: 'CORDON_ALREADY_REFUNDED')]
fn a_settlement_cannot_be_refunded_twice() {
    let cordon = setup();

    cordon.fund(SETTLE_AMOUNT);
    start_cheat_block_timestamp_global(SETTLEMENT_EXPIRES_AT);
    cordon.refund_with(SETTLEMENT_ID, SETTLE_AMOUNT, 'r_a', cordon.subject_key);
    cordon.refund_with(SETTLEMENT_ID, SETTLE_AMOUNT, 'r_b', cordon.subject_key);
}

/// A refund is an authorisation like any other: it has to be signed by the pseudonym that funded
/// the settlement. A relayer holding the transaction cannot redirect somebody else's money.
#[test]
#[should_panic(expected: 'CORDON_BAD_SUBJECT_SIG')]
fn a_stranger_cannot_trigger_a_refund() {
    let cordon = setup();

    cordon.fund(SETTLE_AMOUNT);
    start_cheat_block_timestamp_global(SETTLEMENT_EXPIRES_AT);
    cordon.refund_with(SETTLEMENT_ID, SETTLE_AMOUNT, 'r_a', cordon.payee_key);
}

/// A refund does not re-check the payer's credential. A settlement can outlive the attestation
/// that funded it, and holding a payer's own money hostage to a lapsed credential would be
/// punitive rather than protective — nothing new leaves the gate.
#[test]
fn a_refund_survives_the_payer_credential_lapsing() {
    let cordon = setup();

    cordon.fund(SETTLE_AMOUNT);

    start_cheat_caller_address(cordon.revocation_registry.contract_address, issuer_operator());
    cordon.revocation_registry.revoke(ISSUER_ID, crate::tests::common::CREDENTIAL_ID);
    stop_cheat_caller_address(cordon.revocation_registry.contract_address);

    start_cheat_block_timestamp_global(SETTLEMENT_EXPIRES_AT);
    cordon.refund(SETTLE_AMOUNT);

    assert_eq!(cordon.gate.get_settlement(SETTLEMENT_ID).status, SettlementStatus::Refunded);
}

//
// Cross-leg invariants
//

/// The nonce registry spans every leg, which is what lets the action hash leave the leg out of the
/// signed message: a payer authorisation carried from a funding leg to a refund leg replays its
/// nonce and dies.
#[test]
#[should_panic(expected: 'CORDON_NONCE_USED')]
fn a_nonce_spent_on_one_leg_cannot_be_reused_on_another() {
    let cordon = setup();

    cordon.fund_terms(SETTLEMENT_ID, SETTLE_AMOUNT, CLAIM_POLICY_ID, SETTLEMENT_EXPIRES_AT, 'n_a');
    start_cheat_block_timestamp_global(SETTLEMENT_EXPIRES_AT);
    cordon.refund_with(SETTLEMENT_ID, SETTLE_AMOUNT, 'n_a', cordon.subject_key);
}

/// Funding books the payer's epoch spend, and a refund does not give it back. Velocity measures
/// value a subject pushed through the gate in a window; a refund does not unspend that window.
#[test]
fn a_refund_does_not_return_the_payers_epoch_budget() {
    let cordon = setup();
    let epoch = START_TIME / EPOCH_LENGTH;

    cordon.fund(SETTLE_AMOUNT);
    assert_eq!(
        cordon.gate.epoch_spend(cordon.subject_key.public_key, POLICY_ID, epoch), SETTLE_AMOUNT,
    );

    start_cheat_block_timestamp_global(SETTLEMENT_EXPIRES_AT);
    cordon.refund(SETTLE_AMOUNT);

    assert_eq!(
        cordon.gate.epoch_spend(cordon.subject_key.public_key, POLICY_ID, epoch), SETTLE_AMOUNT,
    );
}

/// Payer and payee are accounted separately: the payer spends against their policy, the payee
/// receives against theirs, and neither consumes the other's budget.
#[test]
fn payer_and_payee_budgets_are_independent() {
    let cordon = setup();
    let epoch = START_TIME / EPOCH_LENGTH;

    cordon.fund(SETTLE_AMOUNT);
    cordon.claim(SETTLE_AMOUNT);

    assert_eq!(
        cordon.gate.epoch_spend(cordon.subject_key.public_key, POLICY_ID, epoch), SETTLE_AMOUNT,
    );
    assert_eq!(
        cordon.gate.epoch_spend(cordon.payee_key.public_key, CLAIM_POLICY_ID, epoch), SETTLE_AMOUNT,
    );
    assert_eq!(cordon.gate.epoch_spend(cordon.subject_key.public_key, CLAIM_POLICY_ID, epoch), 0);
}

/// The claim window and the velocity epoch are different clocks. Rolling into a new epoch does not
/// reopen a closed claim window.
#[test]
#[should_panic(expected: 'CORDON_CLAIM_EXPIRED')]
fn a_new_epoch_does_not_reopen_a_closed_claim_window() {
    let cordon = setup();

    cordon.fund(SETTLE_AMOUNT);
    start_cheat_block_timestamp_global(START_TIME + CLAIM_WINDOW + EPOCH_LENGTH);
    cordon.claim(SETTLE_AMOUNT);
}

#[test]
#[should_panic(expected: 'CORDON_BAD_POOL')]
fn a_claim_from_a_non_pool_caller_is_refused() {
    let cordon = setup();

    cordon.fund(SETTLE_AMOUNT);

    let credential = cordon.payee_credential();
    let (sig_r, sig_s) = cordon
        .sign_action_as(
            cordon.payee_key, CLAIM_POLICY_ID, PAYEE_NOTE_ID, SETTLE_AMOUNT, PAYEE_NONCE,
        );

    start_cheat_caller_address(cordon.gate.contract_address, stranger());
    cordon
        .gate
        .privacy_invoke(
            crate::types::GateOperation::Claim(
                crate::types::ClaimTerms {
                    settlement_id: SETTLEMENT_ID, credential, sig_r, sig_s, nonce: PAYEE_NONCE,
                },
            ),
            cordon.token,
            cordon.pool.contract_address,
            PAYEE_NOTE_ID,
        );
}

#[test]
fn an_unfunded_settlement_reads_back_as_none() {
    let cordon = setup();

    assert_eq!(cordon.gate.get_settlement(SETTLEMENT_ID).status, SettlementStatus::None);
    assert_eq!(cordon.gate.committed_balance(cordon.token), 0);
}
