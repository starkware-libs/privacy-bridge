//! Revert reasons for the inbound anonymizer. Internal-invariant guards live in
//! `internal_errors`.

/// `privacy_invoke_with_computation` caller is not the baked pool address.
pub const CALLER_NOT_POOL: felt252 = 'CALLER_NOT_POOL';
/// `receive_and_bind` observed no minted-balance delta.
pub const NOTHING_MINTED: felt252 = 'NOTHING_MINTED';
/// Claim for a commitment with no bound balance.
pub const NOTHING_TO_CLAIM: felt252 = 'NOTHING_TO_CLAIM';
/// Message shorter than the fixed CCTP-v2 hookData offset + 32.
pub const MESSAGE_TOO_SHORT: felt252 = 'MESSAGE_TOO_SHORT';
