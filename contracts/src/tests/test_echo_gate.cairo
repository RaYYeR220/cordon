//! EchoGate: it settles for anyone the pool sends, and no one else.
//!
//! EchoGate is the diagnostic that strips every Cordon check away, so these tests prove exactly
//! two things: that a byte-identical `GateOperation::Direct` payload — credential and signature
//! left as garbage — still returns a filled deposit, and that a caller who is not the pool is
//! refused. If both hold, EchoGate isolates a paymaster refusal to the route rather than the rules.

use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_caller_address,
    stop_cheat_caller_address,
};
use starknet::ContractAddress;
use crate::diagnostics::echo_gate::{IEchoGateDispatcher, IEchoGateDispatcherTrait};
use crate::mocks::mock_erc20::{IMockERC20MintDispatcher, IMockERC20MintDispatcherTrait};
use crate::mocks::mock_pool::{IMockPoolDispatcher, IMockPoolDispatcherTrait};
use crate::types::{Credential, GateOperation, OpenNoteDeposit, SubjectAuthorization};

const NOTE_ID: felt252 = 'echo_note';
const WITHDRAWN: u128 = 2_000;

fn deploy(name: ByteArray, calldata: @Array<felt252>) -> ContractAddress {
    let class = declare(name).unwrap().contract_class();
    let (address, _) = class.deploy(calldata).unwrap();
    address
}

/// A `Direct` payload whose credential and signature are pure noise. The real gate would refuse it
/// at `CORDON_BAD_CRED`; EchoGate never looks, which is the whole point of the diagnostic.
fn garbage_direct() -> GateOperation {
    let credential = Credential {
        issuer_id: 0,
        credential_id: 0,
        subject_public_key: 0,
        claim: 0,
        expires_at: 0,
        sig_r: 0,
        sig_s: 0,
    };
    GateOperation::Direct(
        SubjectAuthorization {
            policy_id: 0,
            credential,
            note_binding: 0,
            valid_until: 0,
            amount: WITHDRAWN,
            sig_r: 0,
            sig_s: 0,
            nonce: 0,
        },
    )
}

#[test]
fn echoes_the_deposit_for_a_pool_call_without_any_credential() {
    let pool_address = deploy("MockPool", @array![]);
    let token = deploy("MockERC20", @array![]);
    let gate_address = deploy("EchoGate", @array![pool_address.into()]);

    IMockERC20MintDispatcher { contract_address: token }.mint(pool_address, 1_000_000);
    let erc20 = IERC20Dispatcher { contract_address: token };

    let deposits = IMockPoolDispatcher { contract_address: pool_address }
        .apply_actions(
            gate: gate_address,
            operation: garbage_direct(),
            token: token,
            withdrawn: WITHDRAWN.into(),
            claimed_pool_address: pool_address,
            note_id: NOTE_ID,
        );

    // It returns exactly the note it was told to fill, for the amount it was handed.
    assert_eq!(deposits, [OpenNoteDeposit { note_id: NOTE_ID, token, amount: WITHDRAWN }].span());
    // And, like the real gate, ends holding nothing and leaves no allowance behind.
    assert_eq!(erc20.balance_of(gate_address), 0);
    assert_eq!(erc20.allowance(gate_address, pool_address), 0);
    assert_eq!(IMockPoolDispatcher { contract_address: pool_address }.total_deposited(), WITHDRAWN);
}

#[test]
fn reports_the_pool_it_was_constructed_against() {
    let pool_address = deploy("MockPool", @array![]);
    let gate_address = deploy("EchoGate", @array![pool_address.into()]);
    assert_eq!(IEchoGateDispatcher { contract_address: gate_address }.privacy_pool(), pool_address);
}

#[test]
#[should_panic(expected: 'ECHO_BAD_POOL')]
fn refuses_a_caller_that_is_not_the_pool() {
    let pool_address = deploy("MockPool", @array![]);
    let token = deploy("MockERC20", @array![]);
    let gate_address = deploy("EchoGate", @array![pool_address.into()]);

    let stranger: ContractAddress = 'STRANGER'.try_into().unwrap();
    start_cheat_caller_address(gate_address, stranger);
    IEchoGateDispatcher { contract_address: gate_address }
        .privacy_invoke(
            operation: garbage_direct(), token: token, pool_address: pool_address, note_id: NOTE_ID,
        );
    stop_cheat_caller_address(gate_address);
}
