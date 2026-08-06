// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

//! Shared types + interfaces used by both anonymizer contracts.

use starknet::ContractAddress;

/// A deposit into an open note, returned by an anonymizer for the pool to apply.
/// Byte-identical mirror of `privacy::objects::OpenNoteDeposit` so the pool's
/// `InvokeExternal` deserializes the returned span directly; mirrored locally to
/// avoid depending on the full pool crate.
#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub struct OpenNoteDeposit {
    /// The identifier of the open note to deposit to.
    pub note_id: felt252,
    /// The ERC20 token contract to deposit.
    pub token: ContractAddress,
    /// The amount of tokens to deposit.
    pub amount: u128,
}

/// Minimal ERC20 surface used by the anonymizers (`approve` + `balance_of`).
#[starknet::interface]
pub trait IERC20<TContractState> {
    fn approve(ref self: TContractState, spender: ContractAddress, amount: u256) -> bool;
    fn balance_of(self: @TContractState, account: ContractAddress) -> u256;
}
