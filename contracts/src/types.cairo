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
    /// The only ERC20 this policy may move. Zero means any token.
    ///
    /// A policy pinned to a token is the allowlist: `token` on `privacy_invoke` is caller calldata
    /// with nothing behind it, and a fee-on-transfer or rebasing ERC20 breaks the ledger this
    /// contract keeps. Pin real deployments to the asset you actually intend to settle.
    pub token: ContractAddress,
    /// Maximum value that may pass the gate in a single settlement. Zero means unlimited.
    pub max_amount: u128,
    /// Length of a velocity epoch, in seconds. Zero disables velocity accounting entirely.
    ///
    /// Epochs are absolute tumbling windows (`timestamp / epoch_length`), so a subject who spends
    /// their whole budget just before a boundary and again just after moves `2 * max_per_epoch`
    /// in quick succession. Size the window with that in mind; the enforced bound is per window,
    /// not per rolling interval.
    pub epoch_length: u64,
    /// Aggregate value one subject may push through this policy inside a single epoch.
    /// Only meaningful when `epoch_length` is non-zero.
    pub max_per_epoch: u128,
    /// Whether the payee must also present a credential.
    ///
    /// The gate's `Direct` leg carries no payee credential, so it refuses to settle a policy with
    /// this flag set rather than silently ignoring the requirement. Two-step settlement
    /// (`Fund` then `Claim`) is how such a policy is satisfied.
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
    /// The address allowed to revoke credentials on this issuer's behalf, and the only address
    /// allowed to hand that right to someone else.
    pub operator: ContractAddress,
    /// Whether the issuer may still attest. Deactivation is permanent for a given `issuer_id`.
    pub active: bool,
}

/// Where a settlement stands. **Never reorder these variants and never move `#[default]`** — a
/// stored settlement is read back by variant index, so reordering silently reinterprets every
/// settlement already written.
///
/// `None` is the default a never-funded id reads back as, which is what makes "this settlement id
/// is free" a single comparison.
#[derive(Drop, Serde, Copy, PartialEq, Debug, starknet::Store, Default)]
pub enum SettlementStatus {
    /// Nothing has ever been funded under this id.
    #[default]
    None,
    /// Funded and waiting. The gate is holding the value.
    Funded,
    /// The payee presented a credential the claim policy accepts and took the value.
    Claimed,
    /// The window closed unclaimed and the payer took the value back.
    Refunded,
}

/// Value the gate is holding between a `Fund` and its `Claim` or `Refund`.
///
/// The gate is a custodian for exactly as long as this record says `Funded`. Everything needed to
/// resolve the settlement is here, because neither later leg can be trusted to restate it: the
/// claimant supplies only a settlement id and their own credential.
#[derive(Drop, Serde, Copy, PartialEq, Debug, starknet::Store)]
pub struct Settlement {
    /// The ERC20 held. Both later legs must name the same one.
    pub token: ContractAddress,
    /// The exact amount held. Read from here, never from `balance_of` — the gate can hold several
    /// settlements in the same token at once, plus dust nobody accounted for.
    pub amount: u128,
    /// The pseudonym that funded it, and the only one that can refund it.
    pub payer_subject_key: felt252,
    /// The pseudonym the payer named as the payee, and the only one that can claim it.
    ///
    /// Without this a settlement has no payee at all — only a *policy* — and any holder of a
    /// credential that policy accepts could take somebody else's money. The payer knows this key:
    /// it travels in the payment request alongside the claim policy.
    pub payee_subject_key: felt252,
    /// The policy the payer satisfied when funding. Bound into the refund signature.
    pub payer_policy_id: felt252,
    /// The policy the named payee has to satisfy to take the value.
    pub payee_claim_policy_id: felt252,
    /// Unix seconds. A claim must land before this; a refund cannot land before it.
    pub expires_at: u64,
    pub status: SettlementStatus,
}

/// A subject proving, in one call, both who they are and that they authorised this settlement.
///
/// The payer uses it on `Direct` and `Fund`; the payee uses the identical shape on `Claim`. One
/// type, because a payee check that drifted from a payer check would be a hole nobody notices.
#[derive(Drop, Serde, Copy, PartialEq, Debug)]
pub struct SubjectAuthorization {
    /// The published policy to enforce against the credential.
    pub policy_id: felt252,
    /// The issuer-signed credential.
    pub credential: Credential,
    /// The open note this authorisation is for, or
    /// [`NOTE_ANY`](crate::hashing::NOTE_ANY) when the signer could not know it.
    ///
    /// Naming the note is what makes a published authorisation useless to a thief: they would have
    /// to create a note with that id, and a note id commits to its owner's channel key. `NOTE_ANY`
    /// gives that up, so the gate demands a deadline in exchange and caps how far out it may be.
    pub note_binding: felt252,
    /// Unix seconds after which this authorisation is dead. Zero means no deadline, which is only
    /// allowed when `note_binding` names a note.
    pub valid_until: u64,
    /// The value this authorisation covers, in token base units.
    ///
    /// The gate takes the amount from here rather than from its own `balance_of`. `balance_of` is
    /// a permissionlessly writable global — anyone can transfer tokens to this contract — so
    /// deriving the amount from it lets a stranger inflate, deflate or block a payment the subject
    /// already signed. Here it is signed, and the balance is used only to check the gate can
    /// actually cover it.
    pub amount: u128,
    /// `r` of the subject's signature over
    /// [`subject_action_hash`](crate::hashing::subject_action_hash).
    pub sig_r: felt252,
    /// `s` of the same signature.
    pub sig_s: felt252,
    /// Subject-chosen, single-use per `(subject_public_key, nonce)`.
    pub nonce: felt252,
}

/// The terms a payer sets when funding a two-step settlement.
///
/// Every field here is inside the payer's signature, via
/// [`settlement_terms_hash`](crate::hashing::settlement_terms_hash). A payer authorises one
/// settlement with one payee under one claim policy expiring at one time — not "some escrow,
/// terms to be chosen by whoever assembles the transaction".
#[derive(Drop, Serde, Copy, PartialEq, Debug)]
pub struct FundTerms {
    /// The payer's own authorisation. The full payer policy is enforced on the funding leg.
    pub payer: SubjectAuthorization,
    /// Chosen by the payer, and the handle both later legs quote. Claimed once, ever.
    ///
    /// **Generate it at random.** Ids are single-use forever and funding is permissionless, so a
    /// predictable id (an invoice number, an agreed handle) can be burned ahead of you by anyone
    /// for the price of one unit. The SDK generates them; do not hand-pick them.
    pub settlement_id: felt252,
    /// The pseudonym allowed to claim. The payee's credential must name this exact key.
    pub payee_subject_key: felt252,
    /// The policy the payee will have to satisfy. Must already be published and active, and its
    /// per-transaction cap must fit the amount being funded.
    pub payee_claim_policy_id: felt252,
    /// When the claim window closes and the refund window opens.
    pub expires_at: u64,
}

/// A payee taking a funded settlement, authenticated by their own key.
///
/// This is the whole point of two-step settlement: the payer cannot vouch for the payee, so the
/// payee vouches for themselves, in their own transaction, at claim time.
#[derive(Drop, Serde, Copy, PartialEq, Debug)]
pub struct ClaimTerms {
    /// Which settlement to take. Bound into the payee's signature, so a claim authorisation
    /// cannot be pointed at a different settlement that happens to share a policy and an amount.
    pub settlement_id: felt252,
    /// The payee's issuer-signed credential. Its subject key must match the one the payer named.
    pub credential: Credential,
    /// The open note this authorisation is for, or
    /// [`NOTE_ANY`](crate::hashing::NOTE_ANY) when the signer could not know it.
    ///
    /// Naming the note is what makes a published authorisation useless to a thief: they would have
    /// to create a note with that id, and a note id commits to its owner's channel key. `NOTE_ANY`
    /// gives that up, so the gate demands a deadline in exchange and caps how far out it may be.
    pub note_binding: felt252,
    /// Unix seconds after which this authorisation is dead. Zero means no deadline, which is only
    /// allowed when `note_binding` names a note.
    pub valid_until: u64,
    /// `r` of the payee's signature over the action hash.
    pub sig_r: felt252,
    /// `s` of the same signature.
    pub sig_s: felt252,
    /// The payee's nonce, single-use per `(subject_public_key, nonce)`.
    pub nonce: felt252,
}

/// A payer taking back a settlement nobody claimed.
#[derive(Drop, Serde, Copy, PartialEq, Debug)]
pub struct RefundTerms {
    /// Which settlement to unwind. Bound into the payer's signature.
    pub settlement_id: felt252,
    /// The open note this authorisation is for, or
    /// [`NOTE_ANY`](crate::hashing::NOTE_ANY) when the signer could not know it.
    ///
    /// Naming the note is what makes a published authorisation useless to a thief: they would have
    /// to create a note with that id, and a note id commits to its owner's channel key. `NOTE_ANY`
    /// gives that up, so the gate demands a deadline in exchange and caps how far out it may be.
    pub note_binding: felt252,
    /// Unix seconds after which this authorisation is dead. Zero means no deadline, which is only
    /// allowed when `note_binding` names a note.
    pub valid_until: u64,
    /// `r` of the payer's signature over the action hash.
    pub sig_r: felt252,
    /// `s` of the same signature.
    pub sig_s: felt252,
    /// The payer's nonce for this refund. A refund is an authorisation like any other.
    pub nonce: felt252,
}

/// Which leg of which flow the pool is invoking.
///
/// One gate serves both a direct payment and the three legs of a two-step settlement, because the
/// pool calls a single `privacy_invoke` selector. Each variant carries exactly the data its leg
/// needs and nothing it does not, so no caller ever passes a field the contract ignores.
///
/// The leg is part of every signed message (see
/// [`subject_action_hash`](crate::hashing::subject_action_hash)), so an authorisation for one leg
/// cannot be executed as another — a `Direct` payment cannot be diverted into an escrow whose
/// terms the payer never saw.
///
/// **Never reorder these variants** — the discriminant is the first felt of the calldata.
#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub enum GateOperation {
    /// Payer policy only, settled straight into an open note.
    /// Action array: `withdraw → transfer(OPEN) → invoke`.
    Direct: SubjectAuthorization,
    /// Enforce the payer policy and park the value with the gate.
    /// Action array: `withdraw → invoke`. Returns an empty span: there is no note to fill yet.
    Fund: FundTerms,
    /// The payee's own transaction, taking a funded settlement into their note.
    /// Action array: `transfer(OPEN, recipient: self) → invoke`. The payee funds nothing.
    Claim: ClaimTerms,
    /// The payer taking back a settlement the window closed on.
    /// Action array: `transfer(OPEN, recipient: self) → invoke`.
    Refund: RefundTerms,
}
