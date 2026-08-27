//! Issuer-scoped revocation of individual credentials.

/// Records which credentials an issuer has withdrawn.
///
/// The write path here belongs to the *issuer*, not to the registry owner. An issuer that learns a
/// subject no longer qualifies — a sanctions hit, a lapsed accreditation — has to be able to
/// pull the attestation immediately, without waiting on a governance action. The owner's only power
/// is to re-point the issuer registry this contract reads operator rights from.
///
/// Revocation is per `(issuer_id, credential_id)`. Two issuers can use the same credential id
/// without colliding, and one issuer revoking says nothing about another's attestations.
#[starknet::contract]
pub mod RevocationRegistry {
    use core::num::traits::Zero;
    use openzeppelin::access::ownable::OwnableComponent;
    use starknet::storage::{
        Map, StoragePathEntry, StoragePointerReadAccess, StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_block_timestamp, get_caller_address};
    use crate::errors::{ZERO_ADDRESS, revocation_registry as errors};
    use crate::interfaces::{
        IIssuerRegistryDispatcher, IIssuerRegistryDispatcherTrait, IRevocationRegistry,
    };

    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);

    #[abi(embed_v0)]
    impl OwnableMixinImpl = OwnableComponent::OwnableMixinImpl<ContractState>;
    impl OwnableInternalImpl = OwnableComponent::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        ownable: OwnableComponent::Storage,
        /// Where operator rights are read from.
        issuer_registry: ContractAddress,
        /// `(issuer_id, credential_id) -> revoked`.
        revoked: Map<(felt252, felt252), bool>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        OwnableEvent: OwnableComponent::Event,
        CredentialRevoked: CredentialRevoked,
        IssuerRegistrySet: IssuerRegistrySet,
    }

    /// An issuer withdrew one of its credentials. The gate refuses it from this block on.
    #[derive(Drop, starknet::Event)]
    struct CredentialRevoked {
        #[key]
        issuer_id: felt252,
        #[key]
        credential_id: felt252,
        revoked_at: u64,
    }

    /// The issuer registry backing operator checks changed.
    #[derive(Drop, starknet::Event)]
    struct IssuerRegistrySet {
        issuer_registry: ContractAddress,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState, owner: ContractAddress, issuer_registry: ContractAddress,
    ) {
        self.ownable.initializer(owner);
        assert(issuer_registry.is_non_zero(), ZERO_ADDRESS);
        self.issuer_registry.write(issuer_registry);
    }

    #[abi(embed_v0)]
    impl RevocationRegistryImpl of IRevocationRegistry<ContractState> {
        /// Revokes one credential, permanently.
        ///
        /// Enforces that the caller is the operator the issuer registry names for `issuer_id`.
        /// Anyone else is refused, and that includes this contract's owner and the issuer
        /// registry's owner: a compliance layer whose operator can revoke a competitor's
        /// credentials is worse than no layer at all.
        ///
        /// The guarantee is only as strong as the two things holding it up, so both are enforced
        /// rather than asserted in prose. The operator role rotates only by its current holder
        /// (`IssuerRegistry::set_issuer_operator`), and the registry this contract reads it from
        /// cannot be re-pointed. Remove either and the owner reaches this write path in two
        /// transactions: take the role, then use it.
        ///
        /// Revoking twice panics rather than passing silently: an operator repeating a revocation
        /// is usually acting on stale state, and a no-op would hide that.
        ///
        /// # Panics
        /// - `CORDON_NOT_OPERATOR` — the caller is not the issuer's operator, or the issuer has
        /// no
        ///   operator set.
        /// - `CORDON_ALREADY_REVOKED` — this credential is already revoked.
        fn revoke(ref self: ContractState, issuer_id: felt252, credential_id: felt252) {
            let operator = IIssuerRegistryDispatcher {
                contract_address: self.issuer_registry.read(),
            }
                .issuer_operator(issuer_id);
            assert(operator.is_non_zero(), errors::NOT_OPERATOR);
            assert(operator == get_caller_address(), errors::NOT_OPERATOR);

            let slot = self.revoked.entry((issuer_id, credential_id));
            assert(!slot.read(), errors::ALREADY_REVOKED);
            slot.write(true);

            self
                .emit(
                    CredentialRevoked {
                        issuer_id, credential_id, revoked_at: get_block_timestamp(),
                    },
                );
        }

        /// Whether this issuer has revoked this credential id.
        fn is_revoked(self: @ContractState, issuer_id: felt252, credential_id: felt252) -> bool {
            self.revoked.entry((issuer_id, credential_id)).read()
        }

        /// The issuer registry this contract reads operator rights from. Fixed at construction.
        fn issuer_registry(self: @ContractState) -> ContractAddress {
            self.issuer_registry.read()
        }
    }
}
