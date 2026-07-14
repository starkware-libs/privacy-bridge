//! Revert reasons for the inbound anonymizer. Internal-invariant guards live in
//! `internal_errors`.

/// `privacy_invoke_with_computation` caller is not the baked pool address.
pub const CALLER_NOT_POOL: felt252 = 'CALLER_NOT_POOL';
/// The attested message's hookData commitment does not equal the proven commitment.
pub const COMMITMENT_MISMATCH: felt252 = 'COMMITMENT_MISMATCH';
/// The attested message's destinationCaller is not this contract.
pub const DESTINATION_CALLER_MISMATCH: felt252 = 'DEST_CALLER_MISMATCH';
/// The CCTP receive observed no minted-balance delta.
pub const NOTHING_MINTED: felt252 = 'NOTHING_MINTED';
/// Message shorter than the read offset + 32.
pub const MESSAGE_TOO_SHORT: felt252 = 'MESSAGE_TOO_SHORT';
