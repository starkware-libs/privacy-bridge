//! Test-only mocks for the Anonymizer snforge suite.
//!
//! - `MockTokenMessengerMinter` implements the CCTP `deposit_for_burn`
//!   surface (`ITokenMessengerMinterV2`) and records the exact args of the last
//!   call so tests can assert the (amount, dest_domain, mint_recipient,
//!   burn_token, destination_caller, max_fee, finality) tuple.
//! - `MockUsdc` is a minimal ERC20 exposing `approve` + `balance_of` (the only
//!   surface the Anonymizer uses) plus test-control hooks to seed balances and
//!   to read back the last `approve(spender, amount)` (so we can verify the
//!   approve-then-burn / approve-the-pool behavior).
//!
//! These are mocks of the *external* contracts the anonymizer talks to — the
//! contract under test is the real `bridge_anonymizers::outbound_anonymizer`.

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
                .last
                .write(
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
            self.burn_count.write(self.burn_count.read() + 1);
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
                .last
                .write(
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
            self.burn_count.write(self.burn_count.read() + 1);
        }
    }
}

#[starknet::interface]
pub trait IMockUsdcControl<T> {
    /// Set the recorded balance for `account` (seeds `balance_of`).
    fn set_balance(ref self: T, account: ContractAddress, amount: u256);
    /// Add `amount` to `account`'s balance (models a CCTP mint; used by the
    /// MockMessageTransmitter).
    fn mint(ref self: T, account: ContractAddress, amount: u256);
    /// Spender of the most recent `approve`.
    fn last_approve_spender(self: @T) -> ContractAddress;
    /// Amount of the most recent `approve`.
    fn last_approve_amount(self: @T) -> u256;
    /// Number of `approve` calls received.
    fn approve_count(self: @T) -> u32;
}

/// Minimal ERC20 mock: only `approve` + `balance_of` (the surface the anonymizers'
/// `IERC20` dispatcher calls).
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
