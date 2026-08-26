//! Published rule sets are immutable, and only the owner publishes them.

use snforge_std::{start_cheat_caller_address, stop_cheat_caller_address};
use crate::interfaces::IPolicyRegistryDispatcherTrait;
use crate::tests::common::{
    CLAIM, ISSUER_ID, MAX_AMOUNT, POLICY_ID, default_policy, owner, setup, stranger,
};
use crate::types::Policy;

const SECOND_POLICY_ID: felt252 = 'PAY_KYC_L2_V1';

#[test]
fn published_policy_reads_back_verbatim() {
    let cordon = setup();

    let policy = cordon.policy_registry.get_policy(POLICY_ID);
    assert_eq!(policy, default_policy());
    assert!(cordon.policy_registry.policy_exists(POLICY_ID));
}

#[test]
fn a_second_policy_gets_its_own_id() {
    let cordon = setup();

    let mut policy = default_policy();
    policy.required_claim = 'KYC_L2';
    policy.max_amount = MAX_AMOUNT * 2;

    start_cheat_caller_address(cordon.policy_registry.contract_address, owner());
    cordon.policy_registry.publish_policy(SECOND_POLICY_ID, policy);
    stop_cheat_caller_address(cordon.policy_registry.contract_address);

    assert_eq!(cordon.policy_registry.get_policy(SECOND_POLICY_ID), policy);
    // The original is untouched — versioning by id, not by mutation.
    assert_eq!(cordon.policy_registry.get_policy(POLICY_ID), default_policy());
}

/// Retirement is a kill switch, not an edit: `active` flips and every rule parameter survives so
/// past decisions stay explainable.
#[test]
fn retirement_clears_active_and_nothing_else() {
    let cordon = setup();

    start_cheat_caller_address(cordon.policy_registry.contract_address, owner());
    cordon.policy_registry.retire_policy(POLICY_ID);
    stop_cheat_caller_address(cordon.policy_registry.contract_address);

    let retired = cordon.policy_registry.get_policy(POLICY_ID);
    assert!(!retired.active);
    assert!(cordon.policy_registry.policy_exists(POLICY_ID));

    let mut expected = default_policy();
    expected.active = false;
    assert_eq!(retired, expected);
}

#[test]
#[should_panic(expected: 'Caller is not the owner')]
fn stranger_cannot_publish_a_policy() {
    let cordon = setup();

    start_cheat_caller_address(cordon.policy_registry.contract_address, stranger());
    cordon.policy_registry.publish_policy(SECOND_POLICY_ID, default_policy());
}

#[test]
#[should_panic(expected: 'Caller is not the owner')]
fn stranger_cannot_retire_a_policy() {
    let cordon = setup();

    start_cheat_caller_address(cordon.policy_registry.contract_address, stranger());
    cordon.policy_registry.retire_policy(POLICY_ID);
}

#[test]
#[should_panic(expected: 'CORDON_POLICY_EXISTS')]
fn a_published_policy_cannot_be_overwritten() {
    let cordon = setup();

    let mut looser = default_policy();
    looser.max_amount = MAX_AMOUNT * 1_000;

    start_cheat_caller_address(cordon.policy_registry.contract_address, owner());
    cordon.policy_registry.publish_policy(POLICY_ID, looser);
}

/// Even after retirement the id stays burned, so a retired citation can never come back meaning
/// something looser.
#[test]
#[should_panic(expected: 'CORDON_POLICY_EXISTS')]
fn a_retired_policy_id_cannot_be_reused() {
    let cordon = setup();

    start_cheat_caller_address(cordon.policy_registry.contract_address, owner());
    cordon.policy_registry.retire_policy(POLICY_ID);
    cordon.policy_registry.publish_policy(POLICY_ID, default_policy());
}

#[test]
#[should_panic(expected: 'CORDON_NO_POLICY')]
fn unknown_policy_panics_rather_than_defaulting_open() {
    let cordon = setup();

    cordon.policy_registry.get_policy('NEVER_PUBLISHED');
}

#[test]
#[should_panic(expected: 'CORDON_ZERO_POLICY_ID')]
fn policy_id_zero_is_reserved() {
    let cordon = setup();

    start_cheat_caller_address(cordon.policy_registry.contract_address, owner());
    cordon.policy_registry.publish_policy(0, default_policy());
}

#[test]
#[should_panic(expected: 'CORDON_ZERO_CLAIM')]
fn a_policy_requiring_no_claim_is_rejected() {
    let cordon = setup();

    let mut toothless = default_policy();
    toothless.required_claim = 0;

    start_cheat_caller_address(cordon.policy_registry.contract_address, owner());
    cordon.policy_registry.publish_policy(SECOND_POLICY_ID, toothless);
}

#[test]
#[should_panic(expected: 'CORDON_ZERO_EPOCH_CAP')]
fn a_velocity_window_with_no_budget_is_rejected() {
    let cordon = setup();

    let mut impossible = default_policy();
    impossible.max_per_epoch = 0;

    start_cheat_caller_address(cordon.policy_registry.contract_address, owner());
    cordon.policy_registry.publish_policy(SECOND_POLICY_ID, impossible);
}

#[test]
#[should_panic(expected: 'CORDON_INACTIVE_PUBLISH')]
fn a_policy_cannot_be_published_dead() {
    let cordon = setup();

    let mut dead = default_policy();
    dead.active = false;

    start_cheat_caller_address(cordon.policy_registry.contract_address, owner());
    cordon.policy_registry.publish_policy(SECOND_POLICY_ID, dead);
}

#[test]
#[should_panic(expected: 'CORDON_ALREADY_RETIRED')]
fn a_policy_cannot_be_retired_twice() {
    let cordon = setup();

    start_cheat_caller_address(cordon.policy_registry.contract_address, owner());
    cordon.policy_registry.retire_policy(POLICY_ID);
    cordon.policy_registry.retire_policy(POLICY_ID);
}

/// A policy with no limits at all is legal — the claim check alone is the rule.
#[test]
fn an_unlimited_policy_is_publishable() {
    let cordon = setup();

    let unlimited = Policy {
        required_claim: CLAIM,
        issuer_id: ISSUER_ID,
        max_amount: 0,
        epoch_length: 0,
        max_per_epoch: 0,
        require_payee_credential: false,
        active: true,
    };

    start_cheat_caller_address(cordon.policy_registry.contract_address, owner());
    cordon.policy_registry.publish_policy(SECOND_POLICY_ID, unlimited);
    stop_cheat_caller_address(cordon.policy_registry.contract_address);

    assert_eq!(cordon.policy_registry.get_policy(SECOND_POLICY_ID), unlimited);
}
