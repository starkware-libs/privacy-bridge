// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

//! snforge suite for the outbound anonymizer (the BUY leg). CCTP messenger + USDC
//! are mocked; the contract under test is real. Covers: `privacy_invoke` rejects a
//! non-pool caller and the zero-amount / amount<=max_fee guards; as the pool it
//! approves the messenger and burns with the right args + forwarding hook,
//! returning an empty span; `destination_domain` is per-tx; and `BurnInitiated`
//! publicly emits `mint_recipient` + amount.

use bridge_anonymizers::outbound_anonymizer::{
    BuyParams, IOutboundAnonymizerDispatcher, IOutboundAnonymizerDispatcherTrait,
    IOutboundAnonymizerSafeDispatcher, IOutboundAnonymizerSafeDispatcherTrait, errors,
};
use bridge_anonymizers::test_mocks::{
    IMockMessengerControlDispatcher, IMockMessengerControlDispatcherTrait,
    IMockUsdcControlDispatcher, IMockUsdcControlDispatcherTrait,
};
use core::byte_array::ByteArrayTrait;
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, EventSpyAssertionsTrait, declare, spy_events,
    start_cheat_caller_address, stop_cheat_caller_address,
};
use starknet::ContractAddress;

fn pool_addr() -> ContractAddress {
    'POOL'.try_into().unwrap()
}
fn not_pool_addr() -> ContractAddress {
    'NOT_POOL'.try_into().unwrap()
}
const DEST_DOMAIN: u32 = 7; // Polygon
const BASE_DOMAIN: u32 = 6; // Base
const D: u256 = 1000000; // fixed 1-USDC denomination
const STANDARD_FINALITY: u32 = 2000;

#[derive(Copy, Drop)]
struct Deployed {
    anonymizer: ContractAddress,
    usdc: ContractAddress,
    messenger: ContractAddress,
}

fn deploy_mock(name: ByteArray) -> ContractAddress {
    let contract = declare(name).unwrap().contract_class();
    let (addr, _) = contract.deploy(@array![]).unwrap();
    addr
}

fn deploy_with_pool(pool: ContractAddress) -> Deployed {
    let usdc = deploy_mock("MockUsdc");
    let messenger = deploy_mock("MockTokenMessengerMinter");

    let anonymizer_class = declare("OutboundAnonymizer").unwrap().contract_class();
    // Constructor: usdc, token_messenger, pool — 3 felts.
    let mut calldata = array![];
    usdc.serialize(ref calldata);
    messenger.serialize(ref calldata);
    pool.serialize(ref calldata);
    let (anonymizer, _) = anonymizer_class.deploy(@calldata).unwrap();

    Deployed { anonymizer, usdc, messenger }
}

fn deploy_all() -> Deployed {
    deploy_with_pool(pool_addr())
}

fn buy(
    mint_recipient: u256, amount: u256, max_fee: u256, finality: u32, destination_domain: u32,
) -> BuyParams {
    BuyParams {
        mint_recipient, amount, max_fee, min_finality_threshold: finality, destination_domain,
    }
}

/// Assert a safe-dispatcher call reverted with `expected` as its first panic felt.
fn assert_reverts_with<T, +Drop<T>>(result: Result<T, Array<felt252>>, expected: felt252) {
    match result {
        Result::Ok(_) => panic!("expected revert"),
        Result::Err(panic_data) => assert!(*panic_data.at(0) == expected, "wrong revert reason"),
    }
}

fn invoke_as_pool_safe(
    d: Deployed, params: BuyParams,
) -> Result<Span<bridge_anonymizers::types::OpenNoteDeposit>, Array<felt252>> {
    let safe = IOutboundAnonymizerSafeDispatcher { contract_address: d.anonymizer };
    start_cheat_caller_address(d.anonymizer, pool_addr());
    let result = safe.privacy_invoke(params);
    stop_cheat_caller_address(d.anonymizer);
    result
}

// privacy_invoke — caller guard

#[test]
#[feature("safe_dispatcher")]
fn test_privacy_invoke_reverts_if_caller_not_pool() {
    let d = deploy_all();
    let safe = IOutboundAnonymizerSafeDispatcher { contract_address: d.anonymizer };

    start_cheat_caller_address(d.anonymizer, not_pool_addr());
    let result = safe.privacy_invoke(buy(0xABCD, D, 0, STANDARD_FINALITY, DEST_DOMAIN));
    stop_cheat_caller_address(d.anonymizer);

    assert_reverts_with(result, errors::CALLER_NOT_POOL);
}

// privacy_invoke — amount guards (pool caller)

#[test]
#[feature("safe_dispatcher")]
fn test_privacy_invoke_reverts_on_zero_amount() {
    let d = deploy_all();
    let result = invoke_as_pool_safe(d, buy(0xABCD, 0, 0, STANDARD_FINALITY, DEST_DOMAIN));
    assert_reverts_with(result, errors::ZERO_AMOUNT);
}

#[test]
#[feature("safe_dispatcher")]
fn test_privacy_invoke_reverts_when_amount_le_max_fee() {
    let d = deploy_all();
    // Boundary: amount == max_fee.
    assert_reverts_with(
        invoke_as_pool_safe(d, buy(0xABCD, D, D, STANDARD_FINALITY, DEST_DOMAIN)),
        errors::AMOUNT_LE_MAX_FEE,
    );
    // Below: amount < max_fee.
    assert_reverts_with(
        invoke_as_pool_safe(d, buy(0xABCD, D, D + 1, STANDARD_FINALITY, DEST_DOMAIN)),
        errors::AMOUNT_LE_MAX_FEE,
    );
}

// privacy_invoke — happy path: approve + deposit_for_burn args + empty span

#[test]
fn test_privacy_invoke_burns_with_correct_args() {
    let d = deploy_all();
    let dispatcher = IOutboundAnonymizerDispatcher { contract_address: d.anonymizer };
    let mint_recipient: u256 =
        0x00000000000000000000000011112222333344445555666677778888; // padded EVM addr
    let max_fee: u256 = D / 2; // nonzero fee (< amount) — must be forwarded unchanged

    start_cheat_caller_address(d.anonymizer, pool_addr());
    let span = dispatcher
        .privacy_invoke(buy(mint_recipient, D, max_fee, STANDARD_FINALITY, DEST_DOMAIN));
    stop_cheat_caller_address(d.anonymizer);

    // BUY leg returns nothing to the pool.
    assert!(span.len() == 0, "privacy_invoke must return an empty span");

    // deposit_for_burn called exactly once with the expected tuple.
    let messenger = IMockMessengerControlDispatcher { contract_address: d.messenger };
    assert!(messenger.burn_count() == 1, "deposit_for_burn not called exactly once");
    let burn = messenger.last_burn();
    assert!(burn.amount == D, "burn amount != denomination");
    assert!(
        burn.destination_domain == DEST_DOMAIN, "burn dest_domain != BuyParams.destination_domain",
    );
    assert!(burn.mint_recipient == mint_recipient, "mint_recipient mismatch");
    assert!(burn.burn_token == d.usdc, "burn_token != USDC");
    assert!(burn.destination_caller == 0, "destination_caller != 0 (permissionless)");
    assert!(burn.max_fee == max_fee, "max_fee not forwarded unchanged");
    assert!(burn.min_finality_threshold == STANDARD_FINALITY, "finality threshold mismatch");

    // The burn carried the static CCTP forwarding hook ("cctp-forward" + 20 zero
    // bytes = the 32-byte magic).
    let mut expected_hook: ByteArray = "cctp-forward";
    expected_hook.append_word(0, 20);
    assert!(expected_hook.len() == 32, "forwarding hook must be 32 bytes");
    assert!(messenger.last_hook() == expected_hook, "burn hook_data != cctp-forward magic");

    // USDC was approved to the messenger for `amount` (approve-then-burn).
    let usdc_ctl = IMockUsdcControlDispatcher { contract_address: d.usdc };
    assert!(usdc_ctl.approve_count() >= 1, "USDC approve was not called");
    assert!(usdc_ctl.last_approve_spender() == d.messenger, "approve spender != messenger");
    assert!(usdc_ctl.last_approve_amount() == D, "approve amount != burn amount");
}

// privacy_invoke — per-tx destination selection: destination_domain rides in
// BuyParams, so one anonymizer can burn to any CCTP destination.

#[test]
fn test_privacy_invoke_burns_to_per_tx_dest_domain() {
    let d = deploy_all();
    let dispatcher = IOutboundAnonymizerDispatcher { contract_address: d.anonymizer };
    let messenger = IMockMessengerControlDispatcher { contract_address: d.messenger };
    let mint_recipient: u256 = 0xABCD;

    // Burn 1: Base (domain 6).
    start_cheat_caller_address(d.anonymizer, pool_addr());
    dispatcher.privacy_invoke(buy(mint_recipient, D, 0, STANDARD_FINALITY, BASE_DOMAIN));
    stop_cheat_caller_address(d.anonymizer);
    assert!(
        messenger.last_burn().destination_domain == BASE_DOMAIN,
        "burn must forward BuyParams.destination_domain = 6 (Base)",
    );

    // Burn 2: Polygon (domain 7) on the SAME anonymizer.
    start_cheat_caller_address(d.anonymizer, pool_addr());
    dispatcher.privacy_invoke(buy(mint_recipient, D, 0, STANDARD_FINALITY, DEST_DOMAIN));
    stop_cheat_caller_address(d.anonymizer);
    assert!(
        messenger.last_burn().destination_domain == DEST_DOMAIN,
        "burn must forward BuyParams.destination_domain = 7 (Polygon)",
    );
}

// privacy_invoke — BurnInitiated publicly emits mint_recipient + amount.

#[test]
fn test_privacy_invoke_emits_mint_recipient_publicly() {
    let d = deploy_all();
    let dispatcher = IOutboundAnonymizerDispatcher { contract_address: d.anonymizer };
    let mint_recipient: u256 = 0x00000000000000000000000070997970C51812dc3A010C7d01b50e0d17dc79C8;

    let mut spy = spy_events();

    start_cheat_caller_address(d.anonymizer, pool_addr());
    dispatcher.privacy_invoke(buy(mint_recipient, D, 0, STANDARD_FINALITY, DEST_DOMAIN));
    stop_cheat_caller_address(d.anonymizer);

    spy
        .assert_emitted(
            @array![
                (
                    d.anonymizer,
                    bridge_anonymizers::outbound_anonymizer::OutboundAnonymizer::Event::BurnInitiated(
                        bridge_anonymizers::outbound_anonymizer::OutboundAnonymizer::BurnInitiated {
                            mint_recipient, amount: D,
                        },
                    ),
                ),
            ],
        );
}
