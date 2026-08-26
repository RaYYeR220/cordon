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
    /// The caller is not the pool address the transaction claims to be settling through.
    pub const BAD_POOL: felt252 = 'CORDON_BAD_POOL';
    /// No policy is published under this id, or it has been retired.
    pub const NO_POLICY: felt252 = 'CORDON_NO_POLICY';
    /// The policy demands a payee credential, which this entrypoint cannot supply. Fail closed.
    pub const PAYEE_REQUIRED: felt252 = 'CORDON_PAYEE_REQUIRED';
    /// The pool sent nothing, so there is no value to gate.
    pub const NO_VALUE: felt252 = 'CORDON_NO_VALUE';
    /// The balance handed to the gate does not fit the pool's `u128` deposit amount.
    pub const AMOUNT_OVERFLOW: felt252 = 'CORDON_AMOUNT_OVERFLOW';
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
