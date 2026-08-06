// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Device-local persisted state for the bridge/privacy app. EVERYTHING the app
// writes to localStorage is namespaced under `pmp.*` and is NON-SECRET by policy
// (public addresses, the read-only pool viewing key, non-secret account-funding
// indices/cursors — never the private key, the raw wallet signature, or claim
// secrets).
//
// This is the bridge-core mirror of apps/web's identity/device-store.ts: the
// single source of truth for the key set so "Disconnect / Forget this device"
// can wipe it all in one place, and so WalletProvider can clear it without
// importing the heavier identity contexts (which pull in the private
// starknet-privacy SDK). bridge-core already writes these same `pmp.*` keys from
// account-store/depositIn/returnIn, so the wipe list lives here.

// Every persisted key the app owns. Kept in sync with the constants in
// account-store.ts, depositIn.ts, and returnIn.ts, PLUS the app-side identity
// stores that write per-EVM-address metadata (apps/web/src/identity: history-
// store.ts, chain-sync-store.ts, unclaimed-store.ts). Those app-only keys are
// wiped HERE because this is the single point disconnect()/"Forget this device"
// clears (bridge-core is acyclic-below the apps, so it can't import their stores
// — it carries the frozen key STRINGS instead). The key STRINGS below are frozen
// wire values — never rename them, only the
// surrounding identifiers/comments.
export const PMP_STORAGE_KEYS = [
  'pmp.identity', // derived Starknet address + public key + viewing key
  'pmp.bids', // per-EVM-address derived-account history (non-secret metadata)
  'pmp.bidIndex', // next unused per-account index (non-secret counter)
  'pmp.inflightBurn', // in-flight account-funding resume cursor (post-burn, pre-mint)
  'pmp.inflightDeposit', // in-flight CCTP deposit-in resume cursor
  'pmp.inflightPoolDeposit', // in-flight pool-deposit resume cursor (poolDepositCursor; Row 1 double-burn guard)
  'pmp.inflightReturn', // in-flight return-funds resume cursor (returnIn.INFLIGHT_RETURN_KEY)
  'pmp.pendingReturnBurn', // submitted-but-unconfirmed return burn (pendingReturnBurn.PENDING_RETURN_BURN_KEY)
  'pmp.inflightCashOut', // in-flight cash-out (Leg B) resume cursor (post-burn, pre-Polygon-mint)
  'pmp.closed', // app-side: per-EVM-address closed-position history cache (deposit wallets + P&L) — history-store.ts
  'pmp.chainSync', // app-side: per-EVM-address chain-scan timestamps — chain-sync-store.ts
  'pmp.unclaimedReturns', // app-side: per-EVM-address unclaimed-return metadata (account indices + amounts) — unclaimed-store.ts
  'pmp.poolReturns', // app-side: per-EVM-address completed pool-return log (bid indices + Starknet claim tx hashes + amounts) — pool-returns-store.ts
  'pmp.walletRdns', // the wallet the user picked last (EIP-6963 rdns, e.g. "io.metamask") — see walletPickStore
] as const;

// The remembered wallet pick. Storing WHICH wallet the user chose (an EIP-6963 rdns —
// a public vendor identifier like "io.metamask", never an address or key) is what lets
// a returning visit resolve the same provider BEFORE any user interaction. Without it
// `selectedRdns` starts null on every load, so with 2+ injected wallets the
// ambiguous-multi guard refuses the silent `eth_accounts` read, `canResume` stays
// false, and the user is sent back through the picker on every single reload.
//
// It rides in PMP_STORAGE_KEYS above, so "Disconnect / Forget this device" wipes it
// like every other device-local trace.
const WALLET_RDNS_KEY = 'pmp.walletRdns';

/** The rdns of the wallet last connected on this device, or null. */
export function readWalletPick(): string | null {
  try {
    const rdns = localStorage.getItem(WALLET_RDNS_KEY);
    return rdns !== null && rdns !== '' ? rdns : null;
  } catch {
    // A disabled/partitioned localStorage just means no remembered pick.
    return null;
  }
}

/** Remember the wallet the user connected with. Best-effort — never throws. */
export function writeWalletPick(rdns: string): void {
  try {
    localStorage.setItem(WALLET_RDNS_KEY, rdns);
  } catch {
    // ignore — remembering is an optimization, never a requirement.
  }
}

// Remove all pmp.* state for this device. Used by disconnect()/"Forget this
// device". Best-effort — a disabled/quota-limited localStorage must not throw
// and break the disconnect.
export function clearDeviceIdentity(): void {
  try {
    for (const key of PMP_STORAGE_KEYS) {
      localStorage.removeItem(key);
    }
  } catch {
    // ignore — clearing is best-effort.
  }
}
