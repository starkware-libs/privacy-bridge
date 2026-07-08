//! Internal invariants for the inbound anonymizer — these should never trigger
//! for a well-formed, Circle-attested message; they guard `try_into` unwraps.

/// CCTP minted amount (u256) does not fit u128.
pub const AMOUNT_OVERFLOW: felt252 = 'AMOUNT_OVERFLOW';
/// hookData 32-byte word exceeds the felt252 field.
pub const COMMITMENT_OVERFLOW: felt252 = 'COMMITMENT_OVERFLOW';
