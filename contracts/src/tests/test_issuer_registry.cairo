//! Who may attest, and who may say so.

use snforge_std::{start_cheat_caller_address, stop_cheat_caller_address};
use crate::interfaces::IIssuerRegistryDispatcherTrait;
use crate::tests::common::{ISSUER_ID, OTHER_ISSUER_ID, issuer_operator, owner, setup, stranger};

#[test]
fn registered_issuer_is_active_and_readable() {
    let cordon = setup();

    assert!(cordon.issuer_registry.is_issuer_active(ISSUER_ID));
    assert_eq!(cordon.issuer_registry.issuer_public_key(ISSUER_ID), cordon.issuer_key.public_key);
    assert_eq!(cordon.issuer_registry.issuer_operator(ISSUER_ID), issuer_operator());
    assert_eq!(cordon.issuer_registry.issuer_metadata_uri(ISSUER_ID), "ipfs://cordon-kyc");
}

#[test]
fn unknown_issuer_reads_as_zero() {
    let cordon = setup();

    assert!(!cordon.issuer_registry.is_issuer_active(OTHER_ISSUER_ID));
    assert_eq!(cordon.issuer_registry.issuer_public_key(OTHER_ISSUER_ID), 0);
}

/// Deactivation is what makes an issuer's whole book worthless at once, so the read the gate does
/// must flip in the same call.
#[test]
fn deactivation_zeroes_the_public_key() {
    let cordon = setup();

    start_cheat_caller_address(cordon.issuer_registry.contract_address, owner());
    cordon.issuer_registry.deactivate_issuer(ISSUER_ID);
    stop_cheat_caller_address(cordon.issuer_registry.contract_address);

    assert!(!cordon.issuer_registry.is_issuer_active(ISSUER_ID));
    assert_eq!(cordon.issuer_registry.issuer_public_key(ISSUER_ID), 0);
}

#[test]
#[should_panic(expected: 'Caller is not the owner')]
fn stranger_cannot_register_an_issuer() {
    let cordon = setup();

    start_cheat_caller_address(cordon.issuer_registry.contract_address, stranger());
    cordon.issuer_registry.register_issuer(OTHER_ISSUER_ID, 0x1234, stranger(), "ipfs://rogue");
}

#[test]
#[should_panic(expected: 'Caller is not the owner')]
fn stranger_cannot_deactivate_an_issuer() {
    let cordon = setup();

    start_cheat_caller_address(cordon.issuer_registry.contract_address, stranger());
    cordon.issuer_registry.deactivate_issuer(ISSUER_ID);
}

/// The operator role rotates only by its current holder — not by a stranger, and not by the
/// registry owner either. See `test_audit_regressions::m02_*` for why the owner case matters.
#[test]
#[should_panic(expected: 'CORDON_NOT_OPERATOR')]
fn stranger_cannot_set_an_operator() {
    let cordon = setup();

    start_cheat_caller_address(cordon.issuer_registry.contract_address, stranger());
    cordon.issuer_registry.set_issuer_operator(ISSUER_ID, stranger());
}

/// And the issuer can hand it on.
#[test]
fn the_operator_can_rotate_its_own_role() {
    let cordon = setup();

    start_cheat_caller_address(cordon.issuer_registry.contract_address, issuer_operator());
    cordon.issuer_registry.set_issuer_operator(ISSUER_ID, stranger());
    stop_cheat_caller_address(cordon.issuer_registry.contract_address);

    assert_eq!(cordon.issuer_registry.issuer_operator(ISSUER_ID), stranger());
}

/// An issuer id is a permanent citation. Rebinding its key would retroactively change what every
/// credential signed under that id means.
#[test]
#[should_panic(expected: 'CORDON_ISSUER_EXISTS')]
fn issuer_id_cannot_be_rebound() {
    let cordon = setup();

    start_cheat_caller_address(cordon.issuer_registry.contract_address, owner());
    cordon.issuer_registry.register_issuer(ISSUER_ID, 0x1234, issuer_operator(), "ipfs://takeover");
}

#[test]
#[should_panic(expected: 'CORDON_ZERO_ISSUER_ID')]
fn issuer_id_zero_is_reserved() {
    let cordon = setup();

    start_cheat_caller_address(cordon.issuer_registry.contract_address, owner());
    cordon.issuer_registry.register_issuer(0, 0x1234, issuer_operator(), "ipfs://nobody");
}

#[test]
#[should_panic(expected: 'CORDON_ZERO_KEY')]
fn issuer_key_zero_is_rejected() {
    let cordon = setup();

    start_cheat_caller_address(cordon.issuer_registry.contract_address, owner());
    cordon.issuer_registry.register_issuer(OTHER_ISSUER_ID, 0, issuer_operator(), "ipfs://keyless");
}

#[test]
#[should_panic(expected: 'CORDON_UNKNOWN_ISSUER')]
fn operator_cannot_be_set_for_an_unknown_issuer() {
    let cordon = setup();

    start_cheat_caller_address(cordon.issuer_registry.contract_address, issuer_operator());
    cordon.issuer_registry.set_issuer_operator(OTHER_ISSUER_ID, issuer_operator());
}

#[test]
#[should_panic(expected: 'CORDON_ALREADY_INACTIVE')]
fn issuer_cannot_be_deactivated_twice() {
    let cordon = setup();

    start_cheat_caller_address(cordon.issuer_registry.contract_address, owner());
    cordon.issuer_registry.deactivate_issuer(ISSUER_ID);
    cordon.issuer_registry.deactivate_issuer(ISSUER_ID);
}
