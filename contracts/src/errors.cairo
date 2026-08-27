//! Panic codes.
//!
//! Every refusal in Cordon has its own code. A pool transaction that hits one of these reverts
//! whole, and the code is the only thing that survives to tell a user *why*. They are part of the
//! public surface: `@cordon/sdk` decodes them into human refusals, so treat renaming one as a
//! breaking change.
//!
//! Short strings are capped at 31 characters; keep new codes inside that budget.

/// A zero contract address was supplied where a live contract is required. Shared by every
/// contract that stores a pointer to another one.
pub const ZERO_ADDRESS: felt252 = 'CORDON_ZERO_ADDRESS';

/// Refusals raised by [`PolicyGate::privacy_invoke`](crate::policy_gate::PolicyGate), in the order
/// the gate evaluates them.
pub mod gate {
    /// The caller is not the privacy pool this gate was deployed against, or the transaction
    /// names a different one in its calldata.
    pub const BAD_POOL: felt252 = 'CORDON_BAD_POOL';
    /// The gate still has an allowance outstanding to the pool from an earlier leg. The pool
    /// consumes exactly what it is approved, so a residue means something went wrong upstream and
    /// this leg refuses to add to it.
    pub const STALE_ALLOWANCE: felt252 = 'CORDON_STALE_ALLOWANCE';
    /// The policy pins a different ERC20 than the one this leg names.
    pub const TOKEN_NOT_ALLOWED: felt252 = 'CORDON_TOKEN_NOT_ALLOWED';
    /// No policy is published under this id, or it has been retired.
    pub const NO_POLICY: felt252 = 'CORDON_NO_POLICY';
    /// The policy demands a payee credential, which this entrypoint cannot supply. Fail closed.
    pub const PAYEE_REQUIRED: felt252 = 'CORDON_PAYEE_REQUIRED';
    /// The pool sent nothing, so there is no value to gate.
    pub const NO_VALUE: felt252 = 'CORDON_NO_VALUE';
    /// The balance handed to the gate does not fit the pool's `u128` deposit amount.
    pub const AMOUNT_OVERFLOW: felt252 = 'CORDON_AMOUNT_OVERFLOW';
    /// Less value arrived than the subject signed for, once value already owed to open
    /// settlements is set aside. The pool withdrew too little, or nothing at all.
    pub const UNDERFUNDED: felt252 = 'CORDON_UNDERFUNDED';
    /// The gate holds less than its own ledger says it owes.
    ///
    /// Reachable only if the ERC20 moves value out from under the contract — a fee-on-transfer
    /// token, a negative rebase, or an outright malicious one. Pin policies to a token you trust
    /// (`Policy::token`) and this stays out of reach.
    pub const BALANCE_SHORTFALL: felt252 = 'CORDON_BALANCE_SHORTFALL';
    /// The internal ledger would overflow or underflow. Named rather than left as a raw
    /// arithmetic panic, so every refusal still has a Cordon code.
    pub const LEDGER_BROKEN: felt252 = 'CORDON_LEDGER_BROKEN';
    /// The credential's issuer is unknown, deactivated, or not the issuer the policy pins.
    pub const BAD_ISSUER: felt252 = 'CORDON_BAD_ISSUER';
    /// The issuer signature over the credential hash does not verify.
    pub const BAD_CRED: felt252 = 'CORDON_BAD_CRED';
    /// The credential is past its `expires_at`.
    pub const EXPIRED: felt252 = 'CORDON_EXPIRED';
    /// The issuer has revoked this credential id.
    pub const REVOKED: felt252 = 'CORDON_REVOKED';
    /// The credential attests a claim the policy does not ask for.
    pub const CLAIM_MISMATCH: felt252 = 'CORDON_CLAIM_MISMATCH';
    /// The subject signature over the action hash does not verify against `subject_public_key`.
    pub const BAD_SUBJECT_SIG: felt252 = 'CORDON_BAD_SUBJECT_SIG';
    /// This `(subject_public_key, nonce)` pair has already settled once.
    pub const NONCE_USED: felt252 = 'CORDON_NONCE_USED';
    /// The settlement is larger than the policy's per-transaction cap.
    pub const OVER_CAP: felt252 = 'CORDON_OVER_CAP';
    /// The settlement would push this subject past the policy's per-epoch aggregate.
    pub const OVER_VELOCITY: felt252 = 'CORDON_OVER_VELOCITY';
    /// The transaction fills a different open note than the one the subject bound their
    /// authorisation to.
    pub const NOTE_MISMATCH: felt252 = 'CORDON_NOTE_MISMATCH';
    /// The authorisation's own deadline has passed.
    pub const AUTH_EXPIRED: felt252 = 'CORDON_AUTH_EXPIRED';
    /// An authorisation that names no note must carry a deadline, because a published one can be
    /// pointed at somebody else's note until it dies.
    pub const NEEDS_DEADLINE: felt252 = 'CORDON_NEEDS_DEADLINE';
    /// An unbound authorisation's deadline is further out than the gate is willing to accept.
    pub const WINDOW_TOO_LONG: felt252 = 'CORDON_WINDOW_TOO_LONG';
    /// The resolved note id collides with the `NOTE_ANY` sentinel. Astronomically improbable;
    /// checked so the sentinel can never be forged into a real binding.
    pub const NOTE_IS_SENTINEL: felt252 = 'CORDON_NOTE_IS_SENTINEL';
    /// The funding leg fills no note, so its binding is knowable and must be given.
    pub const FUND_NEEDS_BINDING: felt252 = 'CORDON_FUND_NEEDS_BINDING';
}

/// Refusals specific to two-step settlement — the `Fund`, `Claim` and `Refund` legs.
///
/// The credential checks on a claim reuse the [`gate`] codes above: a payee whose issuer was
/// deactivated is `CORDON_BAD_ISSUER`, a revoked payee is `CORDON_REVOKED`, and so on. The leg is
/// obvious from the transaction; duplicating the whole table with a `PAYEE_` prefix would only
/// double what an integrator has to learn.
pub mod settlement {
    /// Settlement id zero is reserved as "no settlement".
    pub const ZERO_SETTLEMENT_ID: felt252 = 'CORDON_ZERO_SETTLEMENT';
    /// This id has already been used. Ids are single-use, claimed or refunded or still open.
    pub const SETTLEMENT_EXISTS: felt252 = 'CORDON_SETTLEMENT_EXISTS';
    /// Nothing was ever funded under this id.
    pub const NO_SETTLEMENT: felt252 = 'CORDON_NO_SETTLEMENT';
    /// The value has already gone to the payee.
    pub const ALREADY_CLAIMED: felt252 = 'CORDON_ALREADY_CLAIMED';
    /// The value has already gone back to the payer.
    pub const ALREADY_REFUNDED: felt252 = 'CORDON_ALREADY_REFUNDED';
    /// The claim window has closed; only a refund is possible now.
    pub const CLAIM_EXPIRED: felt252 = 'CORDON_CLAIM_EXPIRED';
    /// The claim window is still open; the payee may yet turn up.
    pub const REFUND_TOO_EARLY: felt252 = 'CORDON_REFUND_TOO_EARLY';
    /// The claim window would close in the past, so nobody could ever claim.
    pub const BAD_EXPIRY: felt252 = 'CORDON_BAD_EXPIRY';
    /// The leg names a different token than the settlement holds.
    pub const TOKEN_MISMATCH: felt252 = 'CORDON_TOKEN_MISMATCH';
    /// The claimant is not the payee the payer named when funding.
    pub const NOT_THE_PAYEE: felt252 = 'CORDON_NOT_THE_PAYEE';
    /// A settlement with no payee could be taken by anyone the claim policy accepts.
    pub const ZERO_PAYEE: felt252 = 'CORDON_ZERO_PAYEE';
    /// The funding leg fills no open note, so it must not name one. Signed as `0`.
    pub const NOTE_ID_NOT_ZERO: felt252 = 'CORDON_NOTE_ID_NOT_ZERO';
    /// The amount does not fit the claim policy's per-transaction cap, so no claim could ever
    /// succeed. Refused at funding time rather than stranding the value for a whole window.
    pub const PAYEE_OVER_CAP: felt252 = 'CORDON_PAYEE_OVER_CAP';
}

/// Refusals raised by [`IssuerRegistry`](crate::issuer_registry::IssuerRegistry).
pub mod issuer_registry {
    /// `issuer_id` zero is reserved: `Policy::issuer_id == 0` means "any active issuer".
    pub const ZERO_ISSUER_ID: felt252 = 'CORDON_ZERO_ISSUER_ID';
    /// A zero public key would make `issuer_public_key` indistinguishable from "unknown".
    pub const ZERO_PUBLIC_KEY: felt252 = 'CORDON_ZERO_KEY';
    /// Issuer ids are claimed once. Register a new id rather than rebinding a key.
    pub const ISSUER_EXISTS: felt252 = 'CORDON_ISSUER_EXISTS';
    /// No issuer is registered under this id.
    pub const UNKNOWN_ISSUER: felt252 = 'CORDON_UNKNOWN_ISSUER';
    /// The issuer has already been deactivated.
    pub const ALREADY_INACTIVE: felt252 = 'CORDON_ALREADY_INACTIVE';
    /// A zero operator address can never be a caller, so it is rejected outright.
    pub const ZERO_OPERATOR: felt252 = 'CORDON_ZERO_OPERATOR';
    /// Only an issuer's current operator may hand the role on. Not even the registry owner can.
    pub const NOT_OPERATOR: felt252 = 'CORDON_NOT_OPERATOR';
}

/// Refusals raised by [`RevocationRegistry`](crate::revocation_registry::RevocationRegistry).
pub mod revocation_registry {
    /// The caller does not hold the operator role for this issuer.
    pub const NOT_OPERATOR: felt252 = 'CORDON_NOT_OPERATOR';
    /// This credential id is already revoked; revoking twice is a mistake worth surfacing.
    pub const ALREADY_REVOKED: felt252 = 'CORDON_ALREADY_REVOKED';
}

/// Refusals raised by [`PolicyRegistry`](crate::policy_registry::PolicyRegistry).
pub mod policy_registry {
    /// Policy id zero is reserved as "no policy".
    pub const ZERO_POLICY_ID: felt252 = 'CORDON_ZERO_POLICY_ID';
    /// A policy with no required claim would gate nothing.
    pub const ZERO_CLAIM: felt252 = 'CORDON_ZERO_CLAIM';
    /// Published policies are immutable; publish a new id instead.
    pub const POLICY_EXISTS: felt252 = 'CORDON_POLICY_EXISTS';
    /// Nothing is published under this id.
    pub const NO_POLICY: felt252 = 'CORDON_NO_POLICY';
    /// A policy must be published active. Retire it afterwards to take it out of service.
    pub const INACTIVE_PUBLISH: felt252 = 'CORDON_INACTIVE_PUBLISH';
    /// The policy is already retired.
    pub const ALREADY_RETIRED: felt252 = 'CORDON_ALREADY_RETIRED';
    /// A velocity epoch with a zero aggregate would refuse every settlement.
    pub const ZERO_EPOCH_CAP: felt252 = 'CORDON_ZERO_EPOCH_CAP';
}

/// Refusals raised by the owner-only sweep on [`PolicyGate`](crate::policy_gate::PolicyGate).
pub mod sweep {
    /// Nothing is unaccounted for; there is only value the gate owes to settlements.
    pub const NOTHING_TO_SWEEP: felt252 = 'CORDON_NOTHING_TO_SWEEP';
}
