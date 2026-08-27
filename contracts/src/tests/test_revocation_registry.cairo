//! Revocation belongs to the issuer, not to the registry owner.

use snforge_std::{start_cheat_caller_address, stop_cheat_caller_address};
use starknet::syscalls::call_contract_syscall;
use crate::interfaces::IRevocationRegistryDispatcherTrait;
use crate::tests::common::{
    CREDENTIAL_ID, ISSUER_ID, OTHER_ISSUER_ID, issuer_operator, owner, setup, stranger,
};

#[test]
fn operator_can_revoke() {
    let cordon = setup();
    assert!(!cordon.revocation_registry.is_revoked(ISSUER_ID, CREDENTIAL_ID));

    start_cheat_caller_address(cordon.revocation_registry.contract_address, issuer_operator());
    cordon.revocation_registry.revoke(ISSUER_ID, CREDENTIAL_ID);
    stop_cheat_caller_address(cordon.revocation_registry.contract_address);

    assert!(cordon.revocation_registry.is_revoked(ISSUER_ID, CREDENTIAL_ID));
}

/// Credential ids are issuer-scoped. One issuer revoking says nothing about another's book, even
/// when they happen to use the same id.
#[test]
fn revocation_is_scoped_to_the_issuer() {
    let cordon = setup();

    start_cheat_caller_address(cordon.revocation_registry.contract_address, issuer_operator());
    cordon.revocation_registry.revoke(ISSUER_ID, CREDENTIAL_ID);
    stop_cheat_caller_address(cordon.revocation_registry.contract_address);

    assert!(cordon.revocation_registry.is_revoked(ISSUER_ID, CREDENTIAL_ID));
    assert!(!cordon.revocation_registry.is_revoked(OTHER_ISSUER_ID, CREDENTIAL_ID));
}

#[test]
#[should_panic(expected: 'CORDON_NOT_OPERATOR')]
fn stranger_cannot_revoke() {
    let cordon = setup();

    start_cheat_caller_address(cordon.revocation_registry.contract_address, stranger());
    cordon.revocation_registry.revoke(ISSUER_ID, CREDENTIAL_ID);
}

/// The registry owner governs *who* may attest. Deciding that a specific credential is void is the
/// issuer's call alone, and the owner does not get to make it for them.
#[test]
#[should_panic(expected: 'CORDON_NOT_OPERATOR')]
fn owner_cannot_revoke_on_an_issuers_behalf() {
    let cordon = setup();

    start_cheat_caller_address(cordon.revocation_registry.contract_address, owner());
    cordon.revocation_registry.revoke(ISSUER_ID, CREDENTIAL_ID);
}

#[test]
#[should_panic(expected: 'CORDON_NOT_OPERATOR')]
fn an_issuer_without_an_operator_cannot_be_revoked_for() {
    let cordon = setup();

    start_cheat_caller_address(cordon.revocation_registry.contract_address, issuer_operator());
    cordon.revocation_registry.revoke(OTHER_ISSUER_ID, CREDENTIAL_ID);
}

#[test]
#[should_panic(expected: 'CORDON_ALREADY_REVOKED')]
fn revoking_twice_is_surfaced() {
    let cordon = setup();

    start_cheat_caller_address(cordon.revocation_registry.contract_address, issuer_operator());
    cordon.revocation_registry.revoke(ISSUER_ID, CREDENTIAL_ID);
    cordon.revocation_registry.revoke(ISSUER_ID, CREDENTIAL_ID);
}

/// The issuer registry pointer is fixed at construction and there is no setter for it.
///
/// This is load-bearing rather than tidy: an owner who could re-point it could install a registry
/// naming them the operator of every issuer, and then revoke anything they liked — which is
/// precisely the property `revoke` promises does not exist.
#[test]
fn the_issuer_registry_pointer_is_fixed_at_construction() {
    let cordon = setup();

    assert_eq!(
        cordon.revocation_registry.issuer_registry(), cordon.issuer_registry.contract_address,
    );
}

/// Immutability pinned by a test rather than by a comment.
///
/// `revoke` promises that nobody but an issuer's own operator can withdraw its attestations. That
/// promise rests on this pointer being fixed: an owner who could re-point it could install a
/// registry naming them the operator of every issuer, and reach the write path in two
/// transactions.
#[test]
fn the_revocation_registry_has_no_issuer_registry_setter() {
    let cordon = setup();

    let result = call_contract_syscall(
        cordon.revocation_registry.contract_address,
        selector!("set_issuer_registry"),
        array![stranger().into()].span(),
    );

    assert!(result.is_err());

    // Control: the getter that does exist answers, so the assertion above is about the missing
    // setter rather than about the mechanism failing for its own reasons.
    let control = call_contract_syscall(
        cordon.revocation_registry.contract_address, selector!("issuer_registry"), array![].span(),
    );
    assert!(control.is_ok());
}
