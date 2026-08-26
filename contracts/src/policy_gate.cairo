//! The enforcement point: a privacy-pool anonymizer that only settles value the policy allows.

/// The gate the privacy pool calls mid-transaction.
///
/// ## How the pool calls this
///
/// The pool's `Invoke` action calls `selector!("privacy_invoke")` on this contract **after** it has
/// already transferred the withdrawn tokens here. There is no `amount` argument and there never
/// will be: the gate learns the value from its own `balance_of`, which is the only number the pool
/// will honour. Before returning, the gate `approve`s the pool for that amount and returns a
/// `Span<OpenNoteDeposit>` telling the pool which open note to fill.
///
/// The consequence that matters: **a panic anywhere in here reverts the entire pool transaction**.
/// The withdrawal, the transfer, the fee — all of it unwinds, and the value stays shielded. That
/// is why Cordon is a gate and not a report. There is no path where a refused payer moves funds
/// and gets a warning afterwards.
///
/// ## What it is not
///
/// The gate sees a plaintext balance, never note amounts. Caps and velocity are real because the
/// value routes through here. Rules over encrypted amounts are not possible and are not claimed.
#[starknet::contract]
pub mod PolicyGate {
    use core::ecdsa::check_ecdsa_signature;
    use core::num::traits::{CheckedAdd, Zero};
    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use starknet::storage::{
        Map, StoragePathEntry, StoragePointerReadAccess, StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_block_timestamp, get_caller_address, get_contract_address};
    use crate::errors::{ZERO_ADDRESS, gate as errors};
    use crate::hashing;
    use crate::interfaces::{
        IIssuerRegistryDispatcher, IIssuerRegistryDispatcherTrait, IPolicyGate,
        IPolicyRegistryDispatcher, IPolicyRegistryDispatcherTrait, IRevocationRegistryDispatcher,
        IRevocationRegistryDispatcherTrait,
    };
    use crate::types::{Credential, OpenNoteDeposit};

    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);

    #[abi(embed_v0)]
    impl OwnableMixinImpl = OwnableComponent::OwnableMixinImpl<ContractState>;
    impl OwnableInternalImpl = OwnableComponent::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        ownable: OwnableComponent::Storage,
        issuer_registry: ContractAddress,
        revocation_registry: ContractAddress,
        policy_registry: ContractAddress,
        /// `(subject_public_key, nonce) -> consumed`. Keyed by the pseudonym, never by an address,
        /// so replay protection costs the subject no privacy.
        used_nonces: Map<(felt252, felt252), bool>,
        /// `(subject_public_key, policy_id, epoch_index) -> value already settled`.
        epoch_spend: Map<(felt252, felt252, u64), u128>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        OwnableEvent: OwnableComponent::Event,
        PolicyPassed: PolicyPassed,
        RegistriesSet: RegistriesSet,
    }

    /// A settlement cleared every check and the pool was authorised to pull the value.
    ///
    /// This is the public record the gate monitor reads. It says a policy was satisfied and how
    /// much moved; it does not say who the payer or the payee is. `subject_public_key` is a
    /// locally generated pseudonym, and the transaction sender is a rotating relayer.
    #[derive(Drop, starknet::Event)]
    struct PolicyPassed {
        #[key]
        policy_id: felt252,
        #[key]
        subject_public_key: felt252,
        token: ContractAddress,
        amount: u128,
        epoch: u64,
    }

    /// The registries this gate trusts changed.
    #[derive(Drop, starknet::Event)]
    struct RegistriesSet {
        issuer_registry: ContractAddress,
        revocation_registry: ContractAddress,
        policy_registry: ContractAddress,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        owner: ContractAddress,
        issuer_registry: ContractAddress,
        revocation_registry: ContractAddress,
        policy_registry: ContractAddress,
    ) {
        self.ownable.initializer(owner);
        self._write_registries(issuer_registry, revocation_registry, policy_registry);
    }

    #[abi(embed_v0)]
    impl PolicyGateImpl of IPolicyGate<ContractState> {
        /// Gates one settlement of pool value against a published policy.
        ///
        /// The checks run in a fixed order, and each one has its own panic code so the UI can name
        /// the refusal instead of showing "reverted":
        ///
        /// 1. `CORDON_BAD_POOL` — the caller is the pool address the transaction names.
        /// 2. `CORDON_NO_POLICY` — the policy is published and active.
        ///    `CORDON_PAYEE_REQUIRED` — and it does not need a payee credential this entrypoint
        ///    cannot carry.
        /// 3. `CORDON_NO_VALUE` — the pool actually sent value.
        /// 4. `CORDON_BAD_ISSUER` — the issuer is registered, active, and the one the policy
        /// pins.
        /// 5. `CORDON_BAD_CRED` — the issuer signature over the credential hash verifies.
        /// 6. `CORDON_EXPIRED` — the credential has not lapsed.
        /// 7. `CORDON_REVOKED` — the issuer has not withdrawn it.
        /// 8. `CORDON_CLAIM_MISMATCH` — the claim is the one the policy asks for.
        /// 9. `CORDON_BAD_SUBJECT_SIG` — the subject authorised this exact settlement, and
        ///    `CORDON_NONCE_USED` — has not used this nonce before.
        /// 10. `CORDON_OVER_CAP` — the amount fits the per-transaction cap.
        /// 11. `CORDON_OVER_VELOCITY` — it fits what is left in this epoch.
        /// 12. The spend is booked and `PolicyPassed` is emitted.
        /// 13. The pool is approved for the amount and told which note to fill.
        ///
        /// The order is not arbitrary. Cheap, caller-controlled facts are checked before
        /// signature verification; the two limit checks are last because they are the ones a
        /// legitimate, fully credentialed payer can trip, and a user is better served by
        /// "over your cap" than by an earlier, vaguer refusal.
        ///
        /// The nonce is consumed *before* the limit checks, so a settlement that is refused for
        /// being over cap does not burn the subject's nonce — the whole transaction reverts, and
        /// the storage write reverts with it.
        ///
        /// # Arguments
        /// - `token` — the ERC20 the pool withdrew.
        /// - `pool_address` — the wallet substitutes `${poolAddress}`; must equal the caller.
        /// - `note_id` — the wallet substitutes `${openNoteIds[0]}`; the note to deposit into.
        /// - `policy_id` — which published rule set to enforce.
        /// - `payer` — the issuer-signed credential.
        /// - `payer_sig_r`, `payer_sig_s` — the subject's signature over
        ///   [`subject_action_hash`](crate::hashing::subject_action_hash), proving the pseudonym
        ///   holder authorised this settlement rather than a relayer replaying a credential.
        /// - `nonce` — subject-chosen, single-use.
        fn privacy_invoke(
            ref self: ContractState,
            token: ContractAddress,
            pool_address: ContractAddress,
            note_id: felt252,
            policy_id: felt252,
            payer: Credential,
            payer_sig_r: felt252,
            payer_sig_s: felt252,
            nonce: felt252,
        ) -> Span<OpenNoteDeposit> {
            // 1. Only the pool may drive this contract. Anyone else calling it would be gating
            //    tokens they sent themselves, which proves nothing and would burn a nonce.
            assert(pool_address.is_non_zero(), errors::BAD_POOL);
            assert(pool_address == get_caller_address(), errors::BAD_POOL);

            // 2. The rule set. `get_policy` panics with CORDON_NO_POLICY on an unknown id, so an
            //    unpublished policy can never fall through to a permissive zeroed default.
            let policy = IPolicyRegistryDispatcher { contract_address: self.policy_registry.read() }
                .get_policy(policy_id);
            assert(policy.active, errors::NO_POLICY);
            // A policy that demands a payee credential cannot be satisfied through this
            // entrypoint, which carries only the payer's. Refuse rather than quietly drop a check.
            assert(!policy.require_payee_credential, errors::PAYEE_REQUIRED);

            // 3. The value. The pool has already sent the tokens; our own balance is the amount,
            //    and there is deliberately no amount argument a caller could lie about.
            let erc20 = IERC20Dispatcher { contract_address: token };
            let balance = erc20.balance_of(get_contract_address());
            let amount: u128 = balance.try_into().expect(errors::AMOUNT_OVERFLOW);
            assert(amount.is_non_zero(), errors::NO_VALUE);

            // 4. The issuer. `issuer_public_key` answers zero for unknown *and* deactivated
            //    issuers, and a policy may pin one specific issuer.
            let issuer_public_key = IIssuerRegistryDispatcher {
                contract_address: self.issuer_registry.read(),
            }
                .issuer_public_key(payer.issuer_id);
            assert(issuer_public_key.is_non_zero(), errors::BAD_ISSUER);
            assert(
                policy.issuer_id.is_zero() || policy.issuer_id == payer.issuer_id,
                errors::BAD_ISSUER,
            );

            // 5. The attestation itself. Everything the credential asserts is inside this hash, so
            //    no field can be swapped underneath the issuer's signature.
            assert(
                check_ecdsa_signature(
                    message_hash: hashing::credential_hash(@payer),
                    public_key: issuer_public_key,
                    signature_r: payer.sig_r,
                    signature_s: payer.sig_s,
                ),
                errors::BAD_CRED,
            );

            // 6. Freshness. Strictly greater: a credential expiring exactly now is spent.
            assert(payer.expires_at > get_block_timestamp(), errors::EXPIRED);

            // 7. Revocation, which is how an issuer withdraws an attestation before it expires.
            assert(
                !IRevocationRegistryDispatcher { contract_address: self.revocation_registry.read() }
                    .is_revoked(payer.issuer_id, payer.credential_id),
                errors::REVOKED,
            );

            // 8. The claim has to be the one this policy asks for. A valid KYC_L2 credential is
            //    still the wrong credential for an ACCREDITED policy.
            assert(payer.claim == policy.required_claim, errors::CLAIM_MISMATCH);

            // 9. Control of the pseudonym, bound to this settlement. Without this, anyone holding
            //    a copy of a credential could spend against someone else's caps.
            assert(
                check_ecdsa_signature(
                    message_hash: hashing::subject_action_hash(
                        :policy_id, :note_id, :token, :amount, :nonce,
                    ),
                    public_key: payer.subject_public_key,
                    signature_r: payer_sig_r,
                    signature_s: payer_sig_s,
                ),
                errors::BAD_SUBJECT_SIG,
            );
            let nonce_slot = self.used_nonces.entry((payer.subject_public_key, nonce));
            assert(!nonce_slot.read(), errors::NONCE_USED);
            nonce_slot.write(true);

            // 10. The per-transaction cap. Zero means unlimited.
            assert(policy.max_amount.is_zero() || amount <= policy.max_amount, errors::OVER_CAP);

            // 11 + 12. Velocity. Booked against the pseudonym, so a subject cannot reset their
            //     rate by rotating wallets — the only thing a fresh wallet changes is who pays
            //     gas.
            let epoch = self._epoch_index(policy.epoch_length);
            if policy.epoch_length.is_non_zero() {
                let spend_slot = self
                    .epoch_spend
                    .entry((payer.subject_public_key, policy_id, epoch));
                // A `u128` overflow here is unreachable for any real token supply, but treating it
                // as "over velocity" keeps the refusal named rather than a raw arithmetic panic.
                let spent = spend_slot.read().checked_add(amount).expect(errors::OVER_VELOCITY);
                assert(spent <= policy.max_per_epoch, errors::OVER_VELOCITY);
                spend_slot.write(spent);
            }

            self
                .emit(
                    PolicyPassed {
                        policy_id,
                        subject_public_key: payer.subject_public_key,
                        token,
                        amount,
                        epoch,
                    },
                );

            // 13. Hand the value back. The pool pulls exactly `amount` and fills the open note.
            erc20.approve(spender: pool_address, amount: amount.into());
            [OpenNoteDeposit { note_id, token, amount }].span()
        }

        /// Whether this `(subject_public_key, nonce)` pair has already settled.
        fn is_nonce_used(
            self: @ContractState, subject_public_key: felt252, nonce: felt252,
        ) -> bool {
            self.used_nonces.entry((subject_public_key, nonce)).read()
        }

        /// Value already booked against a subject inside one epoch of one policy.
        fn epoch_spend(
            self: @ContractState, subject_public_key: felt252, policy_id: felt252, epoch_index: u64,
        ) -> u128 {
            self.epoch_spend.entry((subject_public_key, policy_id, epoch_index)).read()
        }

        /// The epoch index a settlement would be booked into right now.
        ///
        /// Zero for a policy with no velocity limit, where nothing is booked at all.
        fn current_epoch(self: @ContractState, policy_id: felt252) -> u64 {
            let policy = IPolicyRegistryDispatcher { contract_address: self.policy_registry.read() }
                .get_policy(policy_id);
            self._epoch_index(policy.epoch_length)
        }

        /// The registries this gate reads: `(issuer, revocation, policy)`.
        fn registries(self: @ContractState) -> (ContractAddress, ContractAddress, ContractAddress) {
            (
                self.issuer_registry.read(),
                self.revocation_registry.read(),
                self.policy_registry.read(),
            )
        }

        /// Re-points the registries. Owner only.
        ///
        /// Nonces and epoch spend are keyed by the subject pseudonym, not by any registry, so they
        /// survive a migration intact — a subject cannot clear their velocity by waiting for one.
        ///
        /// # Panics
        /// - `CORDON_ZERO_ADDRESS`, `Caller is not the owner`.
        fn set_registries(
            ref self: ContractState,
            issuer_registry: ContractAddress,
            revocation_registry: ContractAddress,
            policy_registry: ContractAddress,
        ) {
            self.ownable.assert_only_owner();
            self._write_registries(issuer_registry, revocation_registry, policy_registry);
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        /// Wall-clock time divided into fixed windows. Zero `epoch_length` means no velocity
        /// accounting, and the index is meaningless — it is reported as zero.
        fn _epoch_index(self: @ContractState, epoch_length: u64) -> u64 {
            if epoch_length.is_zero() {
                0
            } else {
                get_block_timestamp() / epoch_length
            }
        }

        fn _write_registries(
            ref self: ContractState,
            issuer_registry: ContractAddress,
            revocation_registry: ContractAddress,
            policy_registry: ContractAddress,
        ) {
            assert(
                issuer_registry.is_non_zero()
                    && revocation_registry.is_non_zero()
                    && policy_registry.is_non_zero(),
                ZERO_ADDRESS,
            );
            self.issuer_registry.write(issuer_registry);
            self.revocation_registry.write(revocation_registry);
            self.policy_registry.write(policy_registry);
            self.emit(RegistriesSet { issuer_registry, revocation_registry, policy_registry });
        }
    }
}
