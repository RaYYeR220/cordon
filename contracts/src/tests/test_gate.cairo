//! The gate: one happy path, and every way a direct settlement is refused.
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
use crate::hashing::legs;
use crate::interfaces::{
    IIssuerRegistryDispatcherTrait, IPolicyGateDispatcherTrait, IPolicyRegistryDispatcherTrait,
    IRevocationRegistryDispatcherTrait,
};
use crate::mocks::mock_erc20::{IMockERC20MintDispatcher, IMockERC20MintDispatcherTrait};
use crate::mocks::mock_pool::IMockPoolDispatcherTrait;
use crate::tests::common::{
    CLAIM, CREDENTIAL_ID, CordonTrait, EPOCH_LENGTH, EXPIRES_AT, IMPOSTER_SECRET, ISSUER_ID,
    MAX_AMOUNT, NONCE, NOTE_ID, OTHER_ISSUER_ID, POLICY_ID, SETTLE_AMOUNT, START_TIME,
    default_policy, issuer_operator, owner, setup, setup_with_policy, stranger,
};
use crate::types::{Credential, GateOperation, OpenNoteDeposit, SubjectAuthorization};

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
    // And leaves no allowance behind for the next leg to trip over.
    assert_eq!(erc20.allowance(cordon.gate.contract_address, cordon.pool.contract_address), 0);
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

/// A policy that pins an ERC20 accepts that ERC20.
#[test]
fn a_token_pinned_policy_accepts_its_own_token() {
    let cordon = setup();
    let mut pinned = default_policy();
    pinned.token = cordon.token;

    start_cheat_caller_address(cordon.policy_registry.contract_address, owner());
    cordon.policy_registry.publish_policy('PAY_STRK_ONLY', pinned);
    stop_cheat_caller_address(cordon.policy_registry.contract_address);

    // The fixture policy is open, so re-publishing a pinned one and settling under it proves the
    // pin is satisfied rather than merely absent.
    assert_eq!(cordon.policy_registry.get_policy('PAY_STRK_ONLY').token, cordon.token);
    cordon.settle(SETTLE_AMOUNT);
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

    let mut auth = cordon.direct_auth(SETTLE_AMOUNT, NONCE, NOTE_ID);
    auth.credential = credential;
    cordon.settle_auth(SETTLE_AMOUNT, auth);
}

#[test]
#[should_panic(expected: 'CORDON_BAD_SUBJECT_SIG')]
fn one_flipped_bit_in_the_subject_signature_is_refused() {
    let cordon = setup();

    let mut auth = cordon.direct_auth(SETTLE_AMOUNT, NONCE, NOTE_ID);
    auth.sig_r = auth.sig_r + 1;
    cordon.settle_auth(SETTLE_AMOUNT, auth);
}

//
// Refusals, in enforcement order
//

/// 1. Nobody but the pool drives the gate.
///
/// The attacker names *themselves* in `pool_address`, so the calldata and the caller agree
/// perfectly. That used to be the entire check, and it authenticated nothing: the gate is
/// answerable to the pool it was constructed against, not to whoever the calldata points at.
#[test]
#[should_panic(expected: 'CORDON_BAD_POOL')]
fn a_caller_naming_itself_as_the_pool_is_refused() {
    let cordon = setup();
    let attacker: starknet::ContractAddress = 'ATTACKER'.try_into().unwrap();

    let credential = cordon.credential();
    let (sig_r, sig_s) = cordon
        .sign_action_as(
            cordon.subject_key, legs::DIRECT, POLICY_ID, NOTE_ID, SETTLE_AMOUNT, NONCE, 0,
        );

    start_cheat_caller_address(cordon.gate.contract_address, attacker);
    cordon
        .gate
        .privacy_invoke(
            GateOperation::Direct(
                SubjectAuthorization {
                    policy_id: POLICY_ID,
                    credential,
                    amount: SETTLE_AMOUNT,
                    sig_r,
                    sig_s,
                    nonce: NONCE,
                },
            ),
            cordon.token,
            attacker,
            NOTE_ID,
        );
}

/// 1b. Naming the real pool while not being it fails just as hard.
#[test]
#[should_panic(expected: 'CORDON_BAD_POOL')]
fn a_stranger_calling_with_the_real_pool_in_the_calldata_is_refused() {
    let cordon = setup();

    let auth = cordon.direct_auth(SETTLE_AMOUNT, NONCE, NOTE_ID);

    start_cheat_caller_address(cordon.gate.contract_address, stranger());
    cordon
        .gate
        .privacy_invoke(
            GateOperation::Direct(auth), cordon.token, cordon.pool.contract_address, NOTE_ID,
        );
}

/// 1c. The wallet substitutes `${poolAddress}`; the gate refuses a substitution that does not
///     match the pool it serves, even when the real pool is the caller.
#[test]
#[should_panic(expected: 'CORDON_BAD_POOL')]
fn a_pool_address_that_is_not_the_stored_pool_is_refused() {
    let cordon = setup();

    let auth = cordon.direct_auth(SETTLE_AMOUNT, NONCE, NOTE_ID);

    cordon
        .pool
        .apply_actions(
            gate: cordon.gate.contract_address,
            operation: GateOperation::Direct(auth),
            token: cordon.token,
            withdrawn: SETTLE_AMOUNT.into(),
            claimed_pool_address: stranger(),
            note_id: NOTE_ID,
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

/// 2b. `token` is caller calldata with nothing behind it, so a policy may pin the asset it is
///     willing to move. That pin is the allowlist.
#[test]
#[should_panic(expected: 'CORDON_TOKEN_NOT_ALLOWED')]
fn a_policy_pinned_to_another_token_is_refused() {
    let cordon = setup();
    let mut pinned = default_policy();
    pinned.token = 'SOME_OTHER_ERC20'.try_into().unwrap();

    start_cheat_caller_address(cordon.policy_registry.contract_address, owner());
    cordon.policy_registry.retire_policy(POLICY_ID);
    cordon.policy_registry.publish_policy('PAY_OTHER_ONLY', pinned);
    stop_cheat_caller_address(cordon.policy_registry.contract_address);

    let credential = cordon.credential();
    let (sig_r, sig_s) = cordon
        .sign_action_as(
            cordon.subject_key, legs::DIRECT, 'PAY_OTHER_ONLY', NOTE_ID, SETTLE_AMOUNT, NONCE, 0,
        );
    cordon
        .settle_auth(
            SETTLE_AMOUNT,
            SubjectAuthorization {
                policy_id: 'PAY_OTHER_ONLY',
                credential,
                amount: SETTLE_AMOUNT,
                sig_r,
                sig_s,
                nonce: NONCE,
            },
        );
}

/// 2c. This entrypoint carries no payee credential, so a policy that needs one fails closed
///     rather than silently dropping the requirement.
#[test]
#[should_panic(expected: 'CORDON_PAYEE_REQUIRED')]
fn a_policy_needing_a_payee_credential_is_refused() {
    let mut policy = default_policy();
    policy.require_payee_credential = true;
    let cordon = setup_with_policy(policy);

    cordon.settle(SETTLE_AMOUNT);
}

/// 3. A settlement of nothing is a malformed action, not a free pass.
#[test]
#[should_panic(expected: 'CORDON_NO_VALUE')]
fn a_zero_value_settlement_is_refused() {
    let cordon = setup();

    cordon.settle(0);
}

/// 3b. Signing for more than the pool actually withdrew fails closed. The gate never pays a
///     promise it is not holding the value for.
#[test]
#[should_panic(expected: 'CORDON_UNDERFUNDED')]
fn a_settlement_the_pool_did_not_fund_is_refused() {
    let cordon = setup();

    cordon.settle_auth(0, cordon.direct_auth(SETTLE_AMOUNT, NONCE, NOTE_ID));
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

    let mut auth = cordon.direct_auth(SETTLE_AMOUNT, NONCE, NOTE_ID);
    auth.credential.issuer_id = OTHER_ISSUER_ID;
    cordon.settle_auth(SETTLE_AMOUNT, auth);
}

/// 4c. A policy pinned to one issuer does not accept another issuer's credential, however valid.
#[test]
#[should_panic(expected: 'CORDON_BAD_ISSUER')]
fn a_credential_from_an_issuer_the_policy_does_not_pin_is_refused() {
    let cordon = setup();

    // Register a second, entirely legitimate issuer and have it attest the same claim.
    let other_key = KeyPairTrait::<felt252, felt252>::from_secret_key(IMPOSTER_SECRET);
    start_cheat_caller_address(cordon.issuer_registry.contract_address, owner());
    cordon
        .issuer_registry
        .register_issuer(OTHER_ISSUER_ID, other_key.public_key, stranger(), "ipfs://other");
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

    let mut auth = cordon.direct_auth(SETTLE_AMOUNT, NONCE, NOTE_ID);
    auth.credential = credential;
    cordon.settle_auth(SETTLE_AMOUNT, auth);
}

/// 5. A credential signed by anyone but the registered issuer key.
#[test]
#[should_panic(expected: 'CORDON_BAD_CRED')]
fn a_forged_issuer_signature_is_refused() {
    let cordon = setup();

    let imposter = KeyPairTrait::<felt252, felt252>::from_secret_key(IMPOSTER_SECRET);
    let mut auth = cordon.direct_auth(SETTLE_AMOUNT, NONCE, NOTE_ID);
    auth.credential = cordon.credential_signed_by(imposter, CLAIM, EXPIRES_AT);
    cordon.settle_auth(SETTLE_AMOUNT, auth);
}

/// 5b. Editing a field after signing breaks the hash the signature covers.
#[test]
#[should_panic(expected: 'CORDON_BAD_CRED')]
fn extending_the_expiry_after_signing_is_refused() {
    let cordon = setup();

    let mut auth = cordon.direct_auth(SETTLE_AMOUNT, NONCE, NOTE_ID);
    auth.credential.expires_at = EXPIRES_AT * 2;
    cordon.settle_auth(SETTLE_AMOUNT, auth);
}

/// 6. A properly signed credential that has simply run out.
#[test]
#[should_panic(expected: 'CORDON_EXPIRED')]
fn an_expired_credential_is_refused() {
    let cordon = setup();

    let mut auth = cordon.direct_auth(SETTLE_AMOUNT, NONCE, NOTE_ID);
    auth.credential = cordon.credential_signed_by(cordon.issuer_key, CLAIM, START_TIME - 1);
    cordon.settle_auth(SETTLE_AMOUNT, auth);
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

    let mut auth = cordon.direct_auth(SETTLE_AMOUNT, NONCE, NOTE_ID);
    auth.credential = cordon.credential_signed_by(cordon.issuer_key, 'KYC_L2', EXPIRES_AT);
    cordon.settle_auth(SETTLE_AMOUNT, auth);
}

/// 9. Holding a credential is not authorising a payment. A relayer that rewrites the amount is
///    refused, because the amount is inside the signature.
#[test]
#[should_panic(expected: 'CORDON_BAD_SUBJECT_SIG')]
fn an_amount_the_subject_did_not_sign_for_is_refused() {
    let cordon = setup();

    let mut auth = cordon.direct_auth(SETTLE_AMOUNT, NONCE, NOTE_ID);
    auth.amount = SETTLE_AMOUNT + 1;
    cordon.settle_auth(SETTLE_AMOUNT + 1, auth);
}

/// 9b. A signature over a different note is not a signature over this one.
#[test]
#[should_panic(expected: 'CORDON_BAD_SUBJECT_SIG')]
fn a_signature_bound_to_another_note_is_refused() {
    let cordon = setup();

    cordon.settle_auth(SETTLE_AMOUNT, cordon.direct_auth(SETTLE_AMOUNT, NONCE, 'note_9'));
}

/// 9c. A signature made for a different leg is not a signature for this one. Under `:V2` it was,
///     and a payer's direct payment could be re-typed as an escrow they never agreed to.
#[test]
#[should_panic(expected: 'CORDON_BAD_SUBJECT_SIG')]
fn a_signature_made_for_another_leg_is_refused() {
    let cordon = setup();

    let credential = cordon.credential();
    let (sig_r, sig_s) = cordon
        .sign_action_as(
            cordon.subject_key, legs::REFUND, POLICY_ID, NOTE_ID, SETTLE_AMOUNT, NONCE, 0,
        );
    cordon
        .settle_auth(
            SETTLE_AMOUNT,
            SubjectAuthorization {
                policy_id: POLICY_ID, credential, amount: SETTLE_AMOUNT, sig_r, sig_s, nonce: NONCE,
            },
        );
}

/// 9d. Nonce replay: the second settlement under the same nonce is refused even though every
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
// Deployment binding
//

/// A signature made for a different deployment does not verify here, even though every other
/// field is identical.
#[test]
#[should_panic(expected: 'CORDON_BAD_SUBJECT_SIG')]
fn a_signature_bound_to_another_gate_is_refused() {
    let cordon = setup();
    let elsewhere = setup();

    let credential = cordon.credential();
    let (sig_r, sig_s) = elsewhere
        .sign_action_as(
            cordon.subject_key, legs::DIRECT, POLICY_ID, NOTE_ID, SETTLE_AMOUNT, NONCE, 0,
        );

    cordon
        .settle_auth(
            SETTLE_AMOUNT,
            SubjectAuthorization {
                policy_id: POLICY_ID, credential, amount: SETTLE_AMOUNT, sig_r, sig_s, nonce: NONCE,
            },
        );
}

/// The pool is in the signed message too, so an authorisation cannot be carried to a gate serving
/// a different pool — and the address the subject signed is the address the allowance goes to.
#[test]
#[should_panic(expected: 'CORDON_BAD_SUBJECT_SIG')]
fn a_signature_bound_to_another_pool_is_refused() {
    let cordon = setup();

    let credential = cordon.credential();
    let (sig_r, sig_s) = cordon
        .subject_key
        .sign(
            hashing::subject_action_hash(
                crate::tests::common::CHAIN_ID,
                cordon.gate.contract_address,
                stranger(),
                legs::DIRECT,
                POLICY_ID,
                NOTE_ID,
                cordon.token,
                SETTLE_AMOUNT,
                NONCE,
                0,
            ),
        )
        .unwrap();

    cordon
        .settle_auth(
            SETTLE_AMOUNT,
            SubjectAuthorization {
                policy_id: POLICY_ID, credential, amount: SETTLE_AMOUNT, sig_r, sig_s, nonce: NONCE,
            },
        );
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
// Deployment surface
//

/// The pool and the three registries are constructor arguments and there is no setter for any of
/// them. A registry pointer decides what a credential *means*; a gate that could be re-pointed
/// while a settlement is open would let whoever did it mint a credential satisfying that
/// settlement's claim policy and walk off with the money.
#[test]
fn the_gate_reports_the_pool_and_registries_it_was_built_with() {
    let cordon = setup();

    assert_eq!(cordon.gate.privacy_pool(), cordon.pool.contract_address);

    let (issuer, revocation, policy) = cordon.gate.registries();
    assert_eq!(issuer, cordon.issuer_registry.contract_address);
    assert_eq!(revocation, cordon.revocation_registry.contract_address);
    assert_eq!(policy, cordon.policy_registry.contract_address);
}

//
// Dust
//

/// Anyone can transfer tokens to the gate; nothing stops them and nothing should. What matters is
/// that it changes nothing about a payment the payer already signed. The payer signs 400, the
/// payer gets 400, and the seven stray units sit above the ledger.
#[test]
fn a_stray_transfer_does_not_inflate_a_payment() {
    let cordon = setup();
    let erc20 = IERC20Dispatcher { contract_address: cordon.token };

    IMockERC20MintDispatcher { contract_address: cordon.token }
        .mint(cordon.gate.contract_address, 7);

    let deposits = cordon.settle(SETTLE_AMOUNT);

    assert_eq!(*deposits.at(0).amount, SETTLE_AMOUNT);
    assert_eq!(erc20.balance_of(cordon.gate.contract_address), 7);
    assert_eq!(cordon.gate.accounted_balance(cordon.token), 0);
}

/// And it does not block one either — the gate never asserts on a balance it does not control.
#[test]
fn a_stray_transfer_does_not_block_a_payment() {
    let cordon = setup();

    IMockERC20MintDispatcher { contract_address: cordon.token }
        .mint(cordon.gate.contract_address, (MAX_AMOUNT + 1).into());

    cordon.settle(SETTLE_AMOUNT);

    assert_eq!(cordon.pool.total_deposited(), SETTLE_AMOUNT);
}

#[test]
fn the_owner_can_sweep_dust() {
    let cordon = setup();
    let erc20 = IERC20Dispatcher { contract_address: cordon.token };

    IMockERC20MintDispatcher { contract_address: cordon.token }
        .mint(cordon.gate.contract_address, 500);

    start_cheat_caller_address(cordon.gate.contract_address, owner());
    let swept = cordon.gate.sweep(cordon.token, stranger());
    stop_cheat_caller_address(cordon.gate.contract_address);

    assert_eq!(swept, 500);
    assert_eq!(erc20.balance_of(stranger()), 500);
    assert_eq!(erc20.balance_of(cordon.gate.contract_address), 0);
}

#[test]
#[should_panic(expected: 'Caller is not the owner')]
fn a_stranger_cannot_sweep() {
    let cordon = setup();

    IMockERC20MintDispatcher { contract_address: cordon.token }
        .mint(cordon.gate.contract_address, 500);

    start_cheat_caller_address(cordon.gate.contract_address, stranger());
    cordon.gate.sweep(cordon.token, stranger());
}

#[test]
#[should_panic(expected: 'CORDON_NOTHING_TO_SWEEP')]
fn there_is_nothing_to_sweep_from_a_clean_gate() {
    let cordon = setup();

    start_cheat_caller_address(cordon.gate.contract_address, owner());
    cordon.gate.sweep(cordon.token, stranger());
}
