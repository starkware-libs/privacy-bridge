//! `contracts_cairo` — Cairo anonymizer contracts for the starknet-privacy bridge.
//!
//! Two contracts move value between the privacy pool and CCTP:
//!   - `outbound_anonymizer` — pool withdraw recipient → CCTP (the BUY leg).
//!   - `inbound_anonymizer`  — CCTP → pool (the RETURN leg). [added in a later PR]
//!
//! FROZEN interfaces: see `docs/bridge-interface.md` in the source repo. The
//! shared `OpenNoteDeposit` type lives here at the crate root because both
//! contracts return it to the pool.

use starknet::ContractAddress;

/// Input for depositing to an open note (returned by an invoked contract).
///
/// Byte-identical mirror of `privacy::objects::OpenNoteDeposit` (the pool's
/// `InvokeExternal` deserializes the returned span into this shape). Mirrored
/// locally rather than depending on the `privacy` crate so this standalone
/// Scarb workspace need not pull the full pool + OZ + starkware_utils tree.
#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub struct OpenNoteDeposit {
    /// The identifier of the open note to deposit to.
    pub note_id: felt252,
    /// The ERC20 token contract to deposit.
    pub token: ContractAddress,
    /// The amount of tokens to deposit.
    pub amount: u128,
}

/// Minimal ERC20 surface used by both anonymizers (`approve` + `balance_of`).
/// Shared at the crate root because the outbound (approve-then-burn) and inbound
/// (balance delta + approve-the-pool) contracts both need it.
#[starknet::interface]
pub trait IERC20<TContractState> {
    fn approve(ref self: TContractState, spender: ContractAddress, amount: u256) -> bool;
    fn balance_of(self: @TContractState, account: ContractAddress) -> u256;
}

pub mod outbound_anonymizer;
