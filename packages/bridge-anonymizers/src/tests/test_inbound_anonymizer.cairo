// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

//! snforge suite for the inbound anonymizer (the CCTP → pool RETURN leg), fold
//! design: the CCTP mint is folded into the pool-only
//! `privacy_invoke_with_computation`, so the whole return is one proof-authorized
//! pool tx. CCTP MessageTransmitter + USDC are mocked; the contract under test is
//! real, and messages are built with the exact CCTP-v2 big-endian layout. Covers:
//!  - happy path: one call mints the real delta and returns it as an open note;
//!  - claim is pool-only (CALLER_NOT_POOL);
//!  - the mint binds to the proven commitment (COMMITMENT_MISMATCH) and to this
//!    contract as destinationCaller (DEST_CALLER_MISMATCH), both asserted pre-mint;
//!  - a direct receive_message from another caller hits the mock's destination_caller
//!    gate, so funds can only be minted through the fold;
//!  - wrong mint recipient mints nothing (NOTHING_MINTED);
//!  - replay reverts on the consumed nonce (NONCE_ALREADY_USED);
//!  - each mint's delta is isolated from stranded balance and other mints;
//!  - privacy_compute = poseidon([poseidon([identity_key, dapp_name, source_domain]), nonce])
//!    (cross-language vector).

use bridge_anonymizers::inbound_anonymizer::{
    IInboundAnonymizerDispatcher, IInboundAnonymizerDispatcherTrait,
    IInboundAnonymizerSafeDispatcher, IInboundAnonymizerSafeDispatcherTrait,
    IMessageTransmitterV2SafeDispatcher, IMessageTransmitterV2SafeDispatcherTrait, errors,
};
use bridge_anonymizers::test_mocks::{
    IMockUsdcControlDispatcher, IMockUsdcControlDispatcherTrait, IMockUsdcDispatcher,
    IMockUsdcDispatcherTrait,
};
use bridge_anonymizers::types::OpenNoteDeposit;
use core::byte_array::ByteArrayTrait;
use core::poseidon::poseidon_hash_span;
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_caller_address,
    stop_cheat_caller_address,
};
use starknet::ContractAddress;

fn pool_addr() -> ContractAddress {
    'POOL'.try_into().unwrap()
}
const DAPP: felt252 = 'pmp-return';
const SOURCE_DOMAIN: felt252 = 7; // CCTP source domain (Polygon)
const AMOUNT_A: u256 = 1000000; // 1 USDC
const AMOUNT_B: u256 = 2500000; // 2.5 USDC

#[derive(Copy, Drop)]
struct Deployed {
    inbound: ContractAddress,
    usdc: ContractAddress,
    transmitter: ContractAddress,
}

fn deploy() -> Deployed {
    let usdc_class = declare("MockUsdc").unwrap().contract_class();
    let (usdc, _) = usdc_class.deploy(@array![]).unwrap();

    let tx_class = declare("MockMessageTransmitter").unwrap().contract_class();
    let mut tx_cd = array![];
    usdc.serialize(ref tx_cd);
    let (transmitter, _) = tx_class.deploy(@tx_cd).unwrap();

    let inbound_class = declare("InboundAnonymizer").unwrap().contract_class();
    let mut cd = array![];
    usdc.serialize(ref cd);
    transmitter.serialize(ref cd);
    pool_addr().serialize(ref cd);
    let (inbound, _) = inbound_class.deploy(@cd).unwrap();

    Deployed { inbound, usdc, transmitter }
}

// --- CCTP-v2 message builder (exact big-endian offsets) ---------------------
fn append_u32_be(ref ba: ByteArray, value: u32) {
    ba.append_byte(((value / 0x1000000) & 0xFF).try_into().unwrap());
    ba.append_byte(((value / 0x10000) & 0xFF).try_into().unwrap());
    ba.append_byte(((value / 0x100) & 0xFF).try_into().unwrap());
    ba.append_byte((value & 0xFF).try_into().unwrap());
}

fn append_u256_be(ref ba: ByteArray, value: u256) {
    let mut i: usize = 0;
    while i != 32 {
        let shift_bytes: u32 = 31 - i;
        let mut divisor: u256 = 1;
        let mut k: u32 = 0;
        while k != shift_bytes {
            divisor = divisor * 256;
            k += 1;
        }
        let byte: u8 = ((value / divisor) % 256).try_into().unwrap();
        ba.append_byte(byte);
        i += 1;
    }
}

fn addr_u256(a: ContractAddress) -> u256 {
    let f: felt252 = a.into();
    f.into()
}

/// Build a CCTP-v2 message: outer MessageV2 header (148B) + BurnMessageV2 body.
/// Only the fields the mocks/contract read are meaningful; the rest are zero-
/// filled to keep every offset exact. hookData = the 32-byte commitment.
fn build_message(
    nonce: u256,
    mint_recipient: ContractAddress,
    amount: u256,
    destination_caller: ContractAddress,
    commitment: felt252,
) -> ByteArray {
    let mut m: ByteArray = Default::default();
    // MessageV2 header
    append_u32_be(ref m, 1); // version                       [0]
    append_u32_be(ref m, 0); // sourceDomain                  [4]
    append_u32_be(ref m, 25); // destinationDomain (Starknet) [8]
    append_u256_be(ref m, nonce); // nonce                    [12]
    append_u256_be(ref m, 0); // sender                       [44]
    append_u256_be(ref m, 0); // recipient (TokenMessenger)   [76]
    append_u256_be(ref m, addr_u256(destination_caller)); // [108]
    append_u32_be(ref m, 0); // minFinalityThreshold          [140]
    append_u32_be(ref m, 0); // finalityThresholdExecuted     [144]  -> 148
    // BurnMessageV2 body
    append_u32_be(ref m, 1); // body version                  [148]
    append_u256_be(ref m, 0); // burnToken                    [152]
    append_u256_be(ref m, addr_u256(mint_recipient)); //      [184]
    append_u256_be(ref m, amount); // amount                  [216]
    append_u256_be(ref m, 0); // messageSender                [248]
    append_u256_be(ref m, 0); // maxFee                       [280]
    append_u256_be(ref m, 0); // feeExecuted                  [312]
    append_u256_be(ref m, 0); // expirationBlock              [344]
    append_u256_be(ref m, commitment.into()); // hookData     [376] -> 408
    m
}

fn attn() -> ByteArray {
    "att" // mock ignores the attestation
}

/// Run the fold as the pool for a matching (commitment, message) pair.
fn fold(
    d: Deployed, commitment: felt252, note_id: felt252, message: ByteArray,
) -> Span<OpenNoteDeposit> {
    let inbound = IInboundAnonymizerDispatcher { contract_address: d.inbound };
    start_cheat_caller_address(d.inbound, pool_addr());
    let deposits = inbound.privacy_invoke_with_computation(commitment, note_id, message, attn());
    stop_cheat_caller_address(d.inbound);
    deposits
}

// --- 1 happy path: one call mints the real delta and returns it as a note ----
#[test]
fn fold_mints_delta_and_returns_open_note() {
    let d = deploy();
    let commitment: felt252 = 0x1234;
    let note_id: felt252 = 0x99;
    let msg = build_message(1, d.inbound, AMOUNT_A, d.inbound, commitment);

    let deposits = fold(d, commitment, note_id, msg);

    assert(deposits.len() == 1, 'BAD_LEN');
    let dep: OpenNoteDeposit = *deposits.at(0);
    assert(dep.note_id == note_id, 'BAD_NOTE');
    assert(dep.token == d.usdc, 'BAD_TOKEN');
    assert(dep.amount == AMOUNT_A.try_into().unwrap(), 'BAD_AMT');
    // USDC actually landed on inbound and the pool is approved for exactly it.
    let usdc = IMockUsdcDispatcher { contract_address: d.usdc };
    assert(usdc.balance_of(d.inbound) == AMOUNT_A, 'BAD_BALANCE');
    let ctrl = IMockUsdcControlDispatcher { contract_address: d.usdc };
    assert(ctrl.last_approve_spender() == pool_addr(), 'BAD_APPROVE_SPENDER');
    assert(ctrl.last_approve_amount() == AMOUNT_A, 'BAD_APPROVE_AMT');
}

// --- 2 claim is pool-only ----------------------------------------------------
#[test]
#[feature("safe_dispatcher")]
fn fold_non_pool_reverts() {
    let d = deploy();
    let safe = IInboundAnonymizerSafeDispatcher { contract_address: d.inbound };
    let commitment: felt252 = 0x66;
    let msg = build_message(60, d.inbound, AMOUNT_A, d.inbound, commitment);
    // Default caller (not the pool) → CALLER_NOT_POOL.
    match safe.privacy_invoke_with_computation(commitment, 0x1, msg, attn()) {
        Result::Ok(_) => panic!("non-pool fold should revert"),
        Result::Err(e) => assert(*e.at(0) == errors::CALLER_NOT_POOL, 'WRONG_ERR'),
    }
}

// --- 3 the mint binds to the proven commitment ------------------------------
#[test]
#[feature("safe_dispatcher")]
fn fold_reverts_on_commitment_mismatch() {
    let d = deploy();
    let safe = IInboundAnonymizerSafeDispatcher { contract_address: d.inbound };
    // Message carries 0xAAA in hookData; the pool proved a different commitment.
    let msg = build_message(70, d.inbound, AMOUNT_A, d.inbound, 0xAAA);
    start_cheat_caller_address(d.inbound, pool_addr());
    let r = safe.privacy_invoke_with_computation(0xBBB, 0x1, msg, attn());
    stop_cheat_caller_address(d.inbound);
    match r {
        Result::Ok(_) => panic!("commitment mismatch should revert"),
        Result::Err(e) => assert(*e.at(0) == errors::COMMITMENT_MISMATCH, 'WRONG_ERR'),
    }
}

// --- 4 the mint binds to this contract as destinationCaller (pre-mint) -------
#[test]
#[feature("safe_dispatcher")]
fn fold_reverts_on_destination_caller_mismatch() {
    let d = deploy();
    let safe = IInboundAnonymizerSafeDispatcher { contract_address: d.inbound };
    let commitment: felt252 = 0xC0FFEE;
    // destination_caller names some OTHER address → the contract's own check rejects
    // it before receive_message ever runs.
    let other: ContractAddress = 'OTHER'.try_into().unwrap();
    let msg = build_message(80, d.inbound, AMOUNT_A, other, commitment);
    start_cheat_caller_address(d.inbound, pool_addr());
    let r = safe.privacy_invoke_with_computation(commitment, 0x1, msg, attn());
    stop_cheat_caller_address(d.inbound);
    match r {
        Result::Ok(_) => panic!("dest-caller mismatch should revert"),
        Result::Err(e) => assert(*e.at(0) == errors::DESTINATION_CALLER_MISMATCH, 'WRONG_ERR'),
    }
}

// --- 4b no bypass: a direct receive_message from another caller reverts -------
#[test]
#[feature("safe_dispatcher")]
fn direct_receive_message_reverts_on_destination_caller_gate() {
    let d = deploy();
    // destination_caller is baked to the inbound contract, so only it may call.
    let msg = build_message(7, d.inbound, AMOUNT_A, d.inbound, 0xbeef);
    let tx = IMessageTransmitterV2SafeDispatcher { contract_address: d.transmitter };
    // Called directly from the test (caller != inbound) → the gate must reject it,
    // so funds can never be minted outside the fold.
    match tx.receive_message(msg, attn()) {
        Result::Ok(_) => panic!("direct receive_message should revert"),
        Result::Err(e) => assert(*e.at(0) == 'INVALID_DESTINATION_CALLER', 'WRONG_ERR'),
    }
}

// --- 5 wrong mint recipient mints nothing ------------------------------------
#[test]
#[feature("safe_dispatcher")]
fn fold_reverts_when_nothing_minted() {
    let d = deploy();
    let safe = IInboundAnonymizerSafeDispatcher { contract_address: d.inbound };
    let commitment: felt252 = 0xD00D;
    // destination_caller is this contract (passes the gate), but mint_recipient is
    // some OTHER address → inbound's balance delta is 0.
    let other: ContractAddress = 'OTHER'.try_into().unwrap();
    let msg = build_message(30, other, AMOUNT_A, d.inbound, commitment);
    start_cheat_caller_address(d.inbound, pool_addr());
    let r = safe.privacy_invoke_with_computation(commitment, 0x1, msg, attn());
    stop_cheat_caller_address(d.inbound);
    match r {
        Result::Ok(_) => panic!("should revert NOTHING_MINTED"),
        Result::Err(e) => assert(*e.at(0) == errors::NOTHING_MINTED, 'WRONG_ERR'),
    }
}

// --- 6 replay: a second fold with the same nonce reverts on the consumed nonce
#[test]
#[feature("safe_dispatcher")]
fn replay_same_nonce_reverts() {
    let d = deploy();
    let safe = IInboundAnonymizerSafeDispatcher { contract_address: d.inbound };
    let commitment: felt252 = 0xdd;
    fold(d, commitment, 0x1, build_message(40, d.inbound, AMOUNT_A, d.inbound, commitment));

    // Rebuild the identical message (ByteArray is consumed) and replay it.
    let msg2 = build_message(40, d.inbound, AMOUNT_A, d.inbound, commitment);
    start_cheat_caller_address(d.inbound, pool_addr());
    let r = safe.privacy_invoke_with_computation(commitment, 0x2, msg2, attn());
    stop_cheat_caller_address(d.inbound);
    match r {
        Result::Ok(_) => panic!("replay should revert"),
        Result::Err(e) => assert(*e.at(0) == 'NONCE_ALREADY_USED', 'WRONG_ERR'),
    }
}

// --- 7 each mint's delta is isolated from stranded balance and other mints ----
#[test]
fn each_mint_delta_isolated_from_stranded_and_others() {
    let d = deploy();
    // Pre-existing stranded balance (e.g. a stray transfer or prior residue).
    IMockUsdcControlDispatcher { contract_address: d.usdc }.set_balance(d.inbound, 500000);

    let c_a: felt252 = 0xaaa;
    let c_b: felt252 = 0xbbb;
    let dep_a = *fold(d, c_a, 0x1, build_message(10, d.inbound, AMOUNT_A, d.inbound, c_a)).at(0);
    let dep_b = *fold(d, c_b, 0x2, build_message(11, d.inbound, AMOUNT_B, d.inbound, c_b)).at(0);

    // Each fold returns exactly its own minted delta; the 0.5 stranded USDC and the
    // other mint never leak into either note.
    assert(dep_a.amount == AMOUNT_A.try_into().unwrap(), 'MIX_A');
    assert(dep_b.amount == AMOUNT_B.try_into().unwrap(), 'MIX_B');
}

// --- 8 privacy_compute parity (cross-language vector; TS mirrors this) --------
#[test]
fn privacy_compute_matches_poseidon() {
    let d = deploy();
    let inbound = IInboundAnonymizerDispatcher { contract_address: d.inbound };
    let identity_key: felt252 = 0x2a;
    let nonce: felt252 = 0x3;
    let got = inbound.privacy_compute(identity_key, DAPP, SOURCE_DOMAIN, nonce);
    let partial = poseidon_hash_span([identity_key, DAPP, SOURCE_DOMAIN].span());
    let expected = poseidon_hash_span([partial, nonce].span());
    assert(got == expected, 'COMPUTE_MISMATCH');
    // Distinct identity_key ⇒ distinct commitment (can't reach another's slot).
    let other = inbound.privacy_compute(identity_key + 1, DAPP, SOURCE_DOMAIN, nonce);
    assert(other != got, 'NOT_DISTINCT');
}

/// Cross-language vector for `privacy_compute = poseidon([poseidon([identity_key,
/// dapp_name, source_domain]), nonce])`. identity_key here = TS
/// `computeIdentityKey(0x123, 0x456, 0x789)`. bridge-core's `computeInboundCommitment`
/// must reproduce this value once it adopts the nested + source_domain form.
#[test]
fn privacy_compute_matches_frozen_ts_vector() {
    let d = deploy();
    let inbound = IInboundAnonymizerDispatcher { contract_address: d.inbound };
    let identity_key: felt252 =
        2963274373002919920585676405753763744919047250707156562953518365818429005436;
    let nonce: felt252 = 0x3;
    let commitment = inbound.privacy_compute(identity_key, DAPP, SOURCE_DOMAIN, nonce);
    assert(
        commitment == 3458963531638337582696264643503236639837327461545875365053976930150354299734,
        'FROZEN_VECTOR_MISMATCH',
    );
}
