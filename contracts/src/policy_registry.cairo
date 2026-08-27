//! Named, versioned rule sets.

/// Owner-governed registry of published policies.
///
/// A policy is immutable once published. Changing a rule means publishing a new `policy_id`, not
/// editing an old one — so a settlement recorded against `'PAY_ACCREDITED_V1'` can always be
/// replayed against exactly the parameters that let it through. The single exception is
/// [`retire_policy`], which clears `active` and nothing else; it is a one-way kill switch, and it
/// cannot be used to loosen a rule.
#[starknet::contract]
pub mod PolicyRegistry {
    use core::num::traits::Zero;
    use openzeppelin::access::ownable::OwnableComponent;
    use starknet::storage::{
        Map, StoragePathEntry, StoragePointerReadAccess, StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_block_timestamp};
    use crate::errors::policy_registry as errors;
    use crate::interfaces::IPolicyRegistry;
    use crate::types::Policy;

    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);

    #[abi(embed_v0)]
    impl OwnableMixinImpl = OwnableComponent::OwnableMixinImpl<ContractState>;
    impl OwnableInternalImpl = OwnableComponent::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        ownable: OwnableComponent::Storage,
        /// `policy_id -> Policy`.
        policies: Map<felt252, Policy>,
        /// `policy_id -> ever published`. Distinct from `Policy::active`, which a retired policy
        /// clears; this stays true so a retired id can never be reused for different rules.
        published: Map<felt252, bool>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        OwnableEvent: OwnableComponent::Event,
        PolicyPublished: PolicyPublished,
        PolicyRetired: PolicyRetired,
    }

    /// A new rule set is live. The full parameters are in the event so an indexer never has to
    /// trust a storage read to explain a past decision.
    #[derive(Drop, starknet::Event)]
    struct PolicyPublished {
        #[key]
        policy_id: felt252,
        required_claim: felt252,
        issuer_id: felt252,
        token: ContractAddress,
        max_amount: u128,
        epoch_length: u64,
        max_per_epoch: u128,
        require_payee_credential: bool,
        published_at: u64,
    }

    /// A rule set was taken out of service. Its parameters are unchanged and still readable.
    #[derive(Drop, starknet::Event)]
    struct PolicyRetired {
        #[key]
        policy_id: felt252,
        retired_at: u64,
    }

    #[constructor]
    fn constructor(ref self: ContractState, owner: ContractAddress) {
        self.ownable.initializer(owner);
    }

    #[abi(embed_v0)]
    impl PolicyRegistryImpl of IPolicyRegistry<ContractState> {
        /// Publishes `policy` under a fresh `policy_id`.
        ///
        /// Enforces that the id has never been used, which is what makes a policy id a stable
        /// citation. It also rejects the two shapes that would gate nothing: a zero
        /// `required_claim` (every credential matches) and a velocity epoch with a zero aggregate
        /// (no settlement can ever fit). `active` must be `true` — publishing something already
        /// dead is a mistake, and retirement has its own entrypoint.
        ///
        /// # Panics
        /// - `CORDON_ZERO_POLICY_ID` — id zero is reserved as "no policy".
        /// - `CORDON_POLICY_EXISTS` — the id is already published, retired or not.
        /// - `CORDON_ZERO_CLAIM` — the policy requires no claim.
        /// - `CORDON_ZERO_EPOCH_CAP` — velocity is on but the aggregate is zero.
        /// - `CORDON_INACTIVE_PUBLISH` — `active` is `false`.
        /// - `Caller is not the owner`.
        fn publish_policy(ref self: ContractState, policy_id: felt252, policy: Policy) {
            self.ownable.assert_only_owner();
            assert(policy_id.is_non_zero(), errors::ZERO_POLICY_ID);
            assert(!self.published.entry(policy_id).read(), errors::POLICY_EXISTS);
            assert(policy.required_claim.is_non_zero(), errors::ZERO_CLAIM);
            assert(policy.active, errors::INACTIVE_PUBLISH);
            assert(
                policy.epoch_length.is_zero() || policy.max_per_epoch.is_non_zero(),
                errors::ZERO_EPOCH_CAP,
            );

            self.policies.entry(policy_id).write(policy);
            self.published.entry(policy_id).write(true);

            let Policy {
                required_claim,
                issuer_id,
                token,
                max_amount,
                epoch_length,
                max_per_epoch,
                require_payee_credential,
                active: _,
            } = policy;
            self
                .emit(
                    PolicyPublished {
                        policy_id,
                        required_claim,
                        issuer_id,
                        token,
                        max_amount,
                        epoch_length,
                        max_per_epoch,
                        require_payee_credential,
                        published_at: get_block_timestamp(),
                    },
                );
        }

        /// Takes a policy out of service without altering a single rule parameter.
        ///
        /// From the next block the gate refuses it with `CORDON_NO_POLICY`. The parameters stay
        /// readable so past decisions remain explainable.
        ///
        /// # Panics
        /// - `CORDON_NO_POLICY` — nothing published under this id.
        /// - `CORDON_ALREADY_RETIRED` — already retired.
        /// - `Caller is not the owner`.
        fn retire_policy(ref self: ContractState, policy_id: felt252) {
            self.ownable.assert_only_owner();
            assert(self.published.entry(policy_id).read(), errors::NO_POLICY);

            let slot = self.policies.entry(policy_id);
            assert(slot.active.read(), errors::ALREADY_RETIRED);
            slot.active.write(false);

            self.emit(PolicyRetired { policy_id, retired_at: get_block_timestamp() });
        }

        /// The policy published under `policy_id`.
        ///
        /// Panics rather than returning a zeroed struct for an unknown id: a zeroed `Policy` has
        /// `max_amount == 0`, which this system reads as *unlimited*, so a silent default here
        /// would be a permissive default. Fail closed.
        ///
        /// # Panics
        /// - `CORDON_NO_POLICY` — nothing published under this id.
        fn get_policy(self: @ContractState, policy_id: felt252) -> Policy {
            assert(self.published.entry(policy_id).read(), errors::NO_POLICY);
            self.policies.entry(policy_id).read()
        }

        /// Whether anything has ever been published under `policy_id`, retired or not.
        fn policy_exists(self: @ContractState, policy_id: felt252) -> bool {
            self.published.entry(policy_id).read()
        }
    }
}
