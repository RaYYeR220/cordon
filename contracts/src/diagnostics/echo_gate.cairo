//! # EchoGate — a diagnostic anonymizer that enforces nothing.
//!
//! This is **not a product** and must never be presented as one. It is a bisection tool.
//!
//! The real [`PolicyGate`](crate::policy_gate::PolicyGate) is refused during the wallet's
//! paymaster simulation with an opaque error and no revert reason reaches a block, so it is
//! impossible to tell from the outside whether Cordon's *enforcement logic* reverts or whether the
//! wallet/paymaster route refuses the invocation for a reason that has nothing to do with policy.
//! EchoGate settles that question by removing the first possibility entirely.
//!
//! It exposes `privacy_invoke` with **exactly the same signature and ABI shape as `PolicyGate`**,
//! reusing the same [`GateOperation`](crate::types::GateOperation) and
//! [`OpenNoteDeposit`](crate::types::OpenNoteDeposit) types, so calldata composed for the real gate
//! is byte-identical here — the same `GateOperation::Direct(..)` payload deserialises unchanged.
//! But it enforces **nothing**: no credential, no policy, no nonce, no note binding, no ledger, no
//! signature. It asserts only what the pool's calling convention requires — that the caller is
//! the privacy pool it was constructed against — then reads its own `balance_of`, approves the
//! pool for exactly that, and hands back a single `OpenNoteDeposit` filling the note it was told to
//! fill.
//!
//! If a payment that fails against `PolicyGate` also fails against EchoGate, the fault is in the
//! wallet/paymaster route, not in Cordon's rules. If it succeeds against EchoGate, the fault is in
//! the enforcement inputs (policy, credential, signature, chain id) that EchoGate strips away.
//!
//! It is deliberately tiny because a declare is charged by class size. It lives in the public repo
//! on purpose — a bisection tool with its purpose written on it is good engineering — but it
//! must never be wired into the app's configuration.

use starknet::ContractAddress;
use crate::types::{GateOperation, OpenNoteDeposit};

/// EchoGate's surface: the pool-facing `privacy_invoke`, plus a getter so its wiring can be read
/// back off chain after deployment.
#[starknet::interface]
pub trait IEchoGate<TState> {
    /// The same entrypoint the pool calls on the real gate, with the same argument types in the
    /// same order. `operation` and `pool_address` are accepted so the calldata shape matches
    /// `PolicyGate` byte for byte, and then deliberately ignored: this contract enforces nothing.
    fn privacy_invoke(
        ref self: TState,
        operation: GateOperation,
        token: ContractAddress,
        pool_address: ContractAddress,
        note_id: felt252,
    ) -> Span<OpenNoteDeposit>;
    /// The privacy pool this gate was constructed against, and the only address allowed to call it.
    fn privacy_pool(self: @TState) -> ContractAddress;
}

/// The minimum of ERC20 EchoGate touches: what it holds, and the approval the pool pulls against.
#[starknet::interface]
trait IErc20<TState> {
    fn balance_of(self: @TState, account: ContractAddress) -> u256;
    fn approve(ref self: TState, spender: ContractAddress, amount: u256) -> bool;
}

#[starknet::contract]
pub mod EchoGate {
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use crate::types::{GateOperation, OpenNoteDeposit};
    use super::{IEchoGate, IErc20Dispatcher, IErc20DispatcherTrait};

    /// The caller was not the privacy pool this gate was constructed against.
    const BAD_POOL: felt252 = 'ECHO_BAD_POOL';
    /// The gate's balance does not fit the pool's `u128` deposit amount.
    const AMOUNT_OVERFLOW: felt252 = 'ECHO_AMOUNT_OVERFLOW';

    #[storage]
    struct Storage {
        /// The only address allowed to call `privacy_invoke`, and the only address ever approved.
        /// Written once, in the constructor.
        privacy_pool: ContractAddress,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        Echoed: Echoed,
    }

    /// A `privacy_invoke` ran end to end: the gate approved `amount` and filled `note_id`. Emitting
    /// this is what makes a successful diagnostic invocation visible on chain.
    #[derive(Drop, starknet::Event)]
    struct Echoed {
        #[key]
        note_id: felt252,
        token: ContractAddress,
        amount: u128,
    }

    #[constructor]
    fn constructor(ref self: ContractState, pool: ContractAddress) {
        self.privacy_pool.write(pool);
    }

    #[abi(embed_v0)]
    impl EchoGateImpl of IEchoGate<ContractState> {
        fn privacy_invoke(
            ref self: ContractState,
            operation: GateOperation,
            token: ContractAddress,
            pool_address: ContractAddress,
            note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            // The one and only check: the pool convention says the anonymizer is called by the
            // pool. Everything else the real gate does — the calldata cross-check, credentials,
            // policy, nonce, binding, ledger — is deliberately absent. `operation` and
            // `pool_address` are consumed off the calldata (so the shape matches the real gate) and
            // then dropped.
            let pool = self.privacy_pool.read();
            assert(get_caller_address() == pool, BAD_POOL);
            let _ = operation;
            let _ = pool_address;

            // The amount is whatever the pool already transferred in, exactly as the real gate's
            // Direct leg treats it: read the balance, approve the pool for it, fill the note.
            let erc20 = IErc20Dispatcher { contract_address: token };
            let amount: u128 = erc20
                .balance_of(get_contract_address())
                .try_into()
                .expect(AMOUNT_OVERFLOW);
            erc20.approve(pool, amount.into());

            self.emit(Echoed { note_id, token, amount });
            [OpenNoteDeposit { note_id, token, amount }].span()
        }

        fn privacy_pool(self: @ContractState) -> ContractAddress {
            self.privacy_pool.read()
        }
    }
}
