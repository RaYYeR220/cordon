//! # Cordon
//!
//! A credential and policy gate for shielded STRK20 value on Starknet.
//!
//! Cordon is an *anonymizer* for the StarkWare privacy pool. Value physically routes through
//! [`PolicyGate`](policy_gate::PolicyGate) on its way back into a shielded note, so a policy is not
//! a report produced after the fact — it is a gate the pool cannot settle around. A payer who is
//! unaccredited, revoked, expired, over-cap or over-velocity cannot move pool funds at all: the
//! gate panics and the whole pool transaction reverts.
//!
//! The four contracts split cleanly along who governs what:
//!
//! | Contract                                                     | Governs
//! |
//! |--------------------------------------------------------------|---------------------------------------------|
//! | [`IssuerRegistry`](issuer_registry::IssuerRegistry)           | which keys may attest, and who
//! speaks for them |
//! | [`RevocationRegistry`](revocation_registry::RevocationRegistry) | which credentials an issuer
//! has withdrawn   |
//! | [`PolicyRegistry`](policy_registry::PolicyRegistry)           | the published, immutable rule
//! sets          |
//! | [`PolicyGate`](policy_gate::PolicyGate)                       | the enforcement point the pool
//! calls        |
//!
//! ## What Cordon can and cannot see
//!
//! The pool hands an anonymizer a plaintext ERC20 balance, never note amounts. Amount caps and
//! velocity limits are therefore genuinely enforceable — the value routes through this contract.
//! Rules over *encrypted* amounts are not, and Cordon does not claim them.
//!
//! Identities stay private: a credential subject is a `subject_public_key` pseudonym the holder
//! generates locally, never a wallet address.

pub mod errors;
pub mod hashing;
pub mod interfaces;
pub mod issuer_registry;
pub mod types;
