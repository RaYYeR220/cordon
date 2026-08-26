//! A minimal ERC20 with an open mint, for tests only.

use starknet::ContractAddress;

/// The one thing a real ERC20 does not give a test: unrestricted supply.
#[starknet::interface]
pub trait IMockERC20Mint<TState> {
    fn mint(ref self: TState, recipient: ContractAddress, amount: u256);
}

#[starknet::contract]
pub mod MockERC20 {
    use core::num::traits::Zero;
    use openzeppelin::interfaces::token::erc20::IERC20;
    use starknet::storage::{
        Map, StoragePathEntry, StoragePointerReadAccess, StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_caller_address};
    use super::IMockERC20Mint;

    #[storage]
    struct Storage {
        total_supply: u256,
        balances: Map<ContractAddress, u256>,
        allowances: Map<(ContractAddress, ContractAddress), u256>,
    }

    #[abi(embed_v0)]
    impl MintImpl of IMockERC20Mint<ContractState> {
        fn mint(ref self: ContractState, recipient: ContractAddress, amount: u256) {
            self.total_supply.write(self.total_supply.read() + amount);
            let slot = self.balances.entry(recipient);
            slot.write(slot.read() + amount);
        }
    }

    #[abi(embed_v0)]
    impl ERC20Impl of IERC20<ContractState> {
        fn total_supply(self: @ContractState) -> u256 {
            self.total_supply.read()
        }

        fn balance_of(self: @ContractState, account: ContractAddress) -> u256 {
            self.balances.entry(account).read()
        }

        fn allowance(
            self: @ContractState, owner: ContractAddress, spender: ContractAddress,
        ) -> u256 {
            self.allowances.entry((owner, spender)).read()
        }

        fn transfer(ref self: ContractState, recipient: ContractAddress, amount: u256) -> bool {
            self._move(get_caller_address(), recipient, amount);
            true
        }

        fn transfer_from(
            ref self: ContractState,
            sender: ContractAddress,
            recipient: ContractAddress,
            amount: u256,
        ) -> bool {
            let allowance_slot = self.allowances.entry((sender, get_caller_address()));
            let allowance = allowance_slot.read();
            assert(allowance >= amount, 'MOCK_ERC20_ALLOWANCE');
            allowance_slot.write(allowance - amount);
            self._move(sender, recipient, amount);
            true
        }

        fn approve(ref self: ContractState, spender: ContractAddress, amount: u256) -> bool {
            self.allowances.entry((get_caller_address(), spender)).write(amount);
            true
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn _move(
            ref self: ContractState,
            sender: ContractAddress,
            recipient: ContractAddress,
            amount: u256,
        ) {
            assert(recipient.is_non_zero(), 'MOCK_ERC20_ZERO_RECIPIENT');
            let sender_slot = self.balances.entry(sender);
            let sender_balance = sender_slot.read();
            assert(sender_balance >= amount, 'MOCK_ERC20_BALANCE');
            sender_slot.write(sender_balance - amount);
            let recipient_slot = self.balances.entry(recipient);
            recipient_slot.write(recipient_slot.read() + amount);
        }
    }
}
