//! Outbound Anonymizer: pool withdraw recipient → CCTP (the BUY leg).
//!
//! FROZEN interface: ../../docs/bridge-interface.md §1. Design + locked
//! decisions: ../../docs/bridge-plan.md. Models the reference
//! `starknet-privacy/packages/ekubo_swap_anonymizer` /
//! `vesu_lending_anonymizer` (caller==pool; only approve + the external
//! call + return a `Span<OpenNoteDeposit>`; never calls back into the pool).
//!
//! `privacy_invoke(PrivacyAction::Buy)` is the SINGLE pool-driven entrypoint;
//! the `caller == pool` guard is enforced once. The pool runs
//! `Withdraw{recipient = self, amount = D}` first, so this contract already
//! holds USDC when `privacy_invoke` runs; it then `approve`s the CCTP
//! TokenMessengerMinterV2 and `deposit_for_burn_with_hook`s to the per-tx
//! destination (`mint_recipient` = per-bid EOA) and returns an EMPTY span
//! (nothing returns to the pool). The per-bid commitment is NOT emitted
//! on-chain (bridge-plan.md, threat-model.md).
//!
//! The RETURN leg (CCTP → pool) is a SEPARATE contract — `InboundAnonymizer`
//! (src/inbound_anonymizer.cairo), built on the pool's privacy-compute feature
//! (no sub-accounts). The old H-commitment / `record_return` poke / claim path
//! that used to live here has been REMOVED (retired — bridge-plan.md §2/§4,
//! bridge-interface.md §5/§6).

use starknet::ContractAddress;

/// `OpenNoteDeposit` and the ERC20 surface are shared crate-root items; re-exported
/// here so `super::…` resolves inside the `Anonymizer` module below.
pub use crate::{IERC20, IERC20Dispatcher, IERC20DispatcherTrait, OpenNoteDeposit};

/// CCTP `TokenMessengerMinterV2` burn entrypoints — exact signatures/param
/// order from circlefin/starknet-cctp `master`
/// (`packages/interfaces/src/token_messager_minter_v2.cairo`). No return value.
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
    /// Same as `deposit_for_burn` but appends opaque `hook_data` to the burn
    /// message. We attach the static CCTP **Forwarding-Service** hook so Circle
    /// submits the destination (Polygon) mint for us — no relayer key of ours —
    /// and deducts its fee IN USDC from the burned amount. `hook_data` is an
    /// opaque `ByteArray` (NOT endianness-converted by CCTP); panics if zero-length.
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

/// BUY-leg params for `privacy_invoke(PrivacyAction::Buy)`. The pool has already
/// run `Withdraw{recipient = self}`, so this contract holds the USDC; these are
/// the CCTP burn args toward the per-bid destination EOA. The per-bid commitment
/// is NOT carried here — it lives client-side + on the RETURN leg only
/// (bridge-plan.md, threat-model.md).
///
/// `dest_domain` is PER-TX (appended last), not baked into the constructor: one
/// Anonymizer can burn to any CCTP destination (Polygon=7, Base=6, …). It rides
/// in the `InvokeExternal` calldata, not the proven `Withdraw` — no ZK-proof change.
#[derive(Serde, Drop)]
pub struct BuyParams {
    pub mint_recipient: u256,
    pub amount: u256,
    pub max_fee: u256,
    pub min_finality_threshold: u32,
    pub dest_domain: u32,
}

/// Discriminated action for `privacy_invoke`. Serde serializes an enum as
/// `[variant_index, ...fields]`, so the calldata is `[0, ...BuyParams]` for Buy.
/// Only the BUY leg remains on this (outbound) contract; the RETURN-leg claim
/// moved to `InboundAnonymizer` (privacy-compute). Kept as an enum (single arm)
/// so the frozen `[0, ...]` calldata layout and the pool's hardcoded
/// `privacy_invoke` selector are unchanged.
#[derive(Serde, Drop)]
pub enum PrivacyAction {
    Buy: BuyParams,
}

/// Anonymizer entrypoint (mirrors the reference `IEkuboSwapAnonymizer` /
/// `IVesuLendingAnonymizer` shape: `privacy_invoke` returns a span the pool
/// applies). Pool-driven; the `caller == pool` guard is enforced inside.
#[starknet::interface]
pub trait IAnonymizer<TContractState> {
    fn privacy_invoke(ref self: TContractState, action: PrivacyAction) -> Span<OpenNoteDeposit>;
}

pub mod errors {
    /// `privacy_invoke` caller is not the baked pool address.
    pub const CALLER_NOT_POOL: felt252 = 'CALLER_NOT_POOL';
    pub const ZERO_AMOUNT: felt252 = 'ZERO_AMOUNT';
    /// Burn `amount` is not strictly greater than the CCTP `max_fee`, so the
    /// whole burn could be consumed by the fee and mint zero USDC.
    pub const AMOUNT_LE_MAX_FEE: felt252 = 'AMOUNT_LE_MAX_FEE';
}

#[starknet::contract]
pub mod Anonymizer {
    use core::byte_array::ByteArrayTrait;
    use core::num::traits::Zero;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address};
    use super::{
        BuyParams, IAnonymizer, IERC20Dispatcher, IERC20DispatcherTrait,
        ITokenMessengerMinterV2Dispatcher, ITokenMessengerMinterV2DispatcherTrait, OpenNoteDeposit,
        PrivacyAction, errors,
    };

    /// Permissionless mint on the destination domain (`destination_caller = 0`).
    const PERMISSIONLESS_CALLER: u256 = 0;

    /// The static CCTP Forwarding-Service hook: the 12 ASCII bytes of
    /// "cctp-forward" followed by 20 zero bytes (version 0, length 0) = the
    /// 32-byte magic 0x636374702d666f7277617264000…0. Attaching it to the burn
    /// tells Circle's Forwarding Service to submit the destination mint for us
    /// and take its fee in USDC. `hook_data` is opaque (no endianness conversion),
    /// so we emit the exact byte sequence; must be non-zero-length (CCTP panics
    /// on an empty hook).
    fn forwarding_hook_data() -> ByteArray {
        let mut hook: ByteArray = "cctp-forward";
        hook.append_word(0, 20);
        hook
    }

    #[storage]
    struct Storage {
        // Fixed params baked at construction (bridge-interface.md §1).
        usdc: ContractAddress,
        token_messenger: ContractAddress,
        pool: ContractAddress,
        // dest_domain is NOT baked — it is a per-tx BuyParams field so one
        // Anonymizer can burn to any CCTP destination (bridge-interface.md §1).
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        BurnInitiated: BurnInitiated,
    }

    /// Emitted on the BUY leg. The per-bid commitment is NOT published here — it
    /// lives client-side + on the return leg only (bridge-plan.md, threat-model.md).
    /// `mint_recipient` + `amount` still leak in this event, emitted from the same
    /// identity-signed pool tx.
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
    pub impl AnonymizerImpl of IAnonymizer<ContractState> {
        /// SINGLE pool-driven entrypoint (bridge-interface.md §1). Pool-only: the
        /// `CALLER_NOT_POOL` guard is enforced here, then the BUY burn runs.
        /// Never calls back into the pool.
        fn privacy_invoke(
            ref self: ContractState, action: PrivacyAction,
        ) -> Span<OpenNoteDeposit> {
            // Only the baked privacy pool may drive the burn.
            assert(get_caller_address() == self.pool.read(), errors::CALLER_NOT_POOL);

            match action {
                PrivacyAction::Buy(p) => self._do_burn(p),
            }
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        /// BUY-leg burn body (`PrivacyAction::Buy`). The pool has already run
        /// `Withdraw{recipient = self, amount}` so USDC sits on this contract.
        /// `approve(token_messenger, amount)` then `deposit_for_burn_with_hook(dest =
        /// p.dest_domain, mint_recipient = per-bid EOA, destination_caller = 0)`.
        /// Returns an EMPTY span — nothing returns to the pool on the BUY leg.
        fn _do_burn(ref self: ContractState, p: BuyParams) -> Span<OpenNoteDeposit> {
            // A zero-amount burn would emit a phantom commitment that can never be
            // claimed (#11). And the burn must clear the CCTP fee, otherwise the
            // whole amount is consumed by `max_fee` and zero USDC mints (#12).
            assert(p.amount.is_non_zero(), errors::ZERO_AMOUNT);
            assert(p.amount > p.max_fee, errors::AMOUNT_LE_MAX_FEE);

            let usdc = self.usdc.read();
            let token_messenger = self.token_messenger.read();

            // Approve the TokenMessengerMinterV2 to pull `amount` USDC, then burn.
            IERC20Dispatcher { contract_address: usdc }
                .approve(spender: token_messenger, amount: p.amount);

            // Burn WITH the CCTP Forwarding-Service hook: Circle watches for the
            // static "cctp-forward" hook and submits the destination mint for us
            // (no relayer key of ours), deducting its fee in USDC from the burned
            // amount (recipient receives amount - max_fee). bridge-plan.md #9.
            ITokenMessengerMinterV2Dispatcher { contract_address: token_messenger }
                .deposit_for_burn_with_hook(
                    amount: p.amount,
                    destination_domain: p.dest_domain,
                    mint_recipient: p.mint_recipient,
                    burn_token: usdc,
                    destination_caller: PERMISSIONLESS_CALLER,
                    max_fee: p.max_fee,
                    min_finality_threshold: p.min_finality_threshold,
                    hook_data: forwarding_hook_data(),
                );

            self
                .emit(
                    Event::BurnInitiated(
                        BurnInitiated { mint_recipient: p.mint_recipient, amount: p.amount },
                    ),
                );

            // BUY leg returns nothing to the pool.
            array![].span()
        }
    }
}
