//! snforge suite for the inbound anonymizer (the CCTP → pool RETURN leg). CCTP
//! MessageTransmitter + USDC are mocked; the contract under test is real, and
//! messages are built with the exact CCTP-v2 big-endian layout. Covers:
//!  - bind credits ledger[commitment] by the real minted delta (happy path);
//!  - no bypass: a direct receive_message from another caller hits the
//!    destination_caller gate, so funds arrive only via receive_and_bind;
//!  - no mixing across commitments or with stranded balance;
//!  - a front-running submitter binds to the message's commitment, not their own;
//!  - wrong mint recipient credits nothing (NOTHING_MINTED);
//!  - claim is pool-only (CALLER_NOT_POOL) and single-use (double-claim reverts);
//!  - replay/double-bind reverts (NONCE_ALREADY_USED);
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
fn attacker_addr() -> ContractAddress {
    'ATTACKER'.try_into().unwrap()
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

// --- 1 + happy path ---------------------------------------------------------
#[test]
fn bind_credits_minted_delta_to_message_commitment() {
    let d = deploy();
    let inbound = IInboundAnonymizerDispatcher { contract_address: d.inbound };
    let commitment: felt252 = 0x1234;
    let msg = build_message(1, d.inbound, AMOUNT_A, d.inbound, commitment);

    inbound.receive_and_bind(msg, attn());

    // Ledger credited by the real minted delta; USDC actually landed on inbound.
    assert(inbound.claimable_of(commitment) == AMOUNT_A.try_into().unwrap(), 'BAD_LEDGER');
    let usdc = IMockUsdcDispatcher { contract_address: d.usdc };
    assert(usdc.balance_of(d.inbound) == AMOUNT_A, 'BAD_BALANCE');
}

// --- 1b no bypass: direct receive_message from a non-inbound caller reverts --
#[test]
#[feature("safe_dispatcher")]
fn direct_receive_message_reverts_on_destination_caller_gate() {
    let d = deploy();
    // destination_caller is baked to the inbound contract, so only it may call.
    let msg = build_message(7, d.inbound, AMOUNT_A, d.inbound, 0xbeef);
    let tx = IMessageTransmitterV2SafeDispatcher { contract_address: d.transmitter };
    // Called directly from the test (caller != inbound) → the gate must reject it,
    // so funds can never be minted outside receive_and_bind.
    match tx.receive_message(msg, attn()) {
        Result::Ok(_) => panic!("direct receive_message should revert"),
        Result::Err(e) => assert(*e.at(0) == 'INVALID_DESTINATION_CALLER', 'WRONG_ERR'),
    }
}

// --- 2 no mixing: stranded balance + second bind don't cross-credit ----------
#[test]
fn no_mixing_across_commitments_or_stranded_balance() {
    let d = deploy();
    let inbound = IInboundAnonymizerDispatcher { contract_address: d.inbound };
    // Pre-existing stranded balance (e.g. a stray transfer or prior residue).
    IMockUsdcControlDispatcher { contract_address: d.usdc }.set_balance(d.inbound, 500000);

    let c_a: felt252 = 0xaaa;
    let c_b: felt252 = 0xbbb;
    inbound.receive_and_bind(build_message(10, d.inbound, AMOUNT_A, d.inbound, c_a), attn());
    inbound.receive_and_bind(build_message(11, d.inbound, AMOUNT_B, d.inbound, c_b), attn());

    // Each commitment credited exactly its own minted delta; the 0.5 stranded USDC
    // is bound to NEITHER commitment.
    assert(inbound.claimable_of(c_a) == AMOUNT_A.try_into().unwrap(), 'MIX_A');
    assert(inbound.claimable_of(c_b) == AMOUNT_B.try_into().unwrap(), 'MIX_B');
}

// --- 3 no theft via front-run: submitter binds to the MESSAGE's commitment ---
#[test]
fn arbitrary_submitter_binds_to_message_commitment_not_theirs() {
    let d = deploy();
    let inbound = IInboundAnonymizerDispatcher { contract_address: d.inbound };
    let victim_commitment: felt252 = 0xdead;
    let msg = build_message(20, d.inbound, AMOUNT_A, d.inbound, victim_commitment);

    // An attacker submits the victim's (attested) message.
    start_cheat_caller_address(d.inbound, attacker_addr());
    inbound.receive_and_bind(msg, attn());
    stop_cheat_caller_address(d.inbound);

    // Funds are bound to the victim's commitment (from the message), gaining the
    // attacker nothing.
    assert(inbound.claimable_of(victim_commitment) == AMOUNT_A.try_into().unwrap(), 'THEFT');
}

// --- 4 wrong mint recipient credits nothing ---------------------------------
#[test]
#[feature("safe_dispatcher")]
fn bind_reverts_when_nothing_minted_to_inbound() {
    let d = deploy();
    let inbound = IInboundAnonymizerSafeDispatcher { contract_address: d.inbound };
    // mint_recipient is some OTHER address → inbound's balance delta is 0.
    let other: ContractAddress = 'OTHER'.try_into().unwrap();
    let msg = build_message(30, other, AMOUNT_A, d.inbound, 0xc0ffee);
    match inbound.receive_and_bind(msg, attn()) {
        Result::Ok(_) => panic!("should revert NOTHING_MINTED"),
        Result::Err(e) => assert(*e.at(0) == errors::NOTHING_MINTED, 'WRONG_ERR'),
    }
}

// --- 6 replay / double-bind reverts -----------------------------------------
#[test]
#[feature("safe_dispatcher")]
fn double_bind_same_message_reverts_on_nonce() {
    let d = deploy();
    let ok = IInboundAnonymizerDispatcher { contract_address: d.inbound };
    let safe = IInboundAnonymizerSafeDispatcher { contract_address: d.inbound };
    let msg1 = build_message(40, d.inbound, AMOUNT_A, d.inbound, 0xdd);
    ok.receive_and_bind(msg1, attn());
    // Rebuild the identical message (ByteArray is consumed) and replay it.
    let msg2 = build_message(40, d.inbound, AMOUNT_A, d.inbound, 0xdd);
    match safe.receive_and_bind(msg2, attn()) {
        Result::Ok(_) => panic!("replay should revert"),
        Result::Err(e) => assert(*e.at(0) == 'NONCE_ALREADY_USED', 'WRONG_ERR'),
    }
}

// --- 5 claim: pool-only, happy, and idempotent ------------------------------
#[test]
fn claim_as_pool_returns_open_note_and_zeroes_ledger() {
    let d = deploy();
    let inbound = IInboundAnonymizerDispatcher { contract_address: d.inbound };
    let commitment: felt252 = 0x55;
    let note_id: felt252 = 0x99;
    inbound.receive_and_bind(build_message(50, d.inbound, AMOUNT_A, d.inbound, commitment), attn());

    start_cheat_caller_address(d.inbound, pool_addr());
    let deposits = inbound.privacy_invoke_with_computation(commitment, note_id);
    stop_cheat_caller_address(d.inbound);

    assert(deposits.len() == 1, 'BAD_LEN');
    let dep: OpenNoteDeposit = *deposits.at(0);
    assert(dep.note_id == note_id, 'BAD_NOTE');
    assert(dep.token == d.usdc, 'BAD_TOKEN');
    assert(dep.amount == AMOUNT_A.try_into().unwrap(), 'BAD_AMT');
    // Pool approved for exactly the claimed amount; ledger drained.
    let usdc = IMockUsdcControlDispatcher { contract_address: d.usdc };
    assert(usdc.last_approve_spender() == pool_addr(), 'BAD_APPROVE_SPENDER');
    assert(usdc.last_approve_amount() == AMOUNT_A, 'BAD_APPROVE_AMT');
    assert(inbound.claimable_of(commitment) == 0, 'NOT_DRAINED');
}

#[test]
#[feature("safe_dispatcher")]
fn claim_non_pool_reverts() {
    let d = deploy();
    let inbound = IInboundAnonymizerDispatcher { contract_address: d.inbound };
    let safe = IInboundAnonymizerSafeDispatcher { contract_address: d.inbound };
    let commitment: felt252 = 0x66;
    inbound.receive_and_bind(build_message(60, d.inbound, AMOUNT_A, d.inbound, commitment), attn());

    // Default caller (not the pool) → CALLER_NOT_POOL.
    match safe.privacy_invoke_with_computation(commitment, 0x1) {
        Result::Ok(_) => panic!("non-pool claim should revert"),
        Result::Err(e) => assert(*e.at(0) == errors::CALLER_NOT_POOL, 'WRONG_ERR'),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn double_claim_reverts_nothing_to_claim() {
    let d = deploy();
    let inbound = IInboundAnonymizerDispatcher { contract_address: d.inbound };
    let safe = IInboundAnonymizerSafeDispatcher { contract_address: d.inbound };
    let commitment: felt252 = 0x77;
    inbound.receive_and_bind(build_message(70, d.inbound, AMOUNT_A, d.inbound, commitment), attn());

    start_cheat_caller_address(d.inbound, pool_addr());
    inbound.privacy_invoke_with_computation(commitment, 0x1);
    stop_cheat_caller_address(d.inbound);

    start_cheat_caller_address(d.inbound, pool_addr());
    let r = safe.privacy_invoke_with_computation(commitment, 0x2);
    stop_cheat_caller_address(d.inbound);
    match r {
        Result::Ok(_) => panic!("double claim should revert"),
        Result::Err(e) => assert(*e.at(0) == errors::NOTHING_TO_CLAIM, 'WRONG_ERR'),
    }
}

// --- 7 privacy_compute parity (cross-language vector; TS mirrors this) -------
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
