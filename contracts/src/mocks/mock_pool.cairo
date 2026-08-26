//! A stand-in for the StarkWare privacy pool, faithful to the parts the gate depends on.

use starknet::ContractAddress;
use crate::types::{GateOperation, OpenNoteDeposit};

/// Reproduces the pool's `Invoke` action end to end, for every action array Cordon uses.
#[starknet::interface]
pub trait IMockPool<TState> {
    /// Applies one action array against an anonymizer, the way the pool does:
    ///
    /// 1. transfer `withdrawn` to the anonymizer **before** calling it — the anonymizer never
    ///    receives an amount argument. `0` models an action array with no withdraw leg, which is
    ///    what the `Claim` and `Refund` transactions look like.
    /// 2. call `privacy_invoke`;
    /// 3. `transfer_from` whatever it approved back out, filling the open notes it named. An empty
    ///    span means the anonymizer kept the value, and nothing is pulled.
    ///
    /// `claimed_pool_address` is what the wallet would substitute for `${poolAddress}`. In a real
    /// transaction it always equals this contract; the parameter is here so a test can lie about
    /// it and prove the gate refuses.
    fn apply_actions(
        ref self: TState,
        gate: ContractAddress,
        operation: GateOperation,
        token: ContractAddress,
        withdrawn: u256,
        claimed_pool_address: ContractAddress,
        note_id: felt252,
    ) -> Span<OpenNoteDeposit>;

    /// Total value this pool has pulled back out of anonymizers.
    fn total_deposited(self: @TState) -> u128;
}

#[starknet::contract]
pub mod MockPool {
    use core::num::traits::Zero;
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_contract_address};
    use crate::interfaces::{IPolicyGateDispatcher, IPolicyGateDispatcherTrait};
    use crate::types::{GateOperation, OpenNoteDeposit};
    use super::IMockPool;

    #[storage]
    struct Storage {
        total_deposited: u128,
    }

    #[abi(embed_v0)]
    impl MockPoolImpl of IMockPool<ContractState> {
        fn apply_actions(
            ref self: ContractState,
            gate: ContractAddress,
            operation: GateOperation,
            token: ContractAddress,
            withdrawn: u256,
            claimed_pool_address: ContractAddress,
            note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            let erc20 = IERC20Dispatcher { contract_address: token };

            // Phase order on the real pool is withdraw < invoke: when there is a withdraw leg, the
            // value is already sitting with the anonymizer by the time it runs.
            if withdrawn.is_non_zero() {
                erc20.transfer(recipient: gate, amount: withdrawn);
            }

            let deposits = IPolicyGateDispatcher { contract_address: gate }
                .privacy_invoke(:operation, :token, pool_address: claimed_pool_address, :note_id);

            // Pull back exactly what the anonymizer approved and account for the open notes.
            let mut booked = self.total_deposited.read();
            for deposit in deposits {
                IERC20Dispatcher { contract_address: *deposit.token }
                    .transfer_from(
                        sender: gate,
                        recipient: get_contract_address(),
                        amount: (*deposit.amount).into(),
                    );
                booked += *deposit.amount;
            }
            self.total_deposited.write(booked);

            deposits
        }

        fn total_deposited(self: @ContractState) -> u128 {
            self.total_deposited.read()
        }
    }
}
