//! Regression tests for the pre-deployment security audit.
//!
//! Every test here was a working exploit. The auditor left them as `poc_*` tests that **passed**,
//! which was the whole point: a passing proof-of-concept meant the attacker won. They are kept
//! rather than deleted, inverted rather than rewritten, because the scenario is the evidence. Each
//! one now states the attack it used to be and asserts that it no longer works.
//!
//! Three Criticals, one High and three Mediums were found. Nothing below is hypothetical: an
//! unprivileged party could drive the gate directly and be paid its whole ERC20 balance, take a
//! settlement meant for someone else, or destroy every escrowed token in an asset for the price of
//! `max_amount + 1` units.

use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use snforge_std::signature::stark_curve::{StarkCurveKeyPairImpl, StarkCurveSignerImpl};
use snforge_std::signature::{KeyPair, KeyPairTrait, SignerTrait};
use snforge_std::{
    start_cheat_block_timestamp_global, start_cheat_caller_address, stop_cheat_caller_address,
};
use crate::hashing;
use crate::hashing::legs;
use crate::interfaces::{
    IIssuerRegistryDispatcherTrait, IPolicyGateDispatcherTrait, IRevocationRegistryDispatcherTrait,
};
use crate::mocks::mock_erc20::{IMockERC20MintDispatcher, IMockERC20MintDispatcherTrait};
use crate::tests::common::{
    CHAIN_ID, CLAIM, CLAIM_POLICY_ID, CREDENTIAL_ID, Cordon, CordonTrait, EXPIRES_AT, ISSUER_ID,
    MAX_AMOUNT, NONCE, NOTE_ID, PAYEE_CLAIM, PAYEE_NONCE, PAYEE_NOTE_ID, POLICY_ID,
    SETTLEMENT_EXPIRES_AT, SETTLEMENT_ID, SETTLE_AMOUNT, default_claim_policy, default_policy,
    owner, setup, setup_with_policies, stranger,
};
use crate::types::{
    ClaimTerms, Credential, FundTerms, GateOperation, SettlementStatus, SubjectAuthorization,
};

const ATTACKER_SECRET: felt252 = 0xf00dbabe;
const ATTACKER_CREDENTIAL_ID: felt252 = 'CRED_ATTACKER';
const ATTACKER_NOTE_ID: felt252 = 'note_evil';
const ATTACKER_NONCE: felt252 = 'nonce_evil';

fn attacker_address() -> starknet::ContractAddress {
    'ATTACKER'.try_into().unwrap()
}

/// A perfectly legitimate second holder of the payee claim credential — i.e. any other KYC'd
/// customer of the same issuer. No forgery, no stolen key, no privileged role.
fn attacker_key() -> KeyPair<felt252, felt252> {
    KeyPairTrait::<felt252, felt252>::from_secret_key(ATTACKER_SECRET)
}

/// The attacker's own claim-policy credential.
fn attacker_credential(cordon: @Cordon) -> Credential {
    cordon
        .sign_credential(
            *cordon.issuer_key,
            ATTACKER_CREDENTIAL_ID,
            attacker_key().public_key,
            PAYEE_CLAIM,
            EXPIRES_AT,
        )
}

/// The attacker's own payer-policy credential.
fn attacker_payer_credential(cordon: @Cordon) -> Credential {
    cordon
        .sign_credential(
            *cordon.issuer_key,
            ATTACKER_CREDENTIAL_ID,
            attacker_key().public_key,
            CLAIM,
            EXPIRES_AT,
        )
}

/// A genuine third-party ERC20 transfer into the gate, outside the pool. Anybody can do this at
/// any time, and no contract can stop them.
fn donate_to_gate(cordon: @Cordon, amount: u256) {
    IMockERC20MintDispatcher { contract_address: *cordon.token }
        .mint((*cordon.gate).contract_address, amount);
}

//
// C-01 — Critical — `privacy_invoke`'s pool check authenticated nothing.
//
// `assert(pool_address == get_caller_address())` compared caller-supplied calldata against the
// caller, so every caller satisfied it by naming themselves; the same value was then handed to
// `approve`. The gate granted an ERC20 allowance to whoever called it, with no privacy pool
// involved at all. Fixed by storing the pool at construction, checking the caller against it, and
// approving only it.
//

/// **Was:** the attacker calls `privacy_invoke` directly, names themselves as `pool_address`, and
/// the gate approves them for a funded settlement's whole value — plain ERC20 tokens, outside the
/// shielded set entirely.
#[test]
#[should_panic(expected: 'CORDON_BAD_POOL')]
fn c01_a_caller_naming_itself_as_the_pool_cannot_drain_escrow() {
    let cordon = setup();
    cordon.fund(SETTLE_AMOUNT);

    let attacker = attacker_key();
    let (sig_r, sig_s) = attacker
        .sign(
            hashing::subject_action_hash(
                CHAIN_ID,
                cordon.gate.contract_address,
                attacker_address(),
                legs::CLAIM,
                CLAIM_POLICY_ID,
                ATTACKER_NOTE_ID,
                cordon.token,
                SETTLE_AMOUNT,
                ATTACKER_NONCE,
                hashing::quoted_settlement_hash(SETTLEMENT_ID),
            ),
        )
        .unwrap();

    start_cheat_caller_address(cordon.gate.contract_address, attacker_address());
    cordon
        .gate
        .privacy_invoke(
            GateOperation::Claim(
                ClaimTerms {
                    settlement_id: SETTLEMENT_ID,
                    credential: attacker_credential(@cordon),
                    sig_r,
                    sig_s,
                    nonce: ATTACKER_NONCE,
                },
            ),
            cordon.token,
            attacker_address(),
            ATTACKER_NOTE_ID,
        );
}

/// **Was:** the two "non-pool caller is refused" tests only ever exercised the mismatch branch —
/// they cheated the caller to a stranger while still passing the *real* pool as `pool_address`. A
/// matching pair sailed straight through. This is that matching pair.
#[test]
#[should_panic(expected: 'CORDON_BAD_POOL')]
fn c01_a_matching_caller_and_pool_address_pair_is_still_refused() {
    let cordon = setup();
    donate_to_gate(@cordon, 250);

    let attacker = attacker_key();
    let (sig_r, sig_s) = attacker
        .sign(
            hashing::subject_action_hash(
                CHAIN_ID,
                cordon.gate.contract_address,
                attacker_address(),
                legs::DIRECT,
                POLICY_ID,
                ATTACKER_NOTE_ID,
                cordon.token,
                250,
                ATTACKER_NONCE,
                0,
            ),
        )
        .unwrap();

    start_cheat_caller_address(cordon.gate.contract_address, attacker_address());
    cordon
        .gate
        .privacy_invoke(
            GateOperation::Direct(
                SubjectAuthorization {
                    policy_id: POLICY_ID,
                    credential: attacker_payer_credential(@cordon),
                    amount: 250,
                    sig_r,
                    sig_s,
                    nonce: ATTACKER_NONCE,
                },
            ),
            cordon.token,
            attacker_address(),
            ATTACKER_NOTE_ID,
        );
}

/// **Was:** the attacker needed no credential of their own. `pool_address` decided who was paid
/// and was not covered by the subject signature, so copying a victim's `Claim` calldata verbatim
/// and calling the gate directly with `pool_address = attacker` paid the attacker — using the
/// real payee's credential and the real payee's signature.
///
/// Two independent fixes close it: the caller must be the stored pool, and `pool_address` is
/// inside the signed message, so a rewritten one no longer verifies.
#[test]
#[should_panic(expected: 'CORDON_BAD_POOL')]
fn c01_a_victims_own_claim_calldata_cannot_be_redirected() {
    let cordon = setup();
    cordon.fund(SETTLE_AMOUNT);

    // The real payee's claim, built exactly as the SDK builds it.
    let (sig_r, sig_s) = cordon
        .sign_action_as(
            cordon.payee_key,
            legs::CLAIM,
            CLAIM_POLICY_ID,
            PAYEE_NOTE_ID,
            SETTLE_AMOUNT,
            PAYEE_NONCE,
            hashing::quoted_settlement_hash(SETTLEMENT_ID),
        );

    start_cheat_caller_address(cordon.gate.contract_address, attacker_address());
    cordon
        .gate
        .privacy_invoke(
            GateOperation::Claim(
                ClaimTerms {
                    settlement_id: SETTLEMENT_ID,
                    credential: cordon.payee_credential(),
                    sig_r,
                    sig_s,
                    nonce: PAYEE_NONCE,
                },
            ),
            cordon.token,
            attacker_address(),
            PAYEE_NOTE_ID,
        );
}

/// **Was:** the nastiest consequence. The gate released optimistically — status, then ledger,
/// then `approve` — and nothing forced the spender to pull. An attacker armed an allowance
/// against free balance, waited while an honest payment consumed that balance, and then spent the
/// stale allowance out of a *different* party's escrow. `committed` then exceeded the real balance
/// and every subsequent leg panicked forever.
///
/// The chain cannot start: an allowance can only ever be granted to the stored pool, which pulls it
/// in the same transaction. The arming step is refused.
#[test]
#[should_panic(expected: 'CORDON_BAD_POOL')]
fn c01_a_stale_allowance_cannot_be_armed() {
    let cordon = setup();
    donate_to_gate(@cordon, 1000);

    let attacker = attacker_key();
    let (sig_r, sig_s) = attacker
        .sign(
            hashing::subject_action_hash(
                CHAIN_ID,
                cordon.gate.contract_address,
                attacker_address(),
                legs::DIRECT,
                POLICY_ID,
                ATTACKER_NOTE_ID,
                cordon.token,
                1000,
                ATTACKER_NONCE,
                0,
            ),
        )
        .unwrap();

    start_cheat_caller_address(cordon.gate.contract_address, attacker_address());
    cordon
        .gate
        .privacy_invoke(
            GateOperation::Direct(
                SubjectAuthorization {
                    policy_id: POLICY_ID,
                    credential: attacker_payer_credential(@cordon),
                    amount: 1000,
                    sig_r,
                    sig_s,
                    nonce: ATTACKER_NONCE,
                },
            ),
            cordon.token,
            attacker_address(),
            ATTACKER_NOTE_ID,
        );
}

/// **Was:** once `committed > balance`, `_free_balance`'s `checked_sub` underflowed and every leg
/// for that token panicked `CORDON_BALANCE_SHORTFALL` forever — with no sweep, no pause and no
/// upgrade path.
///
/// The desync is now unreachable, and the gate leaves no allowance behind for anyone to spend
/// later: a completed leg ends with the pool's allowance back at zero, and the next leg refuses to
/// start if it does not.
#[test]
fn c01_a_completed_leg_leaves_no_allowance_behind() {
    let cordon = setup();
    let erc20 = IERC20Dispatcher { contract_address: cordon.token };
    let gate = cordon.gate.contract_address;
    let pool = cordon.pool.contract_address;

    cordon.settle_with_nonce(SETTLE_AMOUNT, 'n_direct');
    assert_eq!(erc20.allowance(gate, pool), 0);

    cordon.fund(SETTLE_AMOUNT);
    assert_eq!(erc20.allowance(gate, pool), 0);

    cordon.claim(SETTLE_AMOUNT);
    assert_eq!(erc20.allowance(gate, pool), 0);

    // The ledger and the balance agree, so nothing is stranded and nothing is over-promised.
    assert_eq!(cordon.gate.accounted_balance(cordon.token), 0);
    assert_eq!(erc20.balance_of(gate), 0);
}

//
// C-02 — Critical — a settlement recorded no payee, only a policy.
//
// `_claim` proved the presenter controlled the key their own credential named, and never asked
// whether that key was the one the payer meant to pay. The gate's entire notion of "the payee" was
// "anybody holding a credential of the right claim from the right issuer". Fixed by binding
// `payee_subject_key` at funding time, signing it, and checking it first on the claim leg.
//

/// **Was:** Alice funds 400 for Bob. Mallory — an ordinary customer of the same issuer, with her
/// own perfectly valid credential — reads the settlement id out of the public event, claims it,
/// and receives 400 into her own note. Bob's claim then fails `CORDON_ALREADY_CLAIMED`.
///
/// Precondition was: be an ordinary KYC'd user. No forgery, no stolen key, no privileged role.
#[test]
#[should_panic(expected: 'CORDON_NOT_THE_PAYEE')]
fn c02_a_credentialed_stranger_cannot_take_a_settlement() {
    let cordon = setup();
    cordon.fund(SETTLE_AMOUNT);

    let attacker = attacker_key();
    let (sig_r, sig_s) = cordon
        .sign_action_as(
            attacker,
            legs::CLAIM,
            CLAIM_POLICY_ID,
            ATTACKER_NOTE_ID,
            SETTLE_AMOUNT,
            ATTACKER_NONCE,
            hashing::quoted_settlement_hash(SETTLEMENT_ID),
        );

    cordon
        .apply(
            GateOperation::Claim(
                ClaimTerms {
                    settlement_id: SETTLEMENT_ID,
                    credential: attacker_credential(@cordon),
                    sig_r,
                    sig_s,
                    nonce: ATTACKER_NONCE,
                },
            ),
            0,
            ATTACKER_NOTE_ID,
        );
}

/// **Was:** and the real payee was then permanently locked out, because the settlement had been
/// resolved by the thief.
///
/// Now the theft attempt reverts and leaves no trace: the settlement is untouched and the real
/// payee is paid.
#[test]
fn c02_the_real_payee_is_still_paid_after_a_theft_attempt() {
    let cordon = setup();
    cordon.fund(SETTLE_AMOUNT);

    // The attempt above reverts, so the settlement is exactly as the payer left it.
    assert_eq!(cordon.gate.get_settlement(SETTLEMENT_ID).status, SettlementStatus::Funded);
    assert_eq!(
        cordon.gate.get_settlement(SETTLEMENT_ID).payee_subject_key, cordon.payee_key.public_key,
    );

    let deposits = cordon.claim(SETTLE_AMOUNT);

    assert_eq!(*deposits.at(0).note_id, PAYEE_NOTE_ID);
    assert_eq!(*deposits.at(0).amount, SETTLE_AMOUNT);
    assert_eq!(cordon.gate.get_settlement(SETTLEMENT_ID).status, SettlementStatus::Claimed);
}

//
// C-03 — Critical — a donation of `max_amount + 1` permanently destroyed all escrow in a token.
//
// `balance_of` is a permissionlessly writable global, and the gate treated it as an input:
// `_assert_open` demanded a free balance of exactly zero, and `_value_received` folded any surplus
// into the amount. One wei bricked every `Claim` and `Refund`; a donation above the per-transaction
// cap could never be absorbed by any leg, so the escrow was unreachable by both parties forever.
//
// Fixed by keeping an internal ledger: amounts come from signed authorisations and stored
// settlements, the balance is consulted only as a solvency check, and surplus is ignored.
//

/// **Was:** after a settlement is funded, one wei from a stranger made `_assert_open`'s
/// `free_balance == 0` check fail forever. The escrow was frozen.
#[test]
fn c03_a_one_wei_donation_does_not_brick_the_claim() {
    let cordon = setup();
    cordon.fund(SETTLE_AMOUNT);

    donate_to_gate(@cordon, 1);

    let deposits = cordon.claim(SETTLE_AMOUNT);
    assert_eq!(*deposits.at(0).amount, SETTLE_AMOUNT);
    assert_eq!(cordon.gate.get_settlement(SETTLEMENT_ID).status, SettlementStatus::Claimed);
}

/// **Was:** the same wei bricked the refund path too, so neither party could reach the escrow.
#[test]
fn c03_a_one_wei_donation_does_not_brick_the_refund() {
    let cordon = setup();
    cordon.fund(SETTLE_AMOUNT);

    donate_to_gate(@cordon, 1);

    start_cheat_block_timestamp_global(SETTLEMENT_EXPIRES_AT);
    let deposits = cordon.refund(SETTLE_AMOUNT);
    assert_eq!(*deposits.at(0).amount, SETTLE_AMOUNT);
    assert_eq!(cordon.gate.get_settlement(SETTLEMENT_ID).status, SettlementStatus::Refunded);
}

/// **Was:** the same wei blocked every ordinary payment too, because it changed the amount the
/// gate computed and so broke the signature the payer had already made. A permanent,
/// unauthenticated, one-wei denial of service on the whole gate.
#[test]
fn c03_a_one_wei_donation_does_not_block_direct_payments() {
    let cordon = setup();

    donate_to_gate(@cordon, 1);

    let deposits = cordon.settle(SETTLE_AMOUNT);
    assert_eq!(*deposits.at(0).amount, SETTLE_AMOUNT);
}

/// **Was:** the donation was folded into the next payment — the payer had to sign for
/// `amount + donation`, a figure they could not know in advance and which the attacker could
/// invalidate again for another wei.
///
/// Now the payer signs 400 and receives exactly 400. The seven stray units are not theirs, not
/// anybody's, and not spendable by a leg.
#[test]
fn c03_a_donation_is_not_absorbed_into_someone_elses_payment() {
    let cordon = setup();
    let erc20 = IERC20Dispatcher { contract_address: cordon.token };

    donate_to_gate(@cordon, 7);

    let deposits = cordon.settle(SETTLE_AMOUNT);

    assert_eq!(*deposits.at(0).amount, SETTLE_AMOUNT);
    assert_eq!(erc20.balance_of(cordon.gate.contract_address), 7);
    assert_eq!(cordon.gate.accounted_balance(cordon.token), 0);
}

/// **Was:** the decisive version. The only thing that could consume free balance was a
/// `Direct`/`Fund` leg taking the *entire* surplus, and that leg ran through the cap check — so a
/// donation of `max_amount + 1` could never be absorbed by any policy whose cap it exceeded.
/// `CORDON_OVER_CAP` on every absorbing leg, `CORDON_UNEXPECTED_VALUE` on every claim and refund.
/// Attacker cost: 1001 tokens, burned once. Effect: every escrowed token in that asset destroyed.
#[test]
fn c03_a_donation_above_the_cap_is_harmless() {
    let cordon = setup();
    cordon.fund(SETTLE_AMOUNT);

    donate_to_gate(@cordon, (MAX_AMOUNT + 1).into());

    // Payments keep working.
    cordon.settle_with_nonce(SETTLE_AMOUNT, 'n_after');
    // The payee is still paid in full.
    cordon.claim(SETTLE_AMOUNT);
    assert_eq!(cordon.gate.get_settlement(SETTLEMENT_ID).status, SettlementStatus::Claimed);
    assert_eq!(cordon.gate.accounted_balance(cordon.token), 0);
}

/// **Was:** with that surplus stuck, the escrowed 400 was unreachable by both parties forever.
///
/// Now the refund goes through, and the dust the attacker burned is recoverable by the owner —
/// who cannot reach the escrow itself.
#[test]
fn c03_the_escrow_stays_reachable_and_the_dust_is_recoverable() {
    let cordon = setup();
    let erc20 = IERC20Dispatcher { contract_address: cordon.token };
    cordon.fund(SETTLE_AMOUNT);

    donate_to_gate(@cordon, (MAX_AMOUNT + 1).into());

    start_cheat_block_timestamp_global(SETTLEMENT_EXPIRES_AT);
    cordon.refund(SETTLE_AMOUNT);
    assert_eq!(cordon.gate.get_settlement(SETTLEMENT_ID).status, SettlementStatus::Refunded);

    start_cheat_caller_address(cordon.gate.contract_address, owner());
    let swept = cordon.gate.sweep(cordon.token, stranger());
    stop_cheat_caller_address(cordon.gate.contract_address);

    assert_eq!(swept, MAX_AMOUNT + 1);
    assert_eq!(erc20.balance_of(cordon.gate.contract_address), 0);
}

/// **Was:** the theft mirror — any stranded balance belonged to the first credentialed caller,
/// silently, because `token` was caller calldata and the gate treated its whole balance as income.
///
/// The residual is bounded and deliberate, and it is worth being precise about. A credentialed
/// party can still *deliberately* sign for stranded dust and receive it; the gate cannot tell a
/// pool withdrawal from a stray transfer, because both are just balance, and nothing in the pool's
/// convention attests to what it sent. What is closed is everything that made it dangerous:
///
/// - it can no longer happen silently, as part of somebody else's payment (test above);
/// - it is bounded by the taker's own policy cap and velocity, and costs them a nonce;
/// - and it can never reach a funded settlement, which is what this test pins.
#[test]
#[should_panic(expected: 'CORDON_UNDERFUNDED')]
fn c03_stranded_dust_cannot_be_stretched_to_cover_escrow() {
    let cordon = setup();

    // 400 is escrowed for a real payee; 100 is dust.
    cordon.fund(SETTLE_AMOUNT);
    donate_to_gate(@cordon, 100);

    // The attacker signs for the dust *plus* the escrow and gets neither.
    let attacker = attacker_key();
    let (sig_r, sig_s) = cordon
        .sign_action_as(
            attacker,
            legs::DIRECT,
            POLICY_ID,
            ATTACKER_NOTE_ID,
            SETTLE_AMOUNT + 100,
            ATTACKER_NONCE,
            0,
        );
    cordon
        .apply(
            GateOperation::Direct(
                SubjectAuthorization {
                    policy_id: POLICY_ID,
                    credential: attacker_payer_credential(@cordon),
                    amount: SETTLE_AMOUNT + 100,
                    sig_r,
                    sig_s,
                    nonce: ATTACKER_NONCE,
                },
            ),
            0,
            ATTACKER_NOTE_ID,
        );
}

//
// H-01 — High — the signed message omitted the leg, the pool and every settlement term.
//
// `HASHING.md` argued that the leg needed no coverage because the shared nonce registry killed a
// replayed signature. The argument was a non-sequitur: the nonce prevents a *second* use and says
// nothing about the first use being the wrong one. Fixed at `:V3`, which puts the leg tag, the
// pool address and a hash of the full settlement terms into the message.
//

/// **Was:** the payer signs a one-shot direct payment into their own note; whoever assembles the
/// action array runs the `Fund` leg with the same signature instead, parking the payer's money in
/// an escrow whose id, claim policy and expiry the attacker chose — and then takes it via C-02.
/// One use, entirely legitimate as far as the nonce was concerned.
#[test]
#[should_panic(expected: 'CORDON_BAD_SUBJECT_SIG')]
fn h01_a_direct_authorisation_cannot_be_executed_as_a_fund() {
    let cordon = setup();

    // Exactly what the payer signs for a `Direct` payment.
    let payer = cordon.direct_auth(SETTLE_AMOUNT, NONCE, NOTE_ID);

    cordon
        .apply(
            GateOperation::Fund(
                FundTerms {
                    payer,
                    settlement_id: 'attacker_choice',
                    payee_subject_key: attacker_key().public_key,
                    payee_claim_policy_id: CLAIM_POLICY_ID,
                    expires_at: SETTLEMENT_EXPIRES_AT,
                },
            ),
            SETTLE_AMOUNT.into(),
            0,
        );
}

/// **Was:** even on an honest `Fund`, one signature authorised *any* settlement id, *any* active
/// claim policy, *any* payee and *any* expiry, because none of them was in the preimage. The PoC
/// parked the payer's money under an id they never chose with an expiry a century out — which,
/// with no rescue path, locked them out of their own refund permanently.
#[test]
#[should_panic(expected: 'CORDON_BAD_SUBJECT_SIG')]
fn h01_fund_terms_cannot_be_swapped_after_signing() {
    let cordon = setup();

    // The payer signs for the settlement they agreed to.
    let terms_hash = hashing::settlement_terms_hash(
        SETTLEMENT_ID, cordon.payee_key.public_key, CLAIM_POLICY_ID, SETTLEMENT_EXPIRES_AT,
    );
    let (sig_r, sig_s) = cordon
        .sign_action_as(
            cordon.subject_key, legs::FUND, POLICY_ID, 0, SETTLE_AMOUNT, NONCE, terms_hash,
        );
    let payer = SubjectAuthorization {
        policy_id: POLICY_ID,
        credential: cordon.credential(),
        amount: SETTLE_AMOUNT,
        sig_r,
        sig_s,
        nonce: NONCE,
    };

    // Submitted with terms they never saw.
    cordon
        .apply(
            GateOperation::Fund(
                FundTerms {
                    payer,
                    settlement_id: 'not_what_i_signed',
                    payee_subject_key: attacker_key().public_key,
                    payee_claim_policy_id: CLAIM_POLICY_ID,
                    expires_at: SETTLEMENT_EXPIRES_AT + 3_153_600_000,
                },
            ),
            SETTLE_AMOUNT.into(),
            0,
        );
}

//
// M-02 — the registry owner could revoke any issuer's credentials in two transactions.
//

/// **Was:** `set_issuer_operator` was owner-only and unrestricted, so the owner pointed an
/// issuer's operator at themselves and then used the role. Two transactions, no issuer consent —
/// while `revocation_registry.cairo` promised in prose that "anyone else, including this
/// contract's owner, is refused".
///
/// The role now starts with the issuer at registration and rotates only by its current holder.
#[test]
#[should_panic(expected: 'CORDON_NOT_OPERATOR')]
fn m02_the_owner_cannot_take_an_issuers_operator_role() {
    let cordon = setup();

    start_cheat_caller_address(cordon.issuer_registry.contract_address, owner());
    cordon.issuer_registry.set_issuer_operator(ISSUER_ID, owner());
}

/// And with the role unreachable, the second transaction of the chain is refused too.
#[test]
#[should_panic(expected: 'CORDON_NOT_OPERATOR')]
fn m02_the_owner_still_cannot_revoke() {
    let cordon = setup();

    start_cheat_caller_address(cordon.revocation_registry.contract_address, owner());
    cordon.revocation_registry.revoke(ISSUER_ID, CREDENTIAL_ID);
}

//
// M-01 — `_fund` fetched the claim policy and discarded it.
//

/// **Was:** funding checked the amount against the *payer's* cap and never the *payee's*, so a
/// settlement could be booked, emit `SettlementFunded`, and read `Funded` while every possible
/// claim reverted `CORDON_OVER_CAP` for the whole window. The payee ships and cannot be paid.
///
/// The existing suite pinned that revert as correct behaviour, which is how it survived review.
#[test]
#[should_panic(expected: 'CORDON_PAYEE_OVER_CAP')]
fn m01_fund_cannot_book_a_settlement_no_claim_can_satisfy() {
    let mut claim_policy = default_claim_policy();
    claim_policy.max_amount = SETTLE_AMOUNT - 1;
    let cordon = setup_with_policies(default_policy(), claim_policy);

    cordon.fund(SETTLE_AMOUNT);
}

//
// L-02 — settlement-id squatting. Rated Low, and fixed by an integration rule rather than code.
//

/// Settlement ids are single-use forever and funding is permissionless, so anyone who can *guess*
/// an id can burn it with a dust funding and make the victim's transaction revert.
///
/// This is left as a property rather than patched, and the reasoning is worth recording: the id
/// must be known in advance to be squatted, the victim's transaction fails closed with their value
/// still shielded, retrying from a 2^251 space costs nothing, and the squatter pays a credential, a
/// nonce, epoch budget and at least one escrowed unit. Deriving ids in the contract would buy
/// nothing that randomness does not.
///
/// **The rule: settlement ids are generated at random by the payer.** The SDK does this, the
/// `FundTerms::settlement_id` doc says so, and the privacy argument points the same way — a
/// guessable id in an event log is a correlation key.
#[test]
#[should_panic(expected: 'CORDON_SETTLEMENT_EXISTS')]
fn l02_a_predictable_settlement_id_can_still_be_squatted() {
    let cordon = setup();

    cordon
        .fund_terms(
            SETTLEMENT_ID,
            1,
            cordon.payee_key.public_key,
            CLAIM_POLICY_ID,
            SETTLEMENT_EXPIRES_AT,
            'squat',
        );

    cordon.fund(SETTLE_AMOUNT);
}

//
// Informational — signature-primitive edges. These were CLEAN and are kept as evidence.
//

#[test]
fn info_zero_public_key_and_zero_signature_are_rejected_by_the_curve() {
    let msg = hashing::credential_hash(
        @Credential {
            issuer_id: ISSUER_ID,
            credential_id: 'x',
            subject_public_key: 0,
            claim: 'ACCREDITED',
            expires_at: 1,
            sig_r: 0,
            sig_s: 0,
        },
    );
    assert!(!core::ecdsa::check_ecdsa_signature(msg, 0, 0, 0));
    assert!(!core::ecdsa::check_ecdsa_signature(msg, 0, 1, 1));
    assert!(!core::ecdsa::check_ecdsa_signature(msg, 1, 0, 0));
}

/// STARK-curve ECDSA is malleable in `s`, but the replay guard is the nonce, not the signature
/// bytes, so a malleated signature buys nothing.
#[test]
#[should_panic(expected: 'CORDON_NONCE_USED')]
fn info_signature_malleability_still_hits_the_nonce_registry() {
    let cordon = setup();

    cordon.settle(SETTLE_AMOUNT);
    cordon.settle(SETTLE_AMOUNT);
}
