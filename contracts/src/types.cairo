//! Types shared across the Cordon contracts and reproduced by the off-chain SDK.

use starknet::ContractAddress;

/// A deposit instruction returned to the privacy pool at the end of `privacy_invoke`.
///
/// **This layout is an ABI contract, not an implementation detail.** It mirrors
/// `privacy::objects::OpenNoteDeposit` in the StarkWare privacy pool field for field. Cairo's
/// `Serde` is positional, so the declaration order *is* the wire format: reordering these fields
/// would make the pool misread every deposit. Do not touch it.
#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub struct OpenNoteDeposit {
    /// The identifier of the open note to deposit to.
    pub note_id: felt252,
    /// The ERC20 token contract to deposit.
    pub token: ContractAddress,
    /// The amount of tokens to deposit.
    pub amount: u128,
}

/// A published rule set. Immutable once published: to change a rule, publish a new `policy_id`.
///
/// The only field that can ever change after publication is `active`, and only from `true` to
/// `false` (see [`retire_policy`](crate::interfaces::IPolicyRegistry::retire_policy)). That keeps
/// the audit story simple — a decision recorded against a policy id can always be replayed
/// against the exact parameters that produced it.
#[derive(Drop, Serde, Copy, PartialEq, Debug, starknet::Store)]
pub struct Policy {
    /// The claim a credential must carry, e.g. `'ACCREDITED'`, `'KYC_L2'`, `'NOT_SANCTIONED'`.
    pub required_claim: felt252,
    /// The issuer that must have signed the credential. Zero means any active issuer will do.
    pub issuer_id: felt252,
    /// Maximum value that may pass the gate in a single settlement. Zero means unlimited.
    pub max_amount: u128,
    /// Length of a velocity epoch, in seconds. Zero disables velocity accounting entirely.
    pub epoch_length: u64,
    /// Aggregate value one subject may push through this policy inside a single epoch.
    /// Only meaningful when `epoch_length` is non-zero.
    pub max_per_epoch: u128,
    /// Whether the payee must also present a credential.
    ///
    /// The gate's `privacy_invoke` entrypoint carries no payee credential, so it refuses to settle
    /// a policy with this flag set rather than silently ignoring the requirement. Payee-side
    /// credentials are a future entrypoint, not a dropped check.
    pub require_payee_credential: bool,
    /// Whether the policy may still be used. Publication sets this; retirement clears it.
    pub active: bool,
}

/// An issuer-signed attestation about a pseudonymous subject.
///
/// `subject_public_key` is a STARK-curve public key the holder generates locally and keeps off
/// their wallet. It is the only identifier the chain ever sees, and it is what nonce replay
/// protection and epoch velocity accounting are keyed by.
#[derive(Drop, Serde, Copy, PartialEq, Debug)]
pub struct Credential {
    /// The issuer that signed this credential, as registered in the `IssuerRegistry`.
    pub issuer_id: felt252,
    /// Issuer-scoped identifier, used to revoke this specific credential.
    pub credential_id: felt252,
    /// The subject's pseudonymous STARK-curve public key. Never a wallet address.
    pub subject_public_key: felt252,
    /// The attested claim, matched against `Policy::required_claim`.
    pub claim: felt252,
    /// Unix seconds after which the credential is worthless.
    pub expires_at: u64,
    /// `r` of the issuer's STARK-curve signature over
    /// [`credential_hash`](crate::hashing::credential_hash).
    pub sig_r: felt252,
    /// `s` of the issuer's STARK-curve signature over
    /// [`credential_hash`](crate::hashing::credential_hash).
    pub sig_s: felt252,
}

/// A registered issuer, as stored by the `IssuerRegistry`.
#[derive(Drop, Serde, Copy, PartialEq, Debug, starknet::Store)]
pub struct Issuer {
    /// The STARK-curve public key whose signatures this issuer's credentials carry.
    pub public_key: felt252,
    /// The address allowed to revoke credentials on this issuer's behalf.
    pub operator: ContractAddress,
    /// Whether the issuer may still attest. Deactivation is permanent for a given `issuer_id`.
    pub active: bool,
}
