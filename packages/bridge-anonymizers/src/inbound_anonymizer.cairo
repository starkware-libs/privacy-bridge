// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

//! Inbound anonymizer: CCTP → pool RETURN leg via the pool's privacy-compute
//! feature (`ComputeAndInvoke`).
//!
//! Single-transaction flow:
//!   - the pool derives the commitment from the authenticated signer via
//!     `privacy_compute`, then calls `privacy_invoke_with_computation` (pool-only),
//!     which atomically verifies the attested message binds to that commitment, mints
//!     the CCTP return via `MessageTransmitterV2.receive_message`, and hands the
//!     minted USDC to the pool as a fresh open note.
//!
//! There is no decoupled "bind now, claim later" state: mint and claim are atomic. A
//! return whose tx reverts strands nothing — the Circle-attested message stays
//! replayable, so the client retries from the persisted burn.
//!
//! Invariants: the only function that calls `receive_message` is the pool-only
//! `privacy_invoke_with_computation`; the burn sets `destination_caller = this
//! contract`, re-asserted on-chain; the minted funds bind to the commitment the pool
//! proved for the signer, and that commitment rides in the attested message's
//! hookData (not a caller arg), so it cannot be forged.

pub mod errors;
pub mod internal_errors;

/// Compute-result / commitment type (the poseidon commitment).
pub type Commitment = felt252;

/// Minimal `MessageTransmitterV2` surface. Signature mirrors circlefin/starknet-cctp:
/// https://github.com/circlefin/starknet-cctp/blob/master/packages/interfaces/src/message_transmitter_v2.cairo
#[starknet::interface]
pub trait IMessageTransmitterV2<TContractState> {
    fn receive_message(
        ref self: TContractState, message: ByteArray, attestation: ByteArray,
    ) -> bool;
}

/// Inbound anonymizer entrypoints — the pool's `ComputeAndInvoke` hooks. The CCTP
/// receive+mint is folded into `privacy_invoke_with_computation`.
#[starknet::interface]
pub trait IInboundAnonymizer<TContractState> {
    /// Pool compute hook:
    /// `commitment = poseidon([poseidon([identity_key, dapp_name, source_domain]), nonce])`.
    /// `identity_key` is supplied by the pool from the authenticated signer; `source_domain`
    /// is the CCTP source-chain domain (e.g. Ethereum=0, Polygon=7).
    fn privacy_compute(
        self: @TContractState,
        identity_key: felt252,
        dapp_name: felt252,
        source_domain: felt252,
        nonce: felt252,
    ) -> Commitment;

    /// Pool invoke hook (pool-only): atomically mint the CCTP return (verifying the
    /// attested message binds to `commitment`) and hand the minted USDC to the pool as
    /// a fresh open note. `commitment` is the raw return of `privacy_compute`;
    /// `note_id`, `message`, `attestation` are the invoke_additional_data (the latter
    /// two are the CCTP receive inputs).
    fn privacy_invoke_with_computation(
        ref self: TContractState,
        commitment: Commitment,
        note_id: felt252,
        message: ByteArray,
        attestation: ByteArray,
    ) -> Span<crate::types::OpenNoteDeposit>;
}

#[starknet::contract]
pub mod InboundAnonymizer {
    use core::byte_array::ByteArrayTrait;
    use core::num::traits::Zero;
    use core::poseidon::poseidon_hash_span;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use crate::types::{IERC20Dispatcher, IERC20DispatcherTrait, OpenNoteDeposit};
    use super::{
        Commitment, IInboundAnonymizer, IMessageTransmitterV2Dispatcher,
        IMessageTransmitterV2DispatcherTrait, errors, internal_errors,
    };

    /// Byte offset of hookData in a CCTP-v2 message = MessageV2 header (148) +
    /// BurnMessageV2 hookData index (228). The commitment is the 32-byte big-endian
    /// hookData. Mirrors circlefin/starknet-cctp's message layout.
    const HOOK_DATA_OFFSET: usize = 376;

    /// Byte offset of destinationCaller in the CCTP-v2 MessageV2 header:
    /// version(4) + sourceDomain(4) + destinationDomain(4) + nonce(32) + sender(32)
    /// + recipient(32) = 108.
    const DESTINATION_CALLER_OFFSET: usize = 108;

    #[storage]
    struct Storage {
        // Baked at construction.
        usdc: ContractAddress,
        message_transmitter: ContractAddress,
        pool: ContractAddress,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        ReturnBound: ReturnBound,
        Claimed: Claimed,
    }

    /// Emitted for the mint leg of the atomic return; `minted` is the real balance delta.
    #[derive(Drop, starknet::Event)]
    pub struct ReturnBound {
        #[key]
        pub commitment: Commitment,
        pub minted: u128,
    }

    /// Emitted for the claim leg: the minted funds handed to the pool.
    #[derive(Drop, starknet::Event)]
    pub struct Claimed {
        #[key]
        pub commitment: Commitment,
        pub amount: u128,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        usdc: ContractAddress,
        message_transmitter: ContractAddress,
        pool: ContractAddress,
    ) {
        self.usdc.write(usdc);
        self.message_transmitter.write(message_transmitter);
        self.pool.write(pool);
    }

    #[abi(embed_v0)]
    pub impl InboundAnonymizerImpl of IInboundAnonymizer<ContractState> {
        fn privacy_compute(
            self: @ContractState,
            identity_key: felt252,
            dapp_name: felt252,
            source_domain: felt252,
            nonce: felt252,
        ) -> Commitment {
            // Two-stage: the nonce-independent partial commitment
            // poseidon([identity_key, dapp_name, source_domain]) then folded with nonce.
            let partial = poseidon_hash_span([identity_key, dapp_name, source_domain].span());
            poseidon_hash_span([partial, nonce].span())
        }

        fn privacy_invoke_with_computation(
            ref self: ContractState,
            commitment: Commitment,
            note_id: felt252,
            message: ByteArray,
            attestation: ByteArray,
        ) -> Span<OpenNoteDeposit> {
            // Pool-only: the pool feeds the commitment straight from privacy_compute
            // over the authenticated signer, so a caller can only reach a commitment
            // they own.
            let pool = self.pool.read();
            assert(get_caller_address() == pool, errors::CALLER_NOT_POOL);

            // Bind the mint to the signer: the attested message's hookData commitment
            // must equal the proven commitment. This runs before the mint, so a
            // mismatch reverts without consuming the CCTP nonce (the message stays
            // replayable). The commitment rides in the attested message, not a caller arg.
            assert(
                read_word(@message, HOOK_DATA_OFFSET) == commitment, errors::COMMITMENT_MISMATCH,
            );

            // Defense-in-depth atop receive_message's own gate: the message must name
            // this contract as its destinationCaller, so only this path can drive the
            // mint. Pre-mint, so a mis-addressed message fails closed without burning
            // the nonce.
            let self_felt: felt252 = get_contract_address().into();
            assert(
                read_word(@message, DESTINATION_CALLER_OFFSET) == self_felt,
                errors::DESTINATION_CALLER_MISMATCH,
            );

            let usdc = self.usdc.read();
            let usdc_disp = IERC20Dispatcher { contract_address: usdc };
            let before: u256 = usdc_disp.balance_of(get_contract_address());

            // receive_message verifies the attestation, enforces destination_caller
            // (== this contract), mints to this contract, and consumes the nonce.
            IMessageTransmitterV2Dispatcher { contract_address: self.message_transmitter.read() }
                .receive_message(message, attestation);

            let after: u256 = usdc_disp.balance_of(get_contract_address());
            // Real delta of this mint, isolating it from any pre-existing balance.
            let minted: u128 = (after - before).try_into().expect(internal_errors::AMOUNT_OVERFLOW);
            assert(minted.is_non_zero(), errors::NOTHING_MINTED);
            self.emit(Event::ReturnBound(ReturnBound { commitment, minted }));

            // Hand the minted USDC to the pool as a fresh open note (atomic claim).
            usdc_disp.approve(spender: pool, amount: minted.into());
            self.emit(Event::Claimed(Claimed { commitment, amount: minted }));
            array![OpenNoteDeposit { note_id, token: usdc, amount: minted }].span()
        }
    }

    /// Read the 32-byte big-endian word at `offset` as a felt (the commitment / a
    /// header address). hookData is opaque (CCTP does not endianness-convert it), so
    /// both sides must agree on byte order.
    fn read_word(message: @ByteArray, offset: usize) -> Commitment {
        assert(message.len() >= offset + 32, errors::MESSAGE_TOO_SHORT);
        let mut result: u256 = 0;
        let mut i: usize = 0;
        while i != 32 {
            let byte_val: u256 = message.at(offset + i).unwrap().into();
            result = result * 256 + byte_val;
            i += 1;
        }
        result.try_into().expect(internal_errors::WORD_OVERFLOW)
    }
}
