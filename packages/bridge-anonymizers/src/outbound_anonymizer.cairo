// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

//! Outbound anonymizer: the pool withdraws USDC to this contract, which burns it
//! through Circle CCTP toward a destination-chain recipient (the BUY leg). Only
//! the baked pool may drive it, and nothing is returned to the pool.

use starknet::ContractAddress;
use crate::types::{IERC20Dispatcher, IERC20DispatcherTrait, OpenNoteDeposit};

pub mod errors;

/// CCTP `TokenMessengerMinterV2` burn entrypoints. Signatures/param order mirror
/// circlefin/starknet-cctp:
/// https://github.com/circlefin/starknet-cctp/blob/master/packages/interfaces/src/token_messager_minter_v2.cairo
#[starknet::interface]
pub trait ITokenMessengerMinterV2<TContractState> {
    fn deposit_for_burn(
        ref self: TContractState,
        amount: u256,
        destination_domain: u32,
        mint_recipient: u256,
        burn_token: ContractAddress,
        destination_caller: u256,
        max_fee: u256,
        min_finality_threshold: u32,
    );
    fn deposit_for_burn_with_hook(
        ref self: TContractState,
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

/// CCTP burn args toward the destination recipient. The pool has already
/// withdrawn `amount` USDC to this contract before these are used.
#[derive(Serde, Drop)]
pub struct BuyParams {
    pub mint_recipient: u256,
    pub amount: u256,
    pub max_fee: u256,
    pub min_finality_threshold: u32,
    /// CCTP destination domain — the target chain (e.g. Ethereum=0, Base=6, Polygon=7).
    pub destination_domain: u32,
}

/// Outbound anonymizer entrypoint. Pool-driven; the `caller == pool` guard is
/// enforced inside.
#[starknet::interface]
pub trait IOutboundAnonymizer<TContractState> {
    fn privacy_invoke(ref self: TContractState, params: BuyParams) -> Span<OpenNoteDeposit>;
}

#[starknet::contract]
pub mod OutboundAnonymizer {
    use core::byte_array::ByteArrayTrait;
    use core::num::traits::Zero;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address};
    use super::{
        BuyParams, IERC20Dispatcher, IERC20DispatcherTrait, IOutboundAnonymizer,
        ITokenMessengerMinterV2Dispatcher, ITokenMessengerMinterV2DispatcherTrait, OpenNoteDeposit,
        errors,
    };

    /// `destination_caller = 0` leaves the destination-chain mint permissionless
    /// (anyone, including Circle's Forwarding Service, may submit it). A non-zero
    /// value would restrict the mint to a single caller address.
    const PERMISSIONLESS_CALLER: u256 = 0;

    /// The static CCTP Forwarding-Service hook: the 12 ASCII bytes of "cctp-forward"
    /// followed by 20 zero bytes (32 bytes total). Attaching it tells Circle's
    /// Forwarding Service to submit the destination mint and take its fee in USDC.
    /// `hook_data` is opaque (CCTP does not endianness-convert it) and must be
    /// non-empty.
    fn forwarding_hook_data() -> ByteArray {
        let mut hook: ByteArray = "cctp-forward";
        hook.append_word(0, 20);
        hook
    }

    #[storage]
    struct Storage {
        // Fixed params baked at construction.
        usdc: ContractAddress,
        token_messenger: ContractAddress,
        pool: ContractAddress,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        BurnInitiated: BurnInitiated,
    }

    #[derive(Drop, starknet::Event)]
    pub struct BurnInitiated {
        pub mint_recipient: u256,
        pub amount: u256,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        usdc: ContractAddress,
        token_messenger: ContractAddress,
        pool: ContractAddress,
    ) {
        self.usdc.write(usdc);
        self.token_messenger.write(token_messenger);
        self.pool.write(pool);
    }

    #[abi(embed_v0)]
    pub impl OutboundAnonymizerImpl of IOutboundAnonymizer<ContractState> {
        fn privacy_invoke(ref self: ContractState, params: BuyParams) -> Span<OpenNoteDeposit> {
            assert(get_caller_address() == self.pool.read(), errors::CALLER_NOT_POOL);
            self._do_burn(params)
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        /// Approve the messenger for `amount`, then `deposit_for_burn_with_hook`.
        /// Returns an empty span — nothing returns to the pool on the BUY leg.
        fn _do_burn(ref self: ContractState, params: BuyParams) -> Span<OpenNoteDeposit> {
            let BuyParams {
                mint_recipient, amount, max_fee, min_finality_threshold, destination_domain,
            } = params;

            // A zero-amount burn mints nothing; the amount must also clear the CCTP
            // fee, or the whole burn is consumed by `max_fee` and zero USDC mints.
            assert(amount.is_non_zero(), errors::ZERO_AMOUNT);
            assert(amount > max_fee, errors::AMOUNT_LE_MAX_FEE);

            let usdc = self.usdc.read();
            let token_messenger = self.token_messenger.read();

            IERC20Dispatcher { contract_address: usdc }
                .approve(spender: token_messenger, amount: amount);

            ITokenMessengerMinterV2Dispatcher { contract_address: token_messenger }
                .deposit_for_burn_with_hook(
                    amount: amount,
                    destination_domain: destination_domain,
                    mint_recipient: mint_recipient,
                    burn_token: usdc,
                    destination_caller: PERMISSIONLESS_CALLER,
                    max_fee: max_fee,
                    min_finality_threshold: min_finality_threshold,
                    hook_data: forwarding_hook_data(),
                );

            self.emit(Event::BurnInitiated(BurnInitiated { mint_recipient, amount }));

            array![].span()
        }
    }
}
