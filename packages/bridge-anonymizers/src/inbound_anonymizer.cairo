//! Inbound anonymizer: CCTP → pool RETURN leg via the pool's privacy-compute
//! feature (`ComputeAndInvoke`), keying escrowed mints by commitment in a ledger.
//!
//! Flow:
//!   - `receive_and_bind(message, attestation)` (permissionless): calls
//!     `MessageTransmitterV2.receive_message` (verifies the attestation and mints
//!     USDC to this contract), then credits `ledger[commitment]` by the real minted
//!     delta, where `commitment` is the attested message's hookData.
//!   - the pool's ComputeAndInvoke: `privacy_compute` derives the commitment from
//!     the authenticated signer; `privacy_invoke_with_computation` (pool-only)
//!     drains `ledger[commitment]` into an open note and approves the pool.
//!
//! Invariants: the burn sets `destination_caller = this contract`, so the mint can
//! arrive only via `receive_and_bind`; the commitment comes from the attested
//! message, not caller args; `sum(ledger) <= balance_of(self)` always.

pub mod errors;
pub mod internal_errors;

/// Ledger key / compute-result type (the poseidon commitment).
pub type Commitment = felt252;

/// Minimal `MessageTransmitterV2` surface. Signature mirrors circlefin/starknet-cctp:
/// https://github.com/circlefin/starknet-cctp/blob/master/packages/interfaces/src/message_transmitter_v2.cairo
#[starknet::interface]
pub trait IMessageTransmitterV2<TContractState> {
    fn receive_message(
        ref self: TContractState, message: ByteArray, attestation: ByteArray,
    ) -> bool;
}

/// Inbound anonymizer entrypoints. `privacy_compute` / `privacy_invoke_with_computation`
/// are the pool's `ComputeAndInvoke` hooks; `receive_and_bind` is the atomic CCTP
/// receive + bind.
#[starknet::interface]
pub trait IInboundAnonymizer<TContractState> {
    /// Atomic receive + bind. Permissionless: the commitment is sourced from the
    /// attested message, not the caller.
    fn receive_and_bind(ref self: TContractState, message: ByteArray, attestation: ByteArray);

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

    /// Pool invoke hook (pool-only): drain `ledger[commitment]` into a fresh open
    /// note. `commitment` is the raw return of `privacy_compute`; `note_id` is the
    /// invoke_additional_data.
    fn privacy_invoke_with_computation(
        ref self: TContractState, commitment: Commitment, note_id: felt252,
    ) -> Span<crate::types::OpenNoteDeposit>;

    /// Read the bound-but-unclaimed balance for a commitment (used by recovery).
    fn claimable_of(self: @TContractState, commitment: Commitment) -> u128;
}

#[starknet::contract]
pub mod InboundAnonymizer {
    use core::byte_array::ByteArrayTrait;
    use core::num::traits::Zero;
    use core::poseidon::poseidon_hash_span;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
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

    #[storage]
    struct Storage {
        // Baked at construction.
        usdc: ContractAddress,
        message_transmitter: ContractAddress,
        pool: ContractAddress,
        // Bound-but-unclaimed USDC per commitment.
        ledger: Map<Commitment, u128>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        ReturnBound: ReturnBound,
        Claimed: Claimed,
    }

    /// Emitted when a CCTP mint is bound to its commitment.
    #[derive(Drop, starknet::Event)]
    pub struct ReturnBound {
        #[key]
        pub commitment: Commitment,
        pub minted: u128,
    }

    /// Emitted when a commitment is claimed into the pool.
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
        fn receive_and_bind(ref self: ContractState, message: ByteArray, attestation: ByteArray) {
            // Parse the commitment from the message's hookData. A bad/replayed
            // attestation reverts the whole tx in receive_message below, discarding
            // this parse, so parsing pre-verification is safe.
            let commitment = parse_hook_commitment(@message);

            let usdc = self.usdc.read();
            let usdc_disp = IERC20Dispatcher { contract_address: usdc };
            let before: u256 = usdc_disp.balance_of(get_contract_address());

            // receive_message verifies the attestation, enforces the message's
            // destination_caller (== this contract, so only this path can mint these
            // funds), mints to the recipient (this contract), and consumes the nonce.
            IMessageTransmitterV2Dispatcher { contract_address: self.message_transmitter.read() }
                .receive_message(message, attestation);

            let after: u256 = usdc_disp.balance_of(get_contract_address());
            // Real delta of this mint, isolating it from any pre-existing balance.
            let minted: u128 = (after - before).try_into().expect(internal_errors::AMOUNT_OVERFLOW);
            assert(minted.is_non_zero(), errors::NOTHING_MINTED);

            self.ledger.write(commitment, self.ledger.read(commitment) + minted);
            self.emit(Event::ReturnBound(ReturnBound { commitment, minted }));
        }

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
            ref self: ContractState, commitment: Commitment, note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            // Pool-only: the pool feeds the commitment straight from privacy_compute
            // over the authenticated signer, so a caller can only reach a commitment
            // they own.
            assert(get_caller_address() == self.pool.read(), errors::CALLER_NOT_POOL);

            let amount = self.ledger.read(commitment);
            assert(amount.is_non_zero(), errors::NOTHING_TO_CLAIM);

            self.ledger.write(commitment, 0);

            let usdc = self.usdc.read();
            IERC20Dispatcher { contract_address: usdc }
                .approve(spender: self.pool.read(), amount: amount.into());

            self.emit(Event::Claimed(Claimed { commitment, amount }));
            array![OpenNoteDeposit { note_id, token: usdc, amount }].span()
        }

        fn claimable_of(self: @ContractState, commitment: Commitment) -> u128 {
            self.ledger.read(commitment)
        }
    }

    /// Read the 32-byte big-endian hookData word at the fixed CCTP-v2 offset as the
    /// commitment. hookData is opaque (CCTP does not endianness-convert it), so both
    /// sides must agree on byte order.
    fn parse_hook_commitment(message: @ByteArray) -> Commitment {
        assert(message.len() >= HOOK_DATA_OFFSET + 32, errors::MESSAGE_TOO_SHORT);
        let mut result: u256 = 0;
        let mut i: usize = 0;
        while i != 32 {
            let byte_val: u256 = message.at(HOOK_DATA_OFFSET + i).unwrap().into();
            result = result * 256 + byte_val;
            i += 1;
        }
        result.try_into().expect(internal_errors::COMMITMENT_OVERFLOW)
    }
}
