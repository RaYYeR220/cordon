//! Public interfaces for the four Cordon contracts.
//!
//! Kept in one module so the gate can hold dispatchers for the registries without pulling in their
//! implementations, and so the SDK has a single file to mirror.

use starknet::ContractAddress;
use crate::types::{GateOperation, OpenNoteDeposit, Policy, Settlement};

/// The set of keys allowed to attest, and the addresses that speak for them.
///
/// Owner-governed: only the registry owner adds or removes an issuer. An issuer id is claimed
/// once and never rebound, so a credential signed under an id can always be traced to the key that
/// was registered under it.
#[starknet::interface]
pub trait IIssuerRegistry<TState> {
    /// Registers a new issuer, together with the address that speaks for it. Owner only.
    fn register_issuer(
        ref self: TState,
        issuer_id: felt252,
        public_key: felt252,
        operator: ContractAddress,
        metadata_uri: ByteArray,
    );
    /// Hands the operator role to another address. Callable **only by the current operator**.
    fn set_issuer_operator(ref self: TState, issuer_id: felt252, operator: ContractAddress);
    /// Takes an issuer out of service. Owner only, and permanent for that id.
    fn deactivate_issuer(ref self: TState, issuer_id: felt252);
    /// The issuer's attesting public key, or zero if the issuer is unknown or inactive.
    fn issuer_public_key(self: @TState, issuer_id: felt252) -> felt252;
    /// The address allowed to revoke this issuer's credentials.
    fn issuer_operator(self: @TState, issuer_id: felt252) -> ContractAddress;
    /// Off-chain metadata (name, disclosure policy, contact) for this issuer.
    fn issuer_metadata_uri(self: @TState, issuer_id: felt252) -> ByteArray;
    /// Whether the issuer is registered and still allowed to attest.
    fn is_issuer_active(self: @TState, issuer_id: felt252) -> bool;
}

/// Issuer-scoped revocation of individual credentials.
///
/// Revocation is the issuer's power, not the registry owner's: an issuer that learns a subject no
/// longer qualifies must be able to withdraw the attestation without asking anyone.
#[starknet::interface]
pub trait IRevocationRegistry<TState> {
    /// Revokes one credential. Callable only by the issuer's registered operator.
    fn revoke(ref self: TState, issuer_id: felt252, credential_id: felt252);
    /// Whether this issuer has revoked this credential id.
    fn is_revoked(self: @TState, issuer_id: felt252, credential_id: felt252) -> bool;
    /// The issuer registry this contract reads operator rights from. Fixed at construction.
    fn issuer_registry(self: @TState) -> ContractAddress;
}

/// Named, versioned rule sets.
#[starknet::interface]
pub trait IPolicyRegistry<TState> {
    /// Publishes a policy under a fresh id. Owner only, and immutable afterwards.
    fn publish_policy(ref self: TState, policy_id: felt252, policy: Policy);
    /// Clears a published policy's `active` flag. Owner only, one-way.
    fn retire_policy(ref self: TState, policy_id: felt252);
    /// The policy published under `policy_id`. Panics with `CORDON_NO_POLICY` if there is none.
    fn get_policy(self: @TState, policy_id: felt252) -> Policy;
    /// Whether anything has ever been published under `policy_id`, retired or not.
    fn policy_exists(self: @TState, policy_id: felt252) -> bool;
}

/// The enforcement point: an anonymizer the privacy pool calls mid-transaction.
#[starknet::interface]
pub trait IPolicyGate<TState> {
    /// Runs one leg of a gated payment.
    ///
    /// Callable **only by the privacy pool this gate was constructed against**. `operation`
    /// selects the leg; see [`GateOperation`] for what each one carries and which action array the
    /// wallet builds for it. Every refusal panics, and a panic here reverts the pool transaction
    /// whole, so value that fails a policy never leaves the shielded set.
    ///
    /// `pool_address` is the wallet's `${poolAddress}` substitution. It is untrusted calldata and
    /// is cross-checked against the stored pool; it never decides who receives an allowance.
    /// `note_id` is `${openNoteIds[0]}`; the `Fund` leg fills no note and must pass `0`.
    fn privacy_invoke(
        ref self: TState,
        operation: GateOperation,
        token: ContractAddress,
        pool_address: ContractAddress,
        note_id: felt252,
    ) -> Span<OpenNoteDeposit>;
    /// The privacy pool this gate serves. Fixed at construction and never changes.
    fn privacy_pool(self: @TState) -> ContractAddress;
    /// The settlement booked under `settlement_id`. Reads back with
    /// [`SettlementStatus::None`](crate::types::SettlementStatus) if there is none.
    fn get_settlement(self: @TState, settlement_id: felt252) -> Settlement;
    /// Value the gate's own ledger says it holds in one token: open settlements plus anything a
    /// leg has not yet released. Everything above this in the real balance is unaccounted dust.
    fn accounted_balance(self: @TState, token: ContractAddress) -> u128;
    /// Whether this `(subject_public_key, nonce)` pair has already been spent, on any leg.
    fn is_nonce_used(self: @TState, subject_public_key: felt252, nonce: felt252) -> bool;
    /// Value already booked against a subject inside one epoch of one policy.
    fn epoch_spend(
        self: @TState, subject_public_key: felt252, policy_id: felt252, epoch_index: u64,
    ) -> u128;
    /// The epoch index a settlement would be booked into right now. Zero for policies with no
    /// velocity limit, and for an id that was never published.
    fn current_epoch(self: @TState, policy_id: felt252) -> u64;
    /// The registries this gate reads: `(issuer, revocation, policy)`. Fixed at construction.
    fn registries(self: @TState) -> (ContractAddress, ContractAddress, ContractAddress);
    /// Moves unaccounted dust — and only dust — out of the gate. Owner only.
    ///
    /// Returns the amount swept. Bounded by `balance_of - accounted_balance`, so no amount of
    /// owner mischief can reach a funded settlement.
    fn sweep(ref self: TState, token: ContractAddress, to: ContractAddress) -> u128;
}
