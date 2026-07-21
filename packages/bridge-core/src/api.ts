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
 */

// Re-export the underlying engines so callers can also access low-level types/fns.
export * from './core/config';
export * from './core/register';
export * from './core/deposit';
export * from './core/depositIn';
export * from './core/onrampPoll';
export * from './core/balance';
export * from './core/discover';
export * from './core/moveIntoPool';
export * from './core/residual';
export * from './core/bridgeTransferStatus';
export * from './core/bridgeOut';
export * from './core/bridgeBack';
export * from './core/unclaimedReturns';
export * from './core/bridgeFunding';
export * from './core/accountScan';
export * from './core/returnIn';
export * from './core/polygonMint';
export * from './core/proven-submit';
export * from './core/avnuPaymaster';
export * from './core/deploy';
export * from './core/provider';
export * from './core/cctpFees';
export * from './core/cctpBytes';
export * from './core/proving';
export * from './core/snMint';
export * from './core/strkPrice';
export * from './core/tx';
export * from './core/errors';
export * from './core/cancel';
export * from './core/errorMessages';
export * from './core/walletErrors';
export * from './core/account-store';
export * from './core/polygonClient';
