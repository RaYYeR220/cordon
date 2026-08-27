//! The enforcement point: a privacy-pool anonymizer that only settles value the policy allows.

/// The gate the privacy pool calls mid-transaction.
///
/// ## How the pool calls this
///
/// The pool's `Invoke` action calls `selector!("privacy_invoke")` on this contract **after** it has
/// already transferred any withdrawn tokens here. Before returning, the gate `approve`s the pool
/// for the amount and returns a `Span<OpenNoteDeposit>` telling the pool which open note to fill.
/// Returning an empty span leaves the value with the gate.
///
/// The consequence that matters: **a panic anywhere in here reverts the entire pool transaction**.
/// The withdrawal, the transfer, the fee — all of it unwinds, and the value stays shielded. That
/// is why Cordon is a gate and not a report.
///
/// ## Who may call it
///
/// Only [`privacy_pool`](Self::privacy_pool), the address fixed at construction. The address the
/// wallet substitutes into the `pool_address` argument is untrusted calldata: it is cross-checked
/// against the stored pool and is never used to decide who receives an allowance. Comparing
/// caller-supplied calldata against the caller — which is what an earlier version of this
/// contract did — authenticates nothing at all, because any caller satisfies it by naming
/// themselves.
///
/// ## One selector, four legs
///
/// - [`Direct`](crate::types::GateOperation::Direct) — payer policy, straight into an open note.
/// - [`Fund`](crate::types::GateOperation::Fund) — payer policy, then park the value here and
///   return an **empty span**.
/// - [`Claim`](crate::types::GateOperation::Claim) — the named payee's own transaction, proving
///   with *their* key that they satisfy the claim policy, and taking the value.
/// - [`Refund`](crate::types::GateOperation::Refund) — the payer taking back what nobody claimed.
///
/// `Fund`/`Claim` exist because a payer cannot vouch for a payee. The gate never sees the
/// `transfer(OPEN)` recipient, and a note id is derived from a channel key it cannot recompute, so
/// there is no way in a single transaction to bind a payee credential to the address that actually
/// receives. Splitting the settlement is the sound answer: the payee authenticates themselves, in
/// their own private transaction, at the moment they take the money.
///
/// ## How the gate knows what it holds
///
/// It keeps its own ledger. `balance_of` is a permissionlessly writable global — anyone can
/// transfer tokens to this address — so the gate never treats it as an input. Amounts come from
/// signed authorisations and from stored settlements; the balance is consulted only to check that
/// the contract can cover what it is about to promise. Anything above the ledger is dust: harmless,
/// unusable by any leg it was not signed for, and removable only by [`sweep`](Self::sweep), which
/// cannot touch a funded settlement.
///
/// ## What it is not
///
/// The gate sees plaintext amounts, never note amounts. Caps and velocity are real because the
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
    use crate::errors::{
        ZERO_ADDRESS, gate as errors, settlement as settlement_errors, sweep as sweep_errors,
    };
    use crate::hashing;
    use crate::hashing::legs;
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
        /// The only address allowed to call `privacy_invoke`, and the only address ever approved.
        /// Written once, in the constructor.
        privacy_pool: ContractAddress,
        /// Written once, in the constructor. Re-pointing these would change what "credential"
        /// means for settlements that are already funded, which is a seizure, not a migration.
        issuer_registry: ContractAddress,
        revocation_registry: ContractAddress,
        policy_registry: ContractAddress,
        /// `(subject_public_key, nonce) -> consumed`. Keyed by the pseudonym, never by an address,
        /// so replay protection costs the subject no privacy. Shared across all four legs.
        used_nonces: Map<(felt252, felt252), bool>,
        /// `(subject_public_key, policy_id, epoch_index) -> value already settled`.
        epoch_spend: Map<(felt252, felt252, u64), u128>,
        /// `settlement_id -> Settlement`. Single-use ids: a settled id is never freed.
        settlements: Map<felt252, Settlement>,
        /// `token -> the gate's own accounting of what it holds`.
        ///
        /// The sum of every open settlement's amount. It is updated at the end of every leg, and
        /// it is what separates value the contract is responsible for from tokens that merely
        /// arrived. A leg may promise value only while `balance_of >= accounted + amount`, so no
        /// leg can spend an open settlement, and dust above the ledger is nobody's income.
        accounted: Map<ContractAddress, u128>,
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
        DustSwept: DustSwept,
    }

    /// A policy was satisfied and value moved on the strength of it.
    ///
    /// **No subject key appears in any Cordon event, and that is deliberate.** An event carrying
    /// the payer's pseudonym and one carrying the payee's, joinable through a settlement id, would
    /// publish a permanent, indexed edge between two counterparties and the exact amount that
    /// passed between them. A pseudonym lives as long as a credential does, so an indexer could
    /// rebuild each subject's whole payment graph from a log that was supposed to prove only that
    /// the rules held. Unlinkability is the property this contract exists to protect; the log
    /// records that a policy passed and how much moved, and stops there.
    #[derive(Drop, starknet::Event)]
    struct PolicyPassed {
        #[key]
        policy_id: felt252,
        token: ContractAddress,
        amount: u128,
        epoch: u64,
    }

    /// The payer cleared their policy and the gate is now holding the value.
    ///
    /// `settlement_id` must be generated at random by the payer — the SDK does this. It is the
    /// only handle in the log, and a guessable one would be both squattable in advance and a
    /// correlation key afterwards.
    #[derive(Drop, starknet::Event)]
    struct SettlementFunded {
        #[key]
        settlement_id: felt252,
        token: ContractAddress,
        amount: u128,
    }

    /// The named payee proved they satisfy the claim policy and took the value.
    #[derive(Drop, starknet::Event)]
    struct SettlementClaimed {
        #[key]
        settlement_id: felt252,
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

    /// Tokens that arrived outside the ledger were removed. Never touches a settlement.
    #[derive(Drop, starknet::Event)]
    struct DustSwept {
        #[key]
        token: ContractAddress,
        to: ContractAddress,
        amount: u128,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        owner: ContractAddress,
        privacy_pool: ContractAddress,
        issuer_registry: ContractAddress,
        revocation_registry: ContractAddress,
        policy_registry: ContractAddress,
    ) {
        self.ownable.initializer(owner);
        assert(
            privacy_pool.is_non_zero()
                && issuer_registry.is_non_zero()
                && revocation_registry.is_non_zero()
                && policy_registry.is_non_zero(),
            ZERO_ADDRESS,
        );
        self.privacy_pool.write(privacy_pool);
        self.issuer_registry.write(issuer_registry);
        self.revocation_registry.write(revocation_registry);
        self.policy_registry.write(policy_registry);
    }

    #[abi(embed_v0)]
    impl PolicyGateImpl of IPolicyGate<ContractState> {
        /// Runs one leg of a gated payment.
        ///
        /// Before any leg runs: the caller must be the stored privacy pool, the `pool_address`
        /// calldata must name that same pool, and no allowance may be outstanding to it.
        ///
        /// # Panics
        /// - `CORDON_BAD_POOL` — the caller is not the pool, or the calldata names another one.
        /// - `CORDON_STALE_ALLOWANCE` — an approval from an earlier leg was never consumed.
        ///
        /// Each leg's own checks and refusals are documented on its handler below.
        fn privacy_invoke(
            ref self: ContractState,
            operation: GateOperation,
            token: ContractAddress,
            pool_address: ContractAddress,
            note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            // Authentication, not a formality: `pool_address` is calldata and proves nothing on
            // its own, so the caller is checked against the pool fixed at construction. The
            // calldata is then required to agree with it, which keeps the value the subject signed
            // (`pool_address` is inside the action hash) and the value the gate acts on identical.
            let pool = self.privacy_pool.read();
            assert(get_caller_address() == pool, errors::BAD_POOL);
            assert(pool_address == pool, errors::BAD_POOL);

            // The pool consumes exactly what it is approved, in the same transaction. Anything
            // left over means an earlier leg did not complete the way this contract assumes, and
            // adding to it would let one approval be spent against another leg's value.
            let erc20 = IERC20Dispatcher { contract_address: token };
            assert(
                erc20.allowance(get_contract_address(), pool).is_zero(), errors::STALE_ALLOWANCE,
            );

            match operation {
                GateOperation::Direct(payer) => self._direct(payer, token, pool, note_id),
                GateOperation::Fund(terms) => self._fund(terms, token, pool, note_id),
                GateOperation::Claim(terms) => self._claim(terms, token, pool, note_id),
                GateOperation::Refund(terms) => self._refund(terms, token, pool, note_id),
            }
        }

        /// The privacy pool this gate serves. Fixed at construction and never changes.
        fn privacy_pool(self: @ContractState) -> ContractAddress {
            self.privacy_pool.read()
        }

        /// The settlement booked under `settlement_id`, or a zeroed record with status `None`.
        fn get_settlement(self: @ContractState, settlement_id: felt252) -> Settlement {
            self.settlements.entry(settlement_id).read()
        }

        /// Value the gate's own ledger says it owes in one token.
        fn accounted_balance(self: @ContractState, token: ContractAddress) -> u128 {
            self.accounted.entry(token).read()
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
        /// Zero for a policy with no velocity limit, and zero for an id that was never published
        /// —
        /// a view has no business panicking at a caller who asked about nothing.
        fn current_epoch(self: @ContractState, policy_id: felt252) -> u64 {
            let registry = IPolicyRegistryDispatcher {
                contract_address: self.policy_registry.read(),
            };
            if !registry.policy_exists(policy_id) {
                return 0;
            }
            self._epoch_index(registry.get_policy(policy_id).epoch_length)
        }

        /// The registries this gate reads: `(issuer, revocation, policy)`.
        ///
        /// There is no setter, on purpose. A registry pointer decides what a credential *means*;
        /// re-pointing one while a settlement is open would let whoever did it mint a credential
        /// that satisfies that settlement's claim policy and take the money. That is not a
        /// migration path, it is a seizure, and no timelock makes it something else. Migrate by
        /// deploying a new gate and letting the open settlements on this one run out.
        fn registries(self: @ContractState) -> (ContractAddress, ContractAddress, ContractAddress) {
            (
                self.issuer_registry.read(),
                self.revocation_registry.read(),
                self.policy_registry.read(),
            )
        }

        /// Moves unaccounted dust out of the gate. Owner only.
        ///
        /// Anyone can transfer tokens to this address; nothing stops them and nothing should. What
        /// matters is that such tokens never become spendable by a leg and never become
        /// unrecoverable. They sit above the ledger until the owner sweeps them.
        ///
        /// The bound is the whole safety property: the amount is computed as
        /// `balance_of - accounted`, so a funded settlement is arithmetically out of reach. An
        /// owner who calls this with every token in existence still cannot take a single unit of
        /// anybody's escrow.
        ///
        /// # Panics
        /// - `CORDON_NOTHING_TO_SWEEP` — the balance is exactly what the ledger says it should
        /// be.
        /// - `CORDON_ZERO_ADDRESS`, `Caller is not the owner`.
        fn sweep(ref self: ContractState, token: ContractAddress, to: ContractAddress) -> u128 {
            self.ownable.assert_only_owner();
            assert(to.is_non_zero(), ZERO_ADDRESS);

            let dust = self._unaccounted(token);
            assert(dust.is_non_zero(), sweep_errors::NOTHING_TO_SWEEP);

            IERC20Dispatcher { contract_address: token }
                .transfer(recipient: to, amount: dust.into());
            self.emit(DustSwept { token, to, amount: dust });
            dust
        }
    }

    #[generate_trait]
    impl LegsImpl of LegsTrait {
        /// `Direct` — a one-transaction gated payment.
        ///
        /// Checks, in order, each with its own panic code so the UI can name the refusal:
        ///
        /// 1. `CORDON_BAD_POOL` / `CORDON_STALE_ALLOWANCE` — handled by the caller.
        /// 2. `CORDON_NO_POLICY` — the policy is published and active.
        ///    `CORDON_TOKEN_NOT_ALLOWED` — and it permits this token.
        ///    `CORDON_PAYEE_REQUIRED` — and it does not need a payee credential, which this leg
        ///    cannot supply. A policy that needs one is served by `Fund`/`Claim`.
        /// 3. `CORDON_NO_VALUE` / `CORDON_UNDERFUNDED` — the signed amount is non-zero and the
        ///    gate is holding at least that much above its ledger.
        /// 4. `CORDON_BAD_ISSUER` — the issuer is registered, active, and the one the policy
        /// pins.
        /// 5. `CORDON_BAD_CRED` — the issuer signature over the credential hash verifies.
        /// 6. `CORDON_EXPIRED` — the credential has not lapsed.
        /// 7. `CORDON_REVOKED` — the issuer has not withdrawn it.
        /// 8. `CORDON_CLAIM_MISMATCH` — the claim is the one the policy asks for.
        /// 9. `CORDON_BAD_SUBJECT_SIG` — the subject authorised this exact leg, amount, note,
        ///    gate, pool and chain, and `CORDON_NONCE_USED` — has not used this nonce before.
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
            pool: ContractAddress,
            note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            let policy = self._active_policy(payer.policy_id, token);
            // This leg carries no payee credential, so a policy that demands one cannot be
            // satisfied here. Refuse rather than quietly drop a check.
            assert(!policy.require_payee_credential, errors::PAYEE_REQUIRED);

            let amount = payer.amount;
            self._assert_backed(token, amount);
            self._authorize(@payer, @policy, token, pool, legs::DIRECT, note_id, amount, 0);

            // The pool pulls `amount` straight back out, so the ledger is unchanged; whatever
            // arrived beyond `amount` stays above it as dust.
            self._approve_pool(token, pool, amount);
            [OpenNoteDeposit { note_id, token, amount }].span()
        }

        /// `Fund` — enforce the payer's policy, then hold the value for a named payee.
        ///
        /// The payer clears exactly what `Direct` makes them clear: cap, velocity, revocation,
        /// nonce, the lot. The difference is what happens afterwards — instead of filling an open
        /// note, the gate books a [`Settlement`] and returns an **empty span**, which tells the
        /// pool to leave the tokens here. The wallet's action array is `withdraw → invoke`; there
        /// is no `transfer(OPEN)` and so no note to sign over, and `note_id` must be `0`.
        ///
        /// Every term is inside the payer's signature. A payer authorises *this* settlement, for
        /// *this* payee, under *this* claim policy, expiring at *this* time — not "some escrow,
        /// terms to be filled in by whoever assembles the transaction".
        ///
        /// Unlike `Direct`, a policy with `require_payee_credential` is welcome here: this is the
        /// flow that satisfies it.
        ///
        /// # Panics
        /// Everything `Direct` can raise except `CORDON_PAYEE_REQUIRED`, plus:
        /// - `CORDON_NOTE_ID_NOT_ZERO` — this leg fills no note and must not name one.
        /// - `CORDON_ZERO_SETTLEMENT` — settlement id zero is reserved.
        /// - `CORDON_ZERO_PAYEE` — a settlement with no payee could be taken by anyone.
        /// - `CORDON_SETTLEMENT_EXISTS` — that id has been used before, open or settled.
        /// - `CORDON_BAD_EXPIRY` — the claim window would close in the past.
        /// - `CORDON_NO_POLICY` / `CORDON_TOKEN_NOT_ALLOWED` — the claim policy is unpublished,
        ///   retired, or pinned to a different token.
        /// - `CORDON_PAYEE_OVER_CAP` — the amount does not fit the claim policy's per-transaction
        ///   cap, so no claim could ever succeed. Refused now rather than after the money is
        ///   committed and the payee has shipped.
        fn _fund(
            ref self: ContractState,
            terms: FundTerms,
            token: ContractAddress,
            pool: ContractAddress,
            note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            let FundTerms {
                payer, settlement_id, payee_subject_key, payee_claim_policy_id, expires_at,
            } = terms;

            assert(note_id.is_zero(), settlement_errors::NOTE_ID_NOT_ZERO);
            assert(settlement_id.is_non_zero(), settlement_errors::ZERO_SETTLEMENT_ID);
            assert(payee_subject_key.is_non_zero(), settlement_errors::ZERO_PAYEE);
            let slot = self.settlements.entry(settlement_id);
            assert(
                slot.status.read() == SettlementStatus::None, settlement_errors::SETTLEMENT_EXISTS,
            );
            assert(expires_at > get_block_timestamp(), settlement_errors::BAD_EXPIRY);

            let policy = self._active_policy(payer.policy_id, token);

            // Resolve the claim policy now and hold it to the amount being funded. Booking a
            // settlement that no claim can satisfy is not a neutral act: the payee ships against a
            // `SettlementFunded` event they can see and then finds every claim refused, and the
            // payer's money is locked until the window closes. The previous version of this
            // contract fetched this policy and discarded it, with a comment above the line stating
            // the very principle the line broke.
            let claim_policy = self._active_policy(payee_claim_policy_id, token);
            let amount = payer.amount;
            assert(
                claim_policy.max_amount.is_zero() || amount <= claim_policy.max_amount,
                settlement_errors::PAYEE_OVER_CAP,
            );

            self._assert_backed(token, amount);
            self
                ._authorize(
                    @payer,
                    @policy,
                    token,
                    pool,
                    legs::FUND,
                    note_id,
                    amount,
                    hashing::fund_terms_hash(@terms),
                );

            slot
                .write(
                    Settlement {
                        token,
                        amount,
                        payer_subject_key: payer.credential.subject_public_key,
                        payee_subject_key,
                        payer_policy_id: payer.policy_id,
                        payee_claim_policy_id,
                        expires_at,
                        status: SettlementStatus::Funded,
                    },
                );
            // The value stays here, so the ledger grows by exactly what was funded.
            self._credit_ledger(token, amount);
            self.emit(SettlementFunded { settlement_id, token, amount });

            // No approval and no deposit: the pool leaves the value with the gate.
            [].span()
        }

        /// `Claim` — the named payee's own transaction, authenticated by the payee's own key.
        ///
        /// This is where payee compliance actually bites. The claimant must be the pseudonym the
        /// payer named at funding time — checked first, before any policy work — and must then
        /// present a credential and a signature made with the key that credential names, both
        /// checked against the claim policy the payer chose. Somebody whose issuer was
        /// deactivated, or whose credential was revoked between the funding and the claim,
        /// **cannot take the money**, and the refusal is a public, on-chain fact.
        ///
        /// The payee check is not a formality either. Without it a settlement has no payee at all,
        /// only a policy, and any holder of a credential that policy accepts — an ordinary
        /// customer of the same issuer, no forgery required — could read the settlement id out of
        /// the log and take somebody else's money.
        ///
        /// The value comes from the stored settlement, never from `balance_of`: the gate may be
        /// holding several settlements in the same token, plus dust. The pool sends nothing on
        /// this leg; if it did, the surplus simply stays as dust rather than being paid out.
        ///
        /// The claim policy's own cap and velocity apply to the payee. A receiving limit is a real
        /// control, and honouring `max_amount` for a payer while ignoring it for a payee would be
        /// exactly the silent drop this contract refuses to make elsewhere.
        ///
        /// # Panics
        /// - `CORDON_NO_SETTLEMENT` — nothing funded under this id.
        /// - `CORDON_ALREADY_CLAIMED` / `CORDON_ALREADY_REFUNDED` — it is already resolved.
        /// - `CORDON_TOKEN_MISMATCH` — the leg names a token the settlement does not hold.
        /// - `CORDON_NOT_THE_PAYEE` — the claimant is not who the payer named.
        /// - `CORDON_CLAIM_EXPIRED` — the window closed; the payer can refund now.
        /// - `CORDON_NO_POLICY` — the claim policy was retired while the settlement was open.
        /// - `CORDON_BAD_ISSUER`, `CORDON_BAD_CRED`, `CORDON_EXPIRED`, `CORDON_REVOKED`,
        ///   `CORDON_CLAIM_MISMATCH` — the payee's credential, checked exactly as a payer's is.
        /// - `CORDON_BAD_SUBJECT_SIG`, `CORDON_NONCE_USED` — the payee's authorisation.
        /// - `CORDON_OVER_CAP`, `CORDON_OVER_VELOCITY` — the payee's receiving limits.
        fn _claim(
            ref self: ContractState,
            terms: ClaimTerms,
            token: ContractAddress,
            pool: ContractAddress,
            note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            let ClaimTerms { settlement_id, credential, sig_r, sig_s, nonce } = terms;

            let slot = self.settlements.entry(settlement_id);
            let settlement = slot.read();
            self._assert_open(@settlement, token);

            // Who the payer meant to pay, before anything else is spent on this call.
            assert(
                credential.subject_public_key == settlement.payee_subject_key,
                settlement_errors::NOT_THE_PAYEE,
            );
            assert(settlement.expires_at > get_block_timestamp(), settlement_errors::CLAIM_EXPIRED);

            // Resolve the settlement before any external call, so the status can never be read
            // twice by a token that calls back in. Re-entry is already impossible — the caller
            // would be the token, not the pool — but ordering that does not depend on that
            // argument is cheaper than the argument.
            slot.status.write(SettlementStatus::Claimed);
            self._debit_ledger(token, settlement.amount);

            let policy = self._active_policy(settlement.payee_claim_policy_id, token);
            let payee = SubjectAuthorization {
                policy_id: settlement.payee_claim_policy_id,
                credential,
                amount: settlement.amount,
                sig_r,
                sig_s,
                nonce,
            };
            self
                ._authorize(
                    @payee,
                    @policy,
                    token,
                    pool,
                    legs::CLAIM,
                    note_id,
                    settlement.amount,
                    hashing::quoted_settlement_hash(settlement_id),
                );

            self.emit(SettlementClaimed { settlement_id, token, amount: settlement.amount });

            self._approve_pool(token, pool, settlement.amount);
            [OpenNoteDeposit { note_id, token, amount: settlement.amount }].span()
        }

        /// `Refund` — the payer taking back a settlement the window closed on.
        ///
        /// Signature-gated on the payer's pseudonym so a stranger cannot trigger someone else's
        /// refund, bound to the settlement id so one authorisation cannot be pointed at a
        /// different escrow, and time-gated so it cannot race a payee still inside their window.
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
        /// - `CORDON_TOKEN_MISMATCH`.
        /// - `CORDON_REFUND_TOO_EARLY` — the claim window is still open.
        /// - `CORDON_BAD_SUBJECT_SIG` — not signed by the pseudonym that funded it, or not for
        ///   this settlement, this leg, this pool.
        /// - `CORDON_NONCE_USED` — a refund authorisation is single-use like any other.
        fn _refund(
            ref self: ContractState,
            terms: RefundTerms,
            token: ContractAddress,
            pool: ContractAddress,
            note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            let RefundTerms { settlement_id, sig_r, sig_s, nonce } = terms;

            let slot = self.settlements.entry(settlement_id);
            let settlement = slot.read();
            self._assert_open(@settlement, token);
            assert(
                get_block_timestamp() >= settlement.expires_at, settlement_errors::REFUND_TOO_EARLY,
            );

            slot.status.write(SettlementStatus::Refunded);
            self._debit_ledger(token, settlement.amount);

            self
                ._assert_subject_signature(
                    settlement.payer_subject_key,
                    sig_r,
                    sig_s,
                    pool,
                    legs::REFUND,
                    settlement.payer_policy_id,
                    note_id,
                    token,
                    settlement.amount,
                    nonce,
                    hashing::quoted_settlement_hash(settlement_id),
                );
            self._consume_nonce(settlement.payer_subject_key, nonce);

            self.emit(SettlementRefunded { settlement_id, token, amount: settlement.amount });

            self._approve_pool(token, pool, settlement.amount);
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
            pool: ContractAddress,
            leg: felt252,
            note_id: felt252,
            amount: u128,
            terms_hash: felt252,
        ) {
            let credential = authorization.credential;
            self._assert_credential_valid(credential, policy);

            self
                ._assert_subject_signature(
                    *credential.subject_public_key,
                    *authorization.sig_r,
                    *authorization.sig_s,
                    pool,
                    leg,
                    *authorization.policy_id,
                    note_id,
                    token,
                    amount,
                    *authorization.nonce,
                    terms_hash,
                );
            self._consume_nonce(*credential.subject_public_key, *authorization.nonce);

            let epoch = self
                ._enforce_limits(
                    policy, *credential.subject_public_key, *authorization.policy_id, amount,
                );

            self.emit(PolicyPassed { policy_id: *authorization.policy_id, token, amount, epoch });
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

        /// Step 9: control of the pseudonym, bound to this leg, this settlement, this gate, this
        /// pool and this chain.
        ///
        /// Without it, anyone holding a copy of a credential could spend against someone else's
        /// caps; without the leg tag and the terms hash, one signature would authorise several
        /// different transactions and the signer would only ever have meant one of them.
        fn _assert_subject_signature(
            self: @ContractState,
            subject_public_key: felt252,
            sig_r: felt252,
            sig_s: felt252,
            pool: ContractAddress,
            leg: felt252,
            policy_id: felt252,
            note_id: felt252,
            token: ContractAddress,
            amount: u128,
            nonce: felt252,
            terms_hash: felt252,
        ) {
            assert(
                check_ecdsa_signature(
                    message_hash: hashing::subject_action_hash(
                        chain_id: get_tx_info().unbox().chain_id,
                        gate_address: get_contract_address(),
                        pool_address: pool,
                        :leg,
                        :policy_id,
                        :note_id,
                        :token,
                        :amount,
                        :nonce,
                        :terms_hash,
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
        /// The registry spans every leg and is keyed by pseudonym, so a subject's authorisations
        /// are single-use across the whole contract. It is a replay guard and only that: what an
        /// authorisation *means* is settled by the signed message, not here.
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

        /// Tokens the gate holds beyond what its ledger says it owes.
        fn _unaccounted(self: @ContractState, token: ContractAddress) -> u128 {
            let balance: u128 = IERC20Dispatcher { contract_address: token }
                .balance_of(get_contract_address())
                .try_into()
                .expect(errors::AMOUNT_OVERFLOW);
            balance
                .checked_sub(self.accounted.entry(token).read())
                .expect(errors::BALANCE_SHORTFALL)
        }

        /// Checks the gate can actually cover a promise of `amount` without touching what it owes
        /// to open settlements.
        ///
        /// This is the whole of the gate's relationship with `balance_of`: a solvency check, never
        /// an income measurement. The amount itself comes from a signature. That is what makes a
        /// stray transfer into this contract harmless — it cannot inflate a payment, deflate one,
        /// or block one — and what makes an under-funded leg fail closed rather than quietly
        /// paying itself out of somebody's escrow.
        fn _assert_backed(self: @ContractState, token: ContractAddress, amount: u128) {
            assert(amount.is_non_zero(), errors::NO_VALUE);
            assert(self._unaccounted(token) >= amount, errors::UNDERFUNDED);
        }

        /// Adds value the gate is now holding on someone's behalf.
        fn _credit_ledger(ref self: ContractState, token: ContractAddress, amount: u128) {
            let slot = self.accounted.entry(token);
            slot.write(slot.read().checked_add(amount).expect(errors::LEDGER_BROKEN));
        }

        /// Releases value the gate is no longer holding on anyone's behalf.
        fn _debit_ledger(ref self: ContractState, token: ContractAddress, amount: u128) {
            let slot = self.accounted.entry(token);
            slot.write(slot.read().checked_sub(amount).expect(errors::LEDGER_BROKEN));
        }

        /// A settlement that is still open, in the token the leg names.
        ///
        /// The status match is what makes every wrong resolution its own refusal rather than one
        /// blanket "not claimable": a second claim, a refund after a claim, and a claim against an
        /// id nobody ever funded are three different mistakes and deserve three different answers.
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
        }

        /// Hands the value back to the pool, which pulls exactly `amount` and fills the open note.
        ///
        /// The spender is always the pool fixed at construction — never an address that arrived
        /// in calldata. An allowance is the gate's only outward-facing power, and there is exactly
        /// one address it can ever be granted to.
        fn _approve_pool(
            self: @ContractState, token: ContractAddress, pool: ContractAddress, amount: u128,
        ) {
            IERC20Dispatcher { contract_address: token }
                .approve(spender: pool, amount: amount.into());
        }

        /// A published policy that is still in service and permits this token.
        ///
        /// `get_policy` panics with `CORDON_NO_POLICY` on an unknown id, so an unpublished policy
        /// can never fall through to a permissive zeroed default.
        fn _active_policy(
            self: @ContractState, policy_id: felt252, token: ContractAddress,
        ) -> Policy {
            let policy = IPolicyRegistryDispatcher { contract_address: self.policy_registry.read() }
                .get_policy(policy_id);
            assert(policy.active, errors::NO_POLICY);
            // `token` is calldata with nothing behind it. A policy that pins one is the allowlist:
            // it keeps a fee-on-transfer or rebasing ERC20, whose behaviour would break the
            // ledger this contract keeps, out of the flow entirely.
            assert(policy.token.is_zero() || policy.token == token, errors::TOKEN_NOT_ALLOWED);
            policy
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
    }
}
