//! The enforcement point: a privacy-pool anonymizer that only settles value the policy allows.

/// The gate the privacy pool calls mid-transaction.
///
/// ## How the pool calls this
///
/// The pool's `Invoke` action calls `selector!("privacy_invoke")` on this contract **after** it has
/// already transferred any withdrawn tokens here. There is no `amount` argument and there never
/// will be: on the legs the pool funds, the gate learns the value from its own `balance_of`, which
/// is the only number the pool will honour. Before returning, the gate `approve`s the pool for
/// that amount and returns a `Span<OpenNoteDeposit>` telling the pool which open note to fill.
///
/// The consequence that matters: **a panic anywhere in here reverts the entire pool transaction**.
/// The withdrawal, the transfer, the fee — all of it unwinds, and the value stays shielded. That
/// is why Cordon is a gate and not a report. There is no path where a refused payer moves funds
/// and gets a warning afterwards.
///
/// ## One selector, four legs
///
/// The pool offers exactly one entrypoint, so the first parameter selects the leg:
///
/// - [`Direct`](crate::types::GateOperation::Direct) — payer policy, straight into an open note.
/// - [`Fund`](crate::types::GateOperation::Fund) — payer policy, then park the value here and
///   return an **empty span**: the pool leaves the tokens with the gate.
/// - [`Claim`](crate::types::GateOperation::Claim) — the payee's own transaction, proving with
///   *their* key that they satisfy the claim policy, and taking the value.
/// - [`Refund`](crate::types::GateOperation::Refund) — the payer taking back what nobody claimed.
///
/// `Fund`/`Claim` exist because a payer cannot vouch for a payee. The gate never sees the
/// `transfer(OPEN)` recipient, and a note id is derived from a channel key it cannot recompute, so
/// there is no way in a single transaction to bind a payee credential to the address that actually
/// receives. Splitting the settlement is the sound answer: the payee authenticates themselves, in
/// their own private transaction, at the moment they take the money. A claimant who is revoked or
/// uncredentialed simply cannot take it, and the refusal is on-chain.
///
/// ## What it is not
///
/// The gate sees a plaintext balance, never note amounts. Caps and velocity are real because the
/// value routes through here. Rules over encrypted amounts are not possible and are not claimed.
#[starknet::contract]
pub mod PolicyGate {
    use core::ecdsa::check_ecdsa_signature;
    use core::num::traits::{CheckedAdd, CheckedSub, Zero};
    use core::panic_with_felt252;
    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use starknet::storage::{
        Map, StoragePathEntry, StoragePointerReadAccess, StoragePointerWriteAccess,
    };
    use starknet::{
        ContractAddress, get_block_timestamp, get_caller_address, get_contract_address, get_tx_info,
    };
    use crate::errors::{ZERO_ADDRESS, gate as errors, settlement as settlement_errors};
    use crate::hashing;
    use crate::interfaces::{
        IIssuerRegistryDispatcher, IIssuerRegistryDispatcherTrait, IPolicyGate,
        IPolicyRegistryDispatcher, IPolicyRegistryDispatcherTrait, IRevocationRegistryDispatcher,
        IRevocationRegistryDispatcherTrait,
    };
    use crate::types::{
        ClaimTerms, Credential, FundTerms, GateOperation, OpenNoteDeposit, Policy, RefundTerms,
        Settlement, SettlementStatus, SubjectAuthorization,
    };

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
        /// so replay protection costs the subject no privacy. Shared across all four legs: that is
        /// what stops a signature for one leg being carried to another.
        used_nonces: Map<(felt252, felt252), bool>,
        /// `(subject_public_key, policy_id, epoch_index) -> value already settled`.
        epoch_spend: Map<(felt252, felt252, u64), u128>,
        /// `settlement_id -> Settlement`. Single-use ids: a settled id is never freed.
        settlements: Map<felt252, Settlement>,
        /// `token -> value the gate owes to settlements that are still open`.
        ///
        /// Without this the gate could not tell new value from money it is merely holding for
        /// someone: `balance_of` on a funding leg would read every open settlement as though the
        /// pool had just sent it. Free balance is `balance_of - committed`, and that difference is
        /// the only number any leg treats as new value.
        committed: Map<ContractAddress, u128>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        OwnableEvent: OwnableComponent::Event,
        PolicyPassed: PolicyPassed,
        SettlementFunded: SettlementFunded,
        SettlementClaimed: SettlementClaimed,
        SettlementRefunded: SettlementRefunded,
        RegistriesSet: RegistriesSet,
    }

    /// A subject cleared every check of a policy and value moved on the strength of it.
    ///
    /// Emitted on all three legs that enforce a policy: `Direct` and `Fund` name the payer,
    /// `Claim` names the payee. This is the public record the gate monitor reads. It says a policy
    /// was satisfied and how much moved; it does not say who the payer or the payee is.
    /// `subject_public_key` is a locally generated pseudonym, and the transaction sender is a
    /// rotating relayer.
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

    /// The payer cleared their policy and the gate is now holding the value.
    #[derive(Drop, starknet::Event)]
    struct SettlementFunded {
        #[key]
        settlement_id: felt252,
        #[key]
        payee_claim_policy_id: felt252,
        token: ContractAddress,
        amount: u128,
        expires_at: u64,
    }

    /// A payee proved they satisfy the claim policy and took the value.
    #[derive(Drop, starknet::Event)]
    struct SettlementClaimed {
        #[key]
        settlement_id: felt252,
        #[key]
        payee_subject_key: felt252,
        token: ContractAddress,
        amount: u128,
    }

    /// The claim window closed unclaimed and the payer took the value back.
    #[derive(Drop, starknet::Event)]
    struct SettlementRefunded {
        #[key]
        settlement_id: felt252,
        token: ContractAddress,
        amount: u128,
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
        /// Runs one leg of a gated payment.
        ///
        /// Whichever leg is selected, the first thing enforced is that the caller is the pool the
        /// transaction names — `CORDON_BAD_POOL`. After that the legs diverge; each one's checks
        /// and refusals are documented on its handler below.
        ///
        /// # Arguments
        /// - `operation` — the leg, with the data only that leg needs.
        /// - `token` — the ERC20 in play.
        /// - `pool_address` — the wallet substitutes `${poolAddress}`; must equal the caller.
        /// - `note_id` — the wallet substitutes `${openNoteIds[0]}`. `Fund` has no open note and
        ///   ignores it.
        fn privacy_invoke(
            ref self: ContractState,
            operation: GateOperation,
            token: ContractAddress,
            pool_address: ContractAddress,
            note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            // Only the pool may drive this contract. Anyone else calling it would be gating tokens
            // they sent themselves, which proves nothing and would burn a nonce.
            assert(pool_address.is_non_zero(), errors::BAD_POOL);
            assert(pool_address == get_caller_address(), errors::BAD_POOL);

            match operation {
                GateOperation::Direct(payer) => self._direct(payer, token, pool_address, note_id),
                GateOperation::Fund(terms) => self._fund(terms, token, note_id),
                GateOperation::Claim(terms) => self._claim(terms, token, pool_address, note_id),
                GateOperation::Refund(terms) => self._refund(terms, token, pool_address, note_id),
            }
        }

        /// The settlement booked under `settlement_id`, or a zeroed record with status `None`.
        fn get_settlement(self: @ContractState, settlement_id: felt252) -> Settlement {
            self.settlements.entry(settlement_id).read()
        }

        /// Value the gate owes to settlements that are still open, in one token.
        fn committed_balance(self: @ContractState, token: ContractAddress) -> u128 {
            self.committed.entry(token).read()
        }

        /// Whether this `(subject_public_key, nonce)` pair has already been spent, on any leg.
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
            self._epoch_index(self._policy(policy_id).epoch_length)
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
        /// Nonces, epoch spend and open settlements are keyed by the subject pseudonym or by a
        /// settlement id, not by any registry, so they survive a migration intact — a subject
        /// cannot clear their velocity by waiting for one.
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
    impl LegsImpl of LegsTrait {
        /// `Direct` — a one-transaction gated payment. Unchanged since the first release.
        ///
        /// Checks, in order, each with its own panic code so the UI can name the refusal:
        ///
        /// 1. `CORDON_BAD_POOL` — handled by the caller.
        /// 2. `CORDON_NO_POLICY` — the policy is published and active.
        ///    `CORDON_PAYEE_REQUIRED` — and it does not need a payee credential, which this leg
        ///    cannot supply. A policy that needs one is served by `Fund`/`Claim`, not by refusing
        ///    forever.
        /// 3. `CORDON_NO_VALUE` — the pool actually sent value.
        /// 4. `CORDON_BAD_ISSUER` — the issuer is registered, active, and the one the policy
        /// pins.
        /// 5. `CORDON_BAD_CRED` — the issuer signature over the credential hash verifies.
        /// 6. `CORDON_EXPIRED` — the credential has not lapsed.
        /// 7. `CORDON_REVOKED` — the issuer has not withdrawn it.
        /// 8. `CORDON_CLAIM_MISMATCH` — the claim is the one the policy asks for.
        /// 9. `CORDON_BAD_SUBJECT_SIG` — the subject authorised this exact settlement at this
        ///    exact gate, and `CORDON_NONCE_USED` — has not used this nonce before.
        /// 10. `CORDON_OVER_CAP` — the amount fits the per-transaction cap.
        /// 11. `CORDON_OVER_VELOCITY` — it fits what is left in this epoch.
        /// 12. The spend is booked and `PolicyPassed` is emitted.
        /// 13. The pool is approved for the amount and told which note to fill.
        ///
        /// The order is not arbitrary. Cheap, caller-controlled facts are checked before signature
        /// verification; the two limit checks are last because they are the ones a legitimate,
        /// fully credentialed payer can trip, and a user is better served by "over your cap" than
        /// by an earlier, vaguer refusal.
        fn _direct(
            ref self: ContractState,
            payer: SubjectAuthorization,
            token: ContractAddress,
            pool_address: ContractAddress,
            note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            let policy = self._active_policy(payer.policy_id);
            // This leg carries no payee credential, so a policy that demands one cannot be
            // satisfied here. Refuse rather than quietly drop a check.
            assert(!policy.require_payee_credential, errors::PAYEE_REQUIRED);

            let amount = self._value_received(token);
            self._authorize(@payer, @policy, token, note_id, amount);

            self._approve_pool(token, pool_address, amount);
            [OpenNoteDeposit { note_id, token, amount }].span()
        }

        /// `Fund` — enforce the payer's policy, then hold the value for a named claim policy.
        ///
        /// The payer clears exactly what `Direct` makes them clear: cap, velocity, revocation,
        /// nonce, the lot. The difference is what happens afterwards — instead of filling an open
        /// note, the gate books a [`Settlement`] and returns an **empty span**, which tells the
        /// pool to leave the tokens here. The wallet's action array is `withdraw → invoke`; there
        /// is no `transfer(OPEN)` and so no `note_id` to sign over, and the payer signs `0` in its
        /// place.
        ///
        /// Unlike `Direct`, a policy with `require_payee_credential` is welcome here: this is the
        /// flow that satisfies it.
        ///
        /// # Panics
        /// Everything `Direct` can raise except `CORDON_PAYEE_REQUIRED`, plus:
        /// - `CORDON_ZERO_SETTLEMENT` — settlement id zero is reserved.
        /// - `CORDON_SETTLEMENT_EXISTS` — that id has been used before, open or settled.
        /// - `CORDON_BAD_EXPIRY` — the claim window would close in the past.
        /// - `CORDON_NO_POLICY` — the claim policy is unpublished or retired. Checked *before*
        /// the
        ///   money moves, so a payer cannot strand value against a policy nobody can satisfy.
        fn _fund(
            ref self: ContractState, terms: FundTerms, token: ContractAddress, note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            let FundTerms { payer, settlement_id, payee_claim_policy_id, expires_at } = terms;

            assert(settlement_id.is_non_zero(), settlement_errors::ZERO_SETTLEMENT_ID);
            let slot = self.settlements.entry(settlement_id);
            assert(
                slot.status.read() == SettlementStatus::None, settlement_errors::SETTLEMENT_EXISTS,
            );
            assert(expires_at > get_block_timestamp(), settlement_errors::BAD_EXPIRY);

            let policy = self._active_policy(payer.policy_id);
            // Fail before the value is committed rather than after: funding into a claim policy
            // that is retired or was never published would strand the money until the refund
            // window opens.
            self._active_policy(payee_claim_policy_id);

            let amount = self._value_received(token);
            self._authorize(@payer, @policy, token, note_id, amount);

            slot
                .write(
                    Settlement {
                        token,
                        amount,
                        payer_subject_key: payer.credential.subject_public_key,
                        payer_policy_id: payer.policy_id,
                        payee_claim_policy_id,
                        expires_at,
                        status: SettlementStatus::Funded,
                    },
                );
            self._commit(token, amount);
            self
                .emit(
                    SettlementFunded {
                        settlement_id, payee_claim_policy_id, token, amount, expires_at,
                    },
                );

            // No approval and no deposit: the pool leaves the value with the gate.
            [].span()
        }

        /// `Claim` — the payee's own transaction, authenticated by the payee's own key.
        ///
        /// This is where payee compliance actually bites. The claimant presents a credential and a
        /// signature made with the key that credential names, and both are checked against the
        /// claim policy the payer chose at funding time. Somebody whose issuer was deactivated, or
        /// whose credential was revoked between the funding and the claim, **cannot take the
        /// money** — and the refusal is a public, on-chain fact rather than a note in a report.
        ///
        /// The value comes from the stored settlement, never from `balance_of`: the gate may be
        /// holding several settlements in the same token at once. The pool sends nothing on this
        /// leg — the action array is `transfer(OPEN, recipient: self) → invoke` and the payee
        /// funds nothing — so an unexpected balance means the caller built the wrong action
        /// array.
        ///
        /// The claim policy's own cap and velocity apply to the payee. A receiving limit is a real
        /// control, and honouring `max_amount` for a payer while ignoring it for a payee would be
        /// exactly the silent drop this contract refuses to make elsewhere.
        ///
        /// # Panics
        /// - `CORDON_NO_SETTLEMENT` — nothing funded under this id.
        /// - `CORDON_ALREADY_CLAIMED` / `CORDON_ALREADY_REFUNDED` — it is already resolved.
        /// - `CORDON_CLAIM_EXPIRED` — the window closed; the payer can refund now.
        /// - `CORDON_TOKEN_MISMATCH` — the leg names a token the settlement does not hold.
        /// - `CORDON_UNEXPECTED_VALUE` — the pool funded a leg that should carry nothing.
        /// - `CORDON_NO_POLICY` — the claim policy was retired while the settlement was open.
        /// - `CORDON_BAD_ISSUER`, `CORDON_BAD_CRED`, `CORDON_EXPIRED`, `CORDON_REVOKED`,
        ///   `CORDON_CLAIM_MISMATCH` — the payee's credential, checked exactly as a payer's is.
        /// - `CORDON_BAD_SUBJECT_SIG`, `CORDON_NONCE_USED` — the payee's authorisation.
        /// - `CORDON_OVER_CAP`, `CORDON_OVER_VELOCITY` — the payee's receiving limits.
        fn _claim(
            ref self: ContractState,
            terms: ClaimTerms,
            token: ContractAddress,
            pool_address: ContractAddress,
            note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            let ClaimTerms { settlement_id, credential, sig_r, sig_s, nonce } = terms;

            let slot = self.settlements.entry(settlement_id);
            let settlement = slot.read();
            self._assert_open(@settlement, token);
            assert(settlement.expires_at > get_block_timestamp(), settlement_errors::CLAIM_EXPIRED);

            let policy = self._active_policy(settlement.payee_claim_policy_id);
            let payee = SubjectAuthorization {
                policy_id: settlement.payee_claim_policy_id, credential, sig_r, sig_s, nonce,
            };
            self._authorize(@payee, @policy, token, note_id, settlement.amount);

            slot.status.write(SettlementStatus::Claimed);
            self._release(token, settlement.amount);
            self
                .emit(
                    SettlementClaimed {
                        settlement_id,
                        payee_subject_key: credential.subject_public_key,
                        token,
                        amount: settlement.amount,
                    },
                );

            self._approve_pool(token, pool_address, settlement.amount);
            [OpenNoteDeposit { note_id, token, amount: settlement.amount }].span()
        }

        /// `Refund` — the payer taking back a settlement the window closed on.
        ///
        /// Signature-gated on the payer's pseudonym so a stranger cannot trigger someone else's
        /// refund, and time-gated so it cannot race a payee who is still inside their window.
        ///
        /// It deliberately does **not** re-check the payer's credential: a settlement can easily
        /// outlive the credential that funded it, and holding a payer's own money hostage to a
        /// lapsed attestation would be punitive rather than protective. Nothing new leaves the
        /// gate — the value goes back where it came from.
        ///
        /// It also does not un-book the epoch spend the funding leg recorded. Velocity measures
        /// value a subject pushed through the gate in a window, and a refund does not retroactively
        /// unspend that window.
        ///
        /// # Panics
        /// - `CORDON_NO_SETTLEMENT`, `CORDON_ALREADY_CLAIMED`, `CORDON_ALREADY_REFUNDED`.
        /// - `CORDON_REFUND_TOO_EARLY` — the claim window is still open.
        /// - `CORDON_TOKEN_MISMATCH`, `CORDON_UNEXPECTED_VALUE`.
        /// - `CORDON_BAD_SUBJECT_SIG` — not signed by the pseudonym that funded it.
        /// - `CORDON_NONCE_USED` — a refund authorisation is single-use like any other.
        fn _refund(
            ref self: ContractState,
            terms: RefundTerms,
            token: ContractAddress,
            pool_address: ContractAddress,
            note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            let RefundTerms { settlement_id, sig_r, sig_s, nonce } = terms;

            let slot = self.settlements.entry(settlement_id);
            let settlement = slot.read();
            self._assert_open(@settlement, token);
            assert(
                get_block_timestamp() >= settlement.expires_at, settlement_errors::REFUND_TOO_EARLY,
            );

            self
                ._assert_subject_signature(
                    settlement.payer_subject_key,
                    sig_r,
                    sig_s,
                    settlement.payer_policy_id,
                    note_id,
                    token,
                    settlement.amount,
                    nonce,
                );
            self._consume_nonce(settlement.payer_subject_key, nonce);

            slot.status.write(SettlementStatus::Refunded);
            self._release(token, settlement.amount);
            self.emit(SettlementRefunded { settlement_id, token, amount: settlement.amount });

            self._approve_pool(token, pool_address, settlement.amount);
            [OpenNoteDeposit { note_id, token, amount: settlement.amount }].span()
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        /// The full credential-and-authorisation pipeline, shared by every leg that enforces a
        /// policy against a subject: `Direct` and `Fund` run it on the payer, `Claim` runs the
        /// identical thing on the payee.
        ///
        /// Sharing it is the point. A payee check that drifted from the payer check would be a
        /// compliance hole nobody would notice until it mattered.
        fn _authorize(
            ref self: ContractState,
            authorization: @SubjectAuthorization,
            policy: @Policy,
            token: ContractAddress,
            note_id: felt252,
            amount: u128,
        ) {
            let credential = authorization.credential;
            self._assert_credential_valid(credential, policy);

            self
                ._assert_subject_signature(
                    *credential.subject_public_key,
                    *authorization.sig_r,
                    *authorization.sig_s,
                    *authorization.policy_id,
                    note_id,
                    token,
                    amount,
                    *authorization.nonce,
                );
            self._consume_nonce(*credential.subject_public_key, *authorization.nonce);

            let epoch = self
                ._enforce_limits(
                    policy, *credential.subject_public_key, *authorization.policy_id, amount,
                );

            self
                .emit(
                    PolicyPassed {
                        policy_id: *authorization.policy_id,
                        subject_public_key: *credential.subject_public_key,
                        token,
                        amount,
                        epoch,
                    },
                );
        }

        /// Steps 4 to 8: the issuer is allowed to attest, it really signed this, and what it signed
        /// is still valid and is what the policy asked for.
        fn _assert_credential_valid(
            self: @ContractState, credential: @Credential, policy: @Policy,
        ) {
            // `issuer_public_key` answers zero for unknown *and* deactivated issuers, and a policy
            // may pin one specific issuer.
            let issuer_public_key = IIssuerRegistryDispatcher {
                contract_address: self.issuer_registry.read(),
            }
                .issuer_public_key(*credential.issuer_id);
            assert(issuer_public_key.is_non_zero(), errors::BAD_ISSUER);
            assert(
                (*policy.issuer_id).is_zero() || *policy.issuer_id == *credential.issuer_id,
                errors::BAD_ISSUER,
            );

            // Everything the credential asserts is inside this hash, so no field can be swapped
            // underneath the issuer's signature.
            assert(
                check_ecdsa_signature(
                    message_hash: hashing::credential_hash(credential),
                    public_key: issuer_public_key,
                    signature_r: *credential.sig_r,
                    signature_s: *credential.sig_s,
                ),
                errors::BAD_CRED,
            );

            // Strictly greater: a credential expiring exactly now is spent.
            assert(*credential.expires_at > get_block_timestamp(), errors::EXPIRED);

            assert(
                !IRevocationRegistryDispatcher { contract_address: self.revocation_registry.read() }
                    .is_revoked(*credential.issuer_id, *credential.credential_id),
                errors::REVOKED,
            );

            // A valid KYC_L2 credential is still the wrong credential for an ACCREDITED policy.
            assert(*credential.claim == *policy.required_claim, errors::CLAIM_MISMATCH);
        }

        /// Step 9: control of the pseudonym, bound to this settlement at this gate on this chain.
        ///
        /// Without it, anyone holding a copy of a credential could spend against someone else's
        /// caps, and a signature made for one deployment could be carried to another.
        fn _assert_subject_signature(
            self: @ContractState,
            subject_public_key: felt252,
            sig_r: felt252,
            sig_s: felt252,
            policy_id: felt252,
            note_id: felt252,
            token: ContractAddress,
            amount: u128,
            nonce: felt252,
        ) {
            assert(
                check_ecdsa_signature(
                    message_hash: hashing::subject_action_hash(
                        chain_id: get_tx_info().unbox().chain_id,
                        gate_address: get_contract_address(),
                        :policy_id,
                        :note_id,
                        :token,
                        :amount,
                        :nonce,
                    ),
                    public_key: subject_public_key,
                    signature_r: sig_r,
                    signature_s: sig_s,
                ),
                errors::BAD_SUBJECT_SIG,
            );
        }

        /// Burns a nonce, or refuses if it is already spent.
        ///
        /// The registry spans every leg, which is what lets the action hash leave the leg out of
        /// the signed message: a signature carried from one leg to another replays its nonce and
        /// dies here.
        fn _consume_nonce(ref self: ContractState, subject_public_key: felt252, nonce: felt252) {
            let slot = self.used_nonces.entry((subject_public_key, nonce));
            assert(!slot.read(), errors::NONCE_USED);
            slot.write(true);
        }

        /// Steps 10 and 11: the per-transaction cap, then the per-epoch aggregate. Returns the
        /// epoch the spend was booked into.
        ///
        /// Velocity is booked against the pseudonym, so a subject cannot reset their rate by
        /// rotating wallets — the only thing a fresh wallet changes is who pays gas.
        fn _enforce_limits(
            ref self: ContractState,
            policy: @Policy,
            subject_public_key: felt252,
            policy_id: felt252,
            amount: u128,
        ) -> u64 {
            // Zero means unlimited.
            assert(
                (*policy.max_amount).is_zero() || amount <= *policy.max_amount, errors::OVER_CAP,
            );

            let epoch = self._epoch_index(*policy.epoch_length);
            if (*policy.epoch_length).is_non_zero() {
                let spend_slot = self.epoch_spend.entry((subject_public_key, policy_id, epoch));
                // A `u128` overflow here is unreachable for any real token supply, but treating it
                // as "over velocity" keeps the refusal named rather than a raw arithmetic panic.
                let spent = spend_slot.read().checked_add(amount).expect(errors::OVER_VELOCITY);
                assert(spent <= *policy.max_per_epoch, errors::OVER_VELOCITY);
                spend_slot.write(spent);
            }
            epoch
        }

        /// Our balance, less what we already owe to open settlements.
        ///
        /// There is deliberately no amount argument a caller could lie about — the pool has
        /// already transferred before it calls, so the balance is the amount. Netting off
        /// `committed` is what keeps that true once the gate is also acting as a custodian.
        fn _free_balance(self: @ContractState, token: ContractAddress) -> u128 {
            let balance: u128 = IERC20Dispatcher { contract_address: token }
                .balance_of(get_contract_address())
                .try_into()
                .expect(errors::AMOUNT_OVERFLOW);
            balance
                .checked_sub(self.committed.entry(token).read())
                .expect(errors::BALANCE_SHORTFALL)
        }

        /// The free balance on a leg the pool funds, which must be non-zero.
        fn _value_received(self: @ContractState, token: ContractAddress) -> u128 {
            let amount = self._free_balance(token);
            assert(amount.is_non_zero(), errors::NO_VALUE);
            amount
        }

        /// A settlement that is still open, in the token the leg names, on a leg the pool did
        /// not fund.
        ///
        /// The status match is what makes every wrong resolution its own refusal rather than one
        /// blanket "not claimable": a second claim, a refund after a claim, and a claim against an
        /// id nobody ever funded are three different mistakes and deserve three different answers.
        ///
        /// The free-balance check refuses a leg the pool funded. `Claim` and `Refund` move value
        /// the gate is already holding, and the wallet builds them without a withdraw; tokens
        /// arriving alongside one mean the caller built the wrong action array, and letting that
        /// pass would strand the surplus here.
        fn _assert_open(self: @ContractState, settlement: @Settlement, token: ContractAddress) {
            match *settlement.status {
                SettlementStatus::None => panic_with_felt252(settlement_errors::NO_SETTLEMENT),
                SettlementStatus::Funded => {},
                SettlementStatus::Claimed => panic_with_felt252(settlement_errors::ALREADY_CLAIMED),
                SettlementStatus::Refunded => panic_with_felt252(
                    settlement_errors::ALREADY_REFUNDED,
                ),
            }
            assert(*settlement.token == token, settlement_errors::TOKEN_MISMATCH);
            assert(self._free_balance(token).is_zero(), settlement_errors::UNEXPECTED_VALUE);
        }

        /// Moves value into the gate's custodial obligation when a settlement opens.
        fn _commit(ref self: ContractState, token: ContractAddress, amount: u128) {
            let slot = self.committed.entry(token);
            slot.write(slot.read() + amount);
        }

        /// Releases it again when the settlement resolves, either way.
        fn _release(ref self: ContractState, token: ContractAddress, amount: u128) {
            let slot = self.committed.entry(token);
            slot.write(slot.read() - amount);
        }

        /// Hands the value back to the pool, which pulls exactly `amount` and fills the open note.
        fn _approve_pool(
            self: @ContractState,
            token: ContractAddress,
            pool_address: ContractAddress,
            amount: u128,
        ) {
            IERC20Dispatcher { contract_address: token }
                .approve(spender: pool_address, amount: amount.into());
        }

        /// A published policy that is still in service.
        ///
        /// `get_policy` panics with `CORDON_NO_POLICY` on an unknown id, so an unpublished policy
        /// can never fall through to a permissive zeroed default.
        fn _active_policy(self: @ContractState, policy_id: felt252) -> Policy {
            let policy = self._policy(policy_id);
            assert(policy.active, errors::NO_POLICY);
            policy
        }

        fn _policy(self: @ContractState, policy_id: felt252) -> Policy {
            IPolicyRegistryDispatcher { contract_address: self.policy_registry.read() }
                .get_policy(policy_id)
        }

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
