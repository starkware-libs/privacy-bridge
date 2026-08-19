// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

/**
 * bridge-core public API surface.
 *
 * Generic, account-centric (bidirectional):
 *   moveIntoPool  — EVM wallet → pool
 *   moveFromPool  — pool → any account
 *   register      — pool identity registration
 *   discover      — note discovery (viewing key)
 *   balance       — private balance (viewing key)
 *
 * Per-account convenience layer (built on the generic core):
 *   deriveAccountWallet    — derive fresh per-account Polygon EOA
 *   fundAccountFromPool    — withdraw from pool → CCTP burn → Polygon EOA (BUY path steps 1-2)
 *   returnToPool           — CCTP burn Polygon → pool (return path)
 *
 * Starknet-native exits (one proven tx, no CCTP):
 *   withdrawToStarknet     — pool → a Starknet address
 *   sendPrivateToStarknet  — pool → another pool identity, value never leaves the pool
 */

// Re-export the underlying engines so callers can also access low-level types/fns.
export * from './core/config.js';
export * from './core/register.js';
export * from './core/deposit.js';
export * from './core/depositIn.js';
export * from './core/onrampPoll.js';
export * from './core/balance.js';
export * from './core/discover.js';
export * from './core/moveIntoPool.js';
export * from './core/poolFee.js';
export * from './core/residual.js';
export * from './core/bridgeTransferStatus.js';
export * from './core/bridgeOut.js';
export * from './core/withdrawToStarknet.js';
export * from './core/bridgeBack.js';
export * from './core/unclaimedReturns.js';
export * from './core/bridgeFunding.js';
export * from './core/accountScan.js';
export * from './core/returnIn.js';
export * from './core/resolveOpenReturn.js';
export * from './core/pendingReturnBurn.js';
export * from './core/polygonMint.js';
export * from './core/proven-submit.js';
export * from './core/avnuPaymaster.js';
export * from './core/deploy.js';
export * from './core/provider.js';
export * from './core/cctpFees.js';
export * from './core/cctpBytes.js';
export * from './core/proving.js';
export * from './core/snMint.js';
export * from './core/strkPrice.js';
export * from './core/tx.js';
export * from './core/errors.js';
export * from './core/errorMessages.js';
export * from './core/walletErrors.js';
export * from './core/account-store.js';
export * from './core/polygonClient.js';
