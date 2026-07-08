//! snforge suite for `contracts_cairo::Anonymizer` (the OUTBOUND / BUY leg),
//! derived from the FROZEN `docs/bridge-interface.md` §1. CCTP messenger + USDC
//! are mocked; the Anonymizer-under-test is the real contract.
//!
//! The RETURN-leg claim / `record_return` (old H scheme) moved to a separate
//! contract, `InboundAnonymizer` (privacy-compute) — see
//! test_inbound_anonymizer.cairo. This suite covers ONLY the outbound burn:
//!  - privacy_invoke reverts if caller != pool (CALLER_NOT_POOL).
//!  - privacy_invoke (as pool) approves the messenger + deposit_for_burn_with_hook
//!    with the right (amount, dest_domain from BuyParams, mint_recipient,
//!    burn_token=USDC, destination_caller=0, max_fee, finality) + forwarding hook;
//!    returns an empty span. dest_domain is per-tx (7 = Polygon, 6 = Base).
//!  - the BurnInitiated event publicly emits mint_recipient + amount (no commitment).

use core::byte_array::ByteArrayTrait;
use contracts_cairo::{
    BuyParams, IAnonymizerDispatcher, IAnonymizerDispatcherTrait, IAnonymizerSafeDispatcher,
    IAnonymizerSafeDispatcherTrait, PrivacyAction, errors,
};
use contracts_cairo::test_mocks::{
    IMockMessengerControlDispatcher, IMockMessengerControlDispatcherTrait,
    IMockUsdcControlDispatcher, IMockUsdcControlDispatcherTrait,
};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, EventSpyAssertionsTrait, declare, spy_events,
    start_cheat_caller_address, stop_cheat_caller_address,
};
use starknet::ContractAddress;

// --- baked constructor params ---
fn pool_addr() -> ContractAddress {
    'POOL'.try_into().unwrap()
}
fn not_pool_addr() -> ContractAddress {
    'NOT_POOL'.try_into().unwrap()
}
const DEST_DOMAIN: u32 = 7; // Polygon
const BASE_DOMAIN: u32 = 6; // Base (per-tx destination selection proof)
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

    let anonymizer_class = declare("Anonymizer").unwrap().contract_class();
    // Constructor (lib.cairo): usdc, token_messenger, pool — 3 felts (outbound-only;
    // sn_domain + the H tags were dropped with the return-leg claim).
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

// --- PrivacyAction builder (Buy only) ---
fn buy(
    mint_recipient: u256, amount: u256, max_fee: u256, finality: u32, dest_domain: u32,
) -> PrivacyAction {
    PrivacyAction::Buy(
        BuyParams {
            mint_recipient, amount, max_fee, min_finality_threshold: finality, dest_domain,
        },
    )
}

// ---------------------------------------------------------------------------
// privacy_invoke — caller guard
// ---------------------------------------------------------------------------

#[test]
#[feature("safe_dispatcher")]
fn test_privacy_invoke_reverts_if_caller_not_pool() {
    let d = deploy_all();
    let safe = IAnonymizerSafeDispatcher { contract_address: d.anonymizer };
    let mint_recipient: u256 = 0xABCD;

    start_cheat_caller_address(d.anonymizer, not_pool_addr());
    let result = safe.privacy_invoke(buy(mint_recipient, D, 0, STANDARD_FINALITY, DEST_DOMAIN));
    stop_cheat_caller_address(d.anonymizer);

    match result {
        Result::Ok(_) => panic!("privacy_invoke should revert for non-pool caller"),
        Result::Err(panic_data) => {
            assert!(*panic_data.at(0) == errors::CALLER_NOT_POOL, "wrong revert reason");
        },
    }
}

// ---------------------------------------------------------------------------
// privacy_invoke — happy path: approve + deposit_for_burn args + empty span
// ---------------------------------------------------------------------------

#[test]
fn test_privacy_invoke_burns_with_correct_args() {
    let d = deploy_all();
    let dispatcher = IAnonymizerDispatcher { contract_address: d.anonymizer };
    let mint_recipient: u256 = 0x00000000000000000000000011112222333344445555666677778888; // padded EVM addr
    let max_fee: u256 = 0;

    start_cheat_caller_address(d.anonymizer, pool_addr());
    let span = dispatcher
        .privacy_invoke(buy(mint_recipient, D, max_fee, STANDARD_FINALITY, DEST_DOMAIN));
    stop_cheat_caller_address(d.anonymizer);

    // BUY leg returns nothing to the pool.
    assert!(span.len() == 0, "privacy_invoke must return an empty span");

    // deposit_for_burn called exactly once with the frozen tuple.
    let messenger = IMockMessengerControlDispatcher { contract_address: d.messenger };
    assert!(messenger.burn_count() == 1, "deposit_for_burn not called exactly once");
    let burn = messenger.last_burn();
    assert!(burn.amount == D, "burn amount != denomination");
    // dest_domain is now the PER-TX BuyParams field, not a baked constant.
    assert!(burn.destination_domain == DEST_DOMAIN, "burn dest_domain != BuyParams.dest_domain");
    assert!(burn.mint_recipient == mint_recipient, "mint_recipient mismatch");
    assert!(burn.burn_token == d.usdc, "burn_token != USDC");
    assert!(burn.destination_caller == 0, "destination_caller != 0 (permissionless)");
    assert!(burn.max_fee == max_fee, "max_fee mismatch");
    assert!(
        burn.min_finality_threshold == STANDARD_FINALITY, "finality threshold mismatch",
    );

    // The burn carried the static CCTP Forwarding-Service hook ("cctp-forward"
    // + 20 zero bytes = the 32-byte magic) so Circle forwards the destination
    // mint for us (no relayer key of ours; fee taken in USDC from the burn).
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

// ---------------------------------------------------------------------------
// privacy_invoke — PER-TX destination selection: dest_domain rides in BuyParams,
// NOT the constructor, so one Anonymizer burns to any CCTP destination. Two burns
// with different BuyParams.dest_domain (7 = Polygon, 6 = Base) must forward EXACTLY
// the value passed in — proving the domain is no longer baked.
// ---------------------------------------------------------------------------

#[test]
fn test_privacy_invoke_burns_to_per_tx_dest_domain() {
    let d = deploy_all();
    let dispatcher = IAnonymizerDispatcher { contract_address: d.anonymizer };
    let messenger = IMockMessengerControlDispatcher { contract_address: d.messenger };
    let mint_recipient: u256 = 0xABCD;

    // Burn 1: Base (domain 6) — a NON-baked destination proves per-tx selection.
    start_cheat_caller_address(d.anonymizer, pool_addr());
    dispatcher.privacy_invoke(buy(mint_recipient, D, 0, STANDARD_FINALITY, BASE_DOMAIN));
    stop_cheat_caller_address(d.anonymizer);
    assert!(
        messenger.last_burn().destination_domain == BASE_DOMAIN,
        "burn must forward BuyParams.dest_domain = 6 (Base)",
    );

    // Burn 2: Polygon (domain 7) on the SAME Anonymizer — the field, not a constant.
    start_cheat_caller_address(d.anonymizer, pool_addr());
    dispatcher.privacy_invoke(buy(mint_recipient, D, 0, STANDARD_FINALITY, DEST_DOMAIN));
    stop_cheat_caller_address(d.anonymizer);
    assert!(
        messenger.last_burn().destination_domain == DEST_DOMAIN,
        "burn must forward BuyParams.dest_domain = 7 (Polygon)",
    );
}

// ---------------------------------------------------------------------------
// privacy_invoke — PRIVACY LEAK (M2): the BurnInitiated event publicly emits the
// per-bid mint_recipient (Polygon EOA) in the SAME apply_actions tx the user's
// persistent identity SN account submits (bridgeOut.ts, no paymaster). This
// asserts the leak the threat-model documents is REAL on-chain — the event is not
// a private side-channel: identity (tx sender) -> EOA (event field) is one
// attributable Starknet tx. (Mitigated only by an SN paymaster, open Q #10/#13.)
// ---------------------------------------------------------------------------

#[test]
fn test_privacy_invoke_emits_mint_recipient_publicly() {
    let d = deploy_all();
    let dispatcher = IAnonymizerDispatcher { contract_address: d.anonymizer };
    // A recognisable padded EVM addr standing in for the per-bid Polygon EOA.
    let mint_recipient: u256 = 0x00000000000000000000000070997970C51812dc3A010C7d01b50e0d17dc79C8;

    let mut spy = spy_events();

    start_cheat_caller_address(d.anonymizer, pool_addr());
    dispatcher.privacy_invoke(buy(mint_recipient, D, 0, STANDARD_FINALITY, DEST_DOMAIN));
    stop_cheat_caller_address(d.anonymizer);

    // The real deployed contract emitted BurnInitiated carrying the per-bid EOA
    // (mint_recipient) + amount — publicly, from the same tx whose sender is the
    // identity account. assert_emitted matches the EXACT typed event (keys + data):
    // this struct has only mint_recipient + amount (no commitment field).
    spy
        .assert_emitted(
            @array![
                (
                    d.anonymizer,
                    contracts_cairo::Anonymizer::Event::BurnInitiated(
                        contracts_cairo::Anonymizer::BurnInitiated { mint_recipient, amount: D },
                    ),
                ),
            ],
        );
}
