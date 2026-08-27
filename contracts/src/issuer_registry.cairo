//! The set of keys allowed to attest.

/// Owner-governed registry of credential issuers.
///
/// Cordon deliberately keeps this small. It answers one question the gate asks on every
/// settlement — *is this issuer allowed to attest, and with which key?* — and one question the
/// revocation registry asks — *who speaks for this issuer?* Everything else about an issuer
/// (legal name, jurisdiction, what its claims mean) lives behind `metadata_uri`, off-chain, where
/// it can be updated without touching a key the whole system trusts.
#[starknet::contract]
pub mod IssuerRegistry {
    use core::num::traits::Zero;
    use openzeppelin::access::ownable::OwnableComponent;
    use starknet::storage::{
        Map, StoragePathEntry, StoragePointerReadAccess, StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_caller_address};
    use crate::errors::issuer_registry as errors;
    use crate::interfaces::IIssuerRegistry;
    use crate::types::Issuer;

    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);

    #[abi(embed_v0)]
    impl OwnableMixinImpl = OwnableComponent::OwnableMixinImpl<ContractState>;
    impl OwnableInternalImpl = OwnableComponent::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        ownable: OwnableComponent::Storage,
        /// `issuer_id -> Issuer`. A zero `public_key` means the id was never registered.
        issuers: Map<felt252, Issuer>,
        /// `issuer_id -> off-chain metadata URI`.
        metadata_uris: Map<felt252, ByteArray>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        OwnableEvent: OwnableComponent::Event,
        IssuerRegistered: IssuerRegistered,
        IssuerOperatorSet: IssuerOperatorSet,
        IssuerDeactivated: IssuerDeactivated,
    }

    /// A new issuer may now attest.
    #[derive(Drop, starknet::Event)]
    struct IssuerRegistered {
        #[key]
        issuer_id: felt252,
        public_key: felt252,
        metadata_uri: ByteArray,
    }

    /// The address allowed to revoke this issuer's credentials changed.
    #[derive(Drop, starknet::Event)]
    struct IssuerOperatorSet {
        #[key]
        issuer_id: felt252,
        operator: ContractAddress,
    }

    /// An issuer may no longer attest. Credentials it already signed stop verifying at the gate.
    #[derive(Drop, starknet::Event)]
    struct IssuerDeactivated {
        #[key]
        issuer_id: felt252,
    }

    /// Sets the registry owner, the only address that may register or deactivate issuers.
    #[constructor]
    fn constructor(ref self: ContractState, owner: ContractAddress) {
        self.ownable.initializer(owner);
    }

    #[abi(embed_v0)]
    impl IssuerRegistryImpl of IIssuerRegistry<ContractState> {
        /// Registers `issuer_id` as an active issuer attesting with `public_key`, with `operator`
        /// as the address that speaks for it.
        ///
        /// Enforces that the id is fresh: an id is claimed once and its key is never rebound.
        /// Rebinding would retroactively change the meaning of every credential already signed
        /// under that id, so a compromised key is handled by deactivating the id and registering a
        /// new one — which invalidates the old credentials rather than silently reauthorising
        /// them.
        ///
        /// The operator is set here rather than in a second transaction. Leaving it unset would
        /// open a window in which an issuer has live credentials it cannot revoke — precisely the
        /// window in which it would most want to.
        ///
        /// # Panics
        /// - `CORDON_ZERO_ISSUER_ID` — id zero is reserved for "any active issuer" in a policy.
        /// - `CORDON_ZERO_KEY` — a zero key is indistinguishable from an unknown issuer.
        /// - `CORDON_ZERO_OPERATOR` — an issuer that cannot revoke is not a usable issuer.
        /// - `CORDON_ISSUER_EXISTS` — the id is already claimed.
        /// - `Caller is not the owner`.
        fn register_issuer(
            ref self: ContractState,
            issuer_id: felt252,
            public_key: felt252,
            operator: ContractAddress,
            metadata_uri: ByteArray,
        ) {
            self.ownable.assert_only_owner();
            assert(issuer_id.is_non_zero(), errors::ZERO_ISSUER_ID);
            assert(public_key.is_non_zero(), errors::ZERO_PUBLIC_KEY);
            assert(operator.is_non_zero(), errors::ZERO_OPERATOR);

            let slot = self.issuers.entry(issuer_id);
            assert(slot.public_key.read().is_zero(), errors::ISSUER_EXISTS);

            slot.write(Issuer { public_key, operator, active: true });
            self.metadata_uris.entry(issuer_id).write(metadata_uri.clone());
            self.emit(IssuerRegistered { issuer_id, public_key, metadata_uri });
            self.emit(IssuerOperatorSet { issuer_id, operator });
        }

        /// Rotates the address allowed to revoke `issuer_id`'s credentials.
        ///
        /// **Callable only by the current operator, never by the registry owner.** This is the
        /// hinge the revocation registry's whole guarantee hangs on. An owner who could reassign
        /// the operator role could revoke any issuer's credentials in two transactions — take the
        /// role, then use it — and the promise that an issuer alone decides what its attestations
        /// mean would be worth nothing. The role starts with the issuer at registration and moves
        /// only by the issuer's own hand.
        ///
        /// The operator is a hot address that sends transactions; the attesting key is offline.
        /// Rotating the hot one must not disturb the cold one, which is why this exists at all.
        ///
        /// # Panics
        /// - `CORDON_UNKNOWN_ISSUER` — nothing registered under this id.
        /// - `CORDON_ZERO_OPERATOR` — a zero address can never be a caller.
        /// - `CORDON_NOT_OPERATOR` — the caller does not currently hold the role.
        fn set_issuer_operator(
            ref self: ContractState, issuer_id: felt252, operator: ContractAddress,
        ) {
            assert(operator.is_non_zero(), errors::ZERO_OPERATOR);

            let slot = self.issuers.entry(issuer_id);
            assert(slot.public_key.read().is_non_zero(), errors::UNKNOWN_ISSUER);
            assert(slot.operator.read() == get_caller_address(), errors::NOT_OPERATOR);

            slot.operator.write(operator);
            self.emit(IssuerOperatorSet { issuer_id, operator });
        }

        /// Stops `issuer_id` attesting. Permanent for that id.
        ///
        /// This is the blunt instrument: from the next block, every credential signed by this
        /// issuer fails at the gate with `CORDON_BAD_ISSUER`, because
        /// [`issuer_public_key`] starts answering zero. Use the revocation registry when the
        /// problem is one credential rather than the issuer.
        ///
        /// # Panics
        /// - `CORDON_UNKNOWN_ISSUER` — nothing registered under this id.
        /// - `CORDON_ALREADY_INACTIVE` — already deactivated.
        /// - `Caller is not the owner`.
        fn deactivate_issuer(ref self: ContractState, issuer_id: felt252) {
            self.ownable.assert_only_owner();

            let slot = self.issuers.entry(issuer_id);
            assert(slot.public_key.read().is_non_zero(), errors::UNKNOWN_ISSUER);
            assert(slot.active.read(), errors::ALREADY_INACTIVE);

            slot.active.write(false);
            self.emit(IssuerDeactivated { issuer_id });
        }

        /// The key the gate verifies this issuer's credential signatures against.
        ///
        /// Answers zero for an unknown *or* deactivated issuer, collapsing both cases into the
        /// single check the gate needs. A zero key never verifies a signature, so a caller that
        /// forgets the active check still fails closed.
        fn issuer_public_key(self: @ContractState, issuer_id: felt252) -> felt252 {
            let issuer = self.issuers.entry(issuer_id).read();
            if issuer.active {
                issuer.public_key
            } else {
                Zero::zero()
            }
        }

        /// The address allowed to revoke this issuer's credentials.
        fn issuer_operator(self: @ContractState, issuer_id: felt252) -> ContractAddress {
            self.issuers.entry(issuer_id).operator.read()
        }

        /// Off-chain metadata URI for this issuer.
        fn issuer_metadata_uri(self: @ContractState, issuer_id: felt252) -> ByteArray {
            self.metadata_uris.entry(issuer_id).read()
        }

        /// Whether the issuer is registered and still allowed to attest.
        fn is_issuer_active(self: @ContractState, issuer_id: felt252) -> bool {
            let issuer = self.issuers.entry(issuer_id).read();
            issuer.public_key.is_non_zero() && issuer.active
        }
    }
}
