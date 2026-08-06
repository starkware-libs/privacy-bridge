// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

//! Internal invariants for the inbound anonymizer — these should never trigger
//! for a well-formed, Circle-attested message; they guard `try_into` unwraps.

/// CCTP minted amount (u256) does not fit u128.
pub const AMOUNT_OVERFLOW: felt252 = 'AMOUNT_OVERFLOW';
/// A 32-byte word read from the message exceeds the felt252 field.
pub const WORD_OVERFLOW: felt252 = 'WORD_OVERFLOW';
