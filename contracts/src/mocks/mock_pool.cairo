//! A stand-in for the StarkWare privacy pool, faithful to the parts the gate depends on.

use starknet::ContractAddress;
use crate::types::{Credential, OpenNoteDeposit};

/// Reproduces the pool's `Invoke` action end to end.
#[starknet::interface]
pub trait IMockPool<TState> {
    /// Settles one gated payment exactly the way the pool does:
    ///
    /// 1. transfer the withdrawn tokens to the anonymizer **before** calling it — the anonymizer
    ///    never receives an amount argument;
    /// 2. call `privacy_invoke`;
    /// 3. `transfer_from` the approved amount back out, filling the open note.
    ///
    /// `claimed_pool_address` is what the wallet would substitute for `${poolAddress}`. In a real
    /// transaction it always equals this contract; the parameter is here so a test can lie about
    /// it and prove the gate refuses.
    fn settle(
        ref self: TState,
        gate: ContractAddress,
        token: ContractAddress,
        amount: u256,
        claimed_pool_address: ContractAddress,
        note_id: felt252,
        policy_id: felt252,
        payer: Credential,
        payer_sig_r: felt252,
        payer_sig_s: felt252,
        nonce: felt252,
    ) -> Span<OpenNoteDeposit>;

    /// Total value this pool has pulled back out of anonymizers.
    fn total_deposited(self: @TState) -> u128;
}

#[starknet::contract]
pub mod MockPool {
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_contract_address};
    use crate::interfaces::{IPolicyGateDispatcher, IPolicyGateDispatcherTrait};
    use crate::types::{Credential, OpenNoteDeposit};
    use super::IMockPool;

    #[storage]
    struct Storage {
        total_deposited: u128,
    }

    #[abi(embed_v0)]
    impl MockPoolImpl of IMockPool<ContractState> {
        fn settle(
            ref self: ContractState,
            gate: ContractAddress,
            token: ContractAddress,
            amount: u256,
            claimed_pool_address: ContractAddress,
            note_id: felt252,
            policy_id: felt252,
            payer: Credential,
            payer_sig_r: felt252,
            payer_sig_s: felt252,
            nonce: felt252,
        ) -> Span<OpenNoteDeposit> {
            let erc20 = IERC20Dispatcher { contract_address: token };

            // Phase order on the real pool is withdraw < invoke: the value is already there when
            // the anonymizer runs.
            erc20.transfer(recipient: gate, :amount);

            let deposits = IPolicyGateDispatcher { contract_address: gate }
                .privacy_invoke(
                    :token,
                    pool_address: claimed_pool_address,
                    :note_id,
                    :policy_id,
                    :payer,
                    :payer_sig_r,
                    :payer_sig_s,
                    :nonce,
                );

            // Pull back exactly what the anonymizer approved and account for the open note.
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
