//! Cairo anonymizer contracts for the starknet-privacy bridge: they move USDC
//! value between the privacy pool and Circle CCTP.
//!   - `outbound_anonymizer` — pool withdraw recipient → CCTP (the BUY leg).

pub mod outbound_anonymizer;

#[cfg(test)]
pub mod test_mocks;
#[cfg(test)]
mod tests;
pub mod types;
