// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

//! Cairo anonymizer contracts for the starknet-privacy bridge: they move USDC
//! value between the privacy pool and Circle CCTP.
//!   - `outbound_anonymizer` — pool withdraw recipient → CCTP (the BUY leg).
//!   - `inbound_anonymizer`  — CCTP → pool (the RETURN leg).

pub mod inbound_anonymizer;
pub mod outbound_anonymizer;

#[cfg(test)]
pub mod test_mocks;
#[cfg(test)]
mod tests;
pub mod types;
