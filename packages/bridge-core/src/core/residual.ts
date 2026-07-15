// Chain-sourced "undeposited residual" detection — the durable signal that a prior
// make-private deposit was interrupted AFTER its CCTP mint (funds minted onto the
// derived SN account) but BEFORE moveIntoPool swept them into the pool. The
// localStorage cursor (pmp.inflightPoolDeposit) only guards THIS browser; a fresh
// browser / cleared storage / different device has no cursor, so the SN account's live
// balance is the cross-browser source of truth. Reading a public `balance_of` of an
// address the app already derives leaks nothing new (threat-model unchanged).

import { readDepositTokenBalance } from './deposit';

// Sub-epsilon residual (fee change / surplus-note dust) must NOT nag Continue or fail-close a
// fresh deposit. 0.05 USDC @ 6dp. The moveIntoPool fail-closed AND the status synth both compare
// STRICTLY > this single constant so they can never disagree.
export const RESIDUAL_DUST_THRESHOLD_WEI = 50_000n;

export async function readUndepositedResidual(snAddress: string): Promise<bigint> {
  return readDepositTokenBalance(snAddress);
}
