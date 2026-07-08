//! Test-only mocks of the external contracts the outbound anonymizer talks to
//! (the contract under test is real):
//! - `MockTokenMessengerMinter` records the args + hook of the last CCTP burn.
//! - `MockUsdc` records the last `approve` (the only ERC20 call the burn makes).

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
    /// Spender of the most recent `approve`.
    fn last_approve_spender(self: @T) -> ContractAddress;
    /// Amount of the most recent `approve`.
    fn last_approve_amount(self: @T) -> u256;
    /// Number of `approve` calls received.
    fn approve_count(self: @T) -> u32;
}

/// Minimal ERC20 mock exposing only `approve` (the surface the burn calls).
#[starknet::interface]
pub trait IMockUsdc<T> {
    fn approve(ref self: T, spender: ContractAddress, amount: u256) -> bool;
}

#[starknet::contract]
pub mod MockUsdc {
    use starknet::ContractAddress;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use super::{IMockUsdc, IMockUsdcControl};

    #[storage]
    struct Storage {
        last_approve_spender: ContractAddress,
        last_approve_amount: u256,
        approve_count: u32,
    }

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    impl ControlImpl of IMockUsdcControl<ContractState> {
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
    }
}
