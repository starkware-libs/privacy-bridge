// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

//! Test-only mocks of the external contracts the anonymizers talk to (the
//! contracts under test are the real ones):
//! - `MockTokenMessengerMinter` records the args + hook of the last CCTP burn.
//! - `MockUsdc` is a minimal ERC20 (`approve` + `balance_of`) with test-control
//!   hooks to seed/mint balances and read back the last `approve`.
//! - `MockMessageTransmitter` mimics CCTP `receive_message`: the destination_caller
//!   gate, nonce replay protection, and minting to the burn body's recipient.

use starknet::ContractAddress;

/// Snapshot of the last `deposit_for_burn` the messenger received.
#[derive(Copy, Drop, Serde, starknet::Store)]
pub struct BurnCall {
    pub amount: u256,
    pub destination_domain: u32,
    pub mint_recipient: u256,
    pub burn_token: ContractAddress,
    pub destination_caller: u256,
    pub max_fee: u256,
    pub min_finality_threshold: u32,
}

#[starknet::interface]
pub trait IMockMessengerControl<T> {
    /// Number of burn calls received (deposit_for_burn or *_with_hook).
    fn burn_count(self: @T) -> u32;
    /// Args of the most recent burn.
    fn last_burn(self: @T) -> BurnCall;
    /// hook_data of the most recent `deposit_for_burn_with_hook` (empty if the
    /// last burn was the hookless `deposit_for_burn`).
    fn last_hook(self: @T) -> ByteArray;
}

/// Mirror of OutboundAnonymizer's `ITokenMessengerMinterV2` param order.
#[starknet::interface]
pub trait IMockTokenMessenger<T> {
    fn deposit_for_burn(
        ref self: T,
        amount: u256,
        destination_domain: u32,
        mint_recipient: u256,
        burn_token: ContractAddress,
        destination_caller: u256,
        max_fee: u256,
        min_finality_threshold: u32,
    );
    fn deposit_for_burn_with_hook(
        ref self: T,
        amount: u256,
        destination_domain: u32,
        mint_recipient: u256,
        burn_token: ContractAddress,
        destination_caller: u256,
        max_fee: u256,
        min_finality_threshold: u32,
        hook_data: ByteArray,
    );
}

#[starknet::contract]
pub mod MockTokenMessengerMinter {
    use starknet::ContractAddress;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use super::{BurnCall, IMockMessengerControl, IMockTokenMessenger};

    #[storage]
    struct Storage {
        burn_count: u32,
        last: BurnCall,
        last_hook: ByteArray,
    }

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn record_burn(ref self: ContractState, call: BurnCall) {
            self.last.write(call);
            self.burn_count.write(self.burn_count.read() + 1);
        }
    }

    #[abi(embed_v0)]
    impl ControlImpl of IMockMessengerControl<ContractState> {
        fn burn_count(self: @ContractState) -> u32 {
            self.burn_count.read()
        }
        fn last_burn(self: @ContractState) -> BurnCall {
            self.last.read()
        }
        fn last_hook(self: @ContractState) -> ByteArray {
            self.last_hook.read()
        }
    }

    // The contract only ever calls the *_with_hook variant; the hookless
    // deposit_for_burn is kept for interface fidelity.
    #[abi(embed_v0)]
    impl MessengerImpl of IMockTokenMessenger<ContractState> {
        fn deposit_for_burn(
            ref self: ContractState,
            amount: u256,
            destination_domain: u32,
            mint_recipient: u256,
            burn_token: ContractAddress,
            destination_caller: u256,
            max_fee: u256,
            min_finality_threshold: u32,
        ) {
            self
                .record_burn(
                    BurnCall {
                        amount,
                        destination_domain,
                        mint_recipient,
                        burn_token,
                        destination_caller,
                        max_fee,
                        min_finality_threshold,
                    },
                );
        }

        fn deposit_for_burn_with_hook(
            ref self: ContractState,
            amount: u256,
            destination_domain: u32,
            mint_recipient: u256,
            burn_token: ContractAddress,
            destination_caller: u256,
            max_fee: u256,
            min_finality_threshold: u32,
            hook_data: ByteArray,
        ) {
            self
                .record_burn(
                    BurnCall {
                        amount,
                        destination_domain,
                        mint_recipient,
                        burn_token,
                        destination_caller,
                        max_fee,
                        min_finality_threshold,
                    },
                );
            self.last_hook.write(hook_data);
        }
    }
}

#[starknet::interface]
pub trait IMockUsdcControl<T> {
    /// Set the recorded balance for `account` (seeds `balance_of`).
    fn set_balance(ref self: T, account: ContractAddress, amount: u256);
    /// Add `amount` to `account`'s balance (models a CCTP mint, used by
    /// MockMessageTransmitter).
    fn mint(ref self: T, account: ContractAddress, amount: u256);
    /// Spender of the most recent `approve`.
    fn last_approve_spender(self: @T) -> ContractAddress;
    /// Amount of the most recent `approve`.
    fn last_approve_amount(self: @T) -> u256;
    /// Number of `approve` calls received.
    fn approve_count(self: @T) -> u32;
}

/// Minimal ERC20 mock: `approve` (used by the outbound burn) + `balance_of`
/// (used by the inbound balance-delta path).
#[starknet::interface]
pub trait IMockUsdc<T> {
    fn approve(ref self: T, spender: ContractAddress, amount: u256) -> bool;
    fn balance_of(self: @T, account: ContractAddress) -> u256;
}

#[starknet::contract]
pub mod MockUsdc {
    use starknet::ContractAddress;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use super::{IMockUsdc, IMockUsdcControl};

    #[storage]
    struct Storage {
        balances: Map<ContractAddress, u256>,
        last_approve_spender: ContractAddress,
        last_approve_amount: u256,
        approve_count: u32,
    }

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    impl ControlImpl of IMockUsdcControl<ContractState> {
        fn set_balance(ref self: ContractState, account: ContractAddress, amount: u256) {
            self.balances.write(account, amount);
        }
        fn mint(ref self: ContractState, account: ContractAddress, amount: u256) {
            self.balances.write(account, self.balances.read(account) + amount);
        }
        fn last_approve_spender(self: @ContractState) -> ContractAddress {
            self.last_approve_spender.read()
        }
        fn last_approve_amount(self: @ContractState) -> u256 {
            self.last_approve_amount.read()
        }
        fn approve_count(self: @ContractState) -> u32 {
            self.approve_count.read()
        }
    }

    #[abi(embed_v0)]
    impl Erc20Impl of IMockUsdc<ContractState> {
        fn approve(ref self: ContractState, spender: ContractAddress, amount: u256) -> bool {
            self.last_approve_spender.write(spender);
            self.last_approve_amount.write(amount);
            self.approve_count.write(self.approve_count.read() + 1);
            true
        }
        fn balance_of(self: @ContractState, account: ContractAddress) -> u256 {
            self.balances.read(account)
        }
    }
}

/// Read a big-endian 32-byte word from a ByteArray at `offset` (mirrors circlefin
/// `extract_u256_be` and the inbound contract's `parse_hook_commitment`). Test-only.
pub fn read_u256_be(byte_array: @ByteArray, offset: usize) -> u256 {
    let mut result: u256 = 0;
    let mut i: usize = 0;
    while i != 32 {
        let byte_val: u256 = byte_array.at(offset + i).unwrap().into();
        result = result * 256 + byte_val;
        i += 1;
    }
    result
}

/// Test control surface for the MockMessageTransmitter.
#[starknet::interface]
pub trait IMockTransmitterControl<T> {
    /// Number of successful `receive_message` calls.
    fn receive_count(self: @T) -> u32;
}

/// Faithful (for our purposes) mock of CCTP `MessageTransmitterV2.receive_message`:
/// enforces the outer message's `destination_caller` gate (offset 108) exactly like
/// the real contract (`get_caller_address().to_u256()`), rejects a reused `nonce`
/// (offset 12) for replay-proofness, then "mints" `amount` (burn-body offset 216)
/// to the burn body's `mint_recipient` (offset 184) via the linked MockUsdc. The
/// attestation is ignored (a real bad attestation would revert; tests exercising the
/// gate/replay/binding don't need signature crypto). Selector matches the inbound
/// contract's `IMessageTransmitterV2` dispatcher.
#[starknet::contract]
pub mod MockMessageTransmitter {
    use bridge_anonymizers::inbound_anonymizer::IMessageTransmitterV2;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_caller_address};
    use super::{
        IMockTransmitterControl, IMockUsdcControlDispatcher, IMockUsdcControlDispatcherTrait,
        read_u256_be,
    };

    // Absolute CCTP-v2 offsets (see inbound_anonymizer.cairo / polygonMint.ts).
    const NONCE_OFFSET: usize = 12;
    const DESTINATION_CALLER_OFFSET: usize = 108;
    const MINT_RECIPIENT_OFFSET: usize = 184; // header 148 + burn-body mintRecipient 36
    const AMOUNT_OFFSET: usize = 216; // header 148 + burn-body amount 68

    #[storage]
    struct Storage {
        usdc: ContractAddress,
        used_nonces: Map<u256, bool>,
        receive_count: u32,
    }

    #[constructor]
    fn constructor(ref self: ContractState, usdc: ContractAddress) {
        self.usdc.write(usdc);
    }

    #[abi(embed_v0)]
    impl ControlImpl of IMockTransmitterControl<ContractState> {
        fn receive_count(self: @ContractState) -> u32 {
            self.receive_count.read()
        }
    }

    #[abi(embed_v0)]
    impl TransmitterImpl of IMessageTransmitterV2<ContractState> {
        fn receive_message(
            ref self: ContractState, message: ByteArray, attestation: ByteArray,
        ) -> bool {
            // 1) destination_caller gate — identical to the real contract.
            let destination_caller = read_u256_be(@message, DESTINATION_CALLER_OFFSET);
            if destination_caller != 0 {
                let caller_felt: felt252 = get_caller_address().into();
                let caller_u256: u256 = caller_felt.into();
                assert(caller_u256 == destination_caller, 'INVALID_DESTINATION_CALLER');
            }
            // 2) nonce replay protection.
            let nonce = read_u256_be(@message, NONCE_OFFSET);
            assert(!self.used_nonces.read(nonce), 'NONCE_ALREADY_USED');
            self.used_nonces.write(nonce, true);
            // 3) mint to the burn body's mint_recipient.
            let mint_recipient = read_u256_be(@message, MINT_RECIPIENT_OFFSET);
            let amount = read_u256_be(@message, AMOUNT_OFFSET);
            let recipient_felt: felt252 = mint_recipient.try_into().unwrap();
            let recipient: ContractAddress = recipient_felt.try_into().unwrap();
            IMockUsdcControlDispatcher { contract_address: self.usdc.read() }
                .mint(recipient, amount);
            self.receive_count.write(self.receive_count.read() + 1);
            true
        }
    }
}
