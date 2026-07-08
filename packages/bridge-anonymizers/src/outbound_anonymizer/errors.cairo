//! Revert reasons for the outbound anonymizer.

/// `privacy_invoke` caller is not the baked pool address.
pub const CALLER_NOT_POOL: felt252 = 'CALLER_NOT_POOL';
/// Burn amount is zero.
pub const ZERO_AMOUNT: felt252 = 'ZERO_AMOUNT';
/// Burn amount is not strictly greater than the CCTP `max_fee`, so the whole
/// burn could be consumed by the fee and mint zero USDC.
pub const AMOUNT_LE_MAX_FEE: felt252 = 'AMOUNT_LE_MAX_FEE';
