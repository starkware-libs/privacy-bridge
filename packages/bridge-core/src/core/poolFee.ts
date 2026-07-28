// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Shared pool STRK protocol-fee helpers — the manager-paid fee-approve pattern
// used by both bridgeOut.ts (withdraw+burn / cash-out) and bridgeBack.ts (claim).
// Moved out of bridgeOut.ts, which bridgeBack.ts used to hand-copy verbatim
// ("COPIED from bridgeOut.ts... not imported to avoid cross-file coupling").
// register.ts keeps its own separate copy (outside this module's scope).

import type { Call } from 'starknet';
import { config } from './config';
import { getRpcProvider } from './provider';
import { managerExecute } from './proven-submit';
import { submitAndTrack } from './tx';

// Reads the pool's protocol fee (STRK wei) via `get_fee_amount`. The pool's
// `apply_actions` calls `collect_fee()`, pulling this from the tx caller — the
// MANAGER (the manager-paid submit's sender; see proven-submit.ts). Returns 0 if
// the view is unavailable. Mirrors register.ts:fetchPoolFeeAmount.
export async function fetchPoolFeeAmount(): Promise<bigint> {
  try {
    const result = await getRpcProvider().callContract({
      contractAddress: config.poolAddress,
      entrypoint: 'get_fee_amount',
      calldata: [],
    });
    return result[0] !== undefined ? BigInt(result[0]) : 0n;
  } catch {
    return 0n;
  }
}

// Approves `feeAmount` STRK from the MANAGER to the pool so `collect_fee()` can
// pull it during `apply_actions`. The manager is the proven submit's sender, so
// collect_fee()'s get_caller_address() is the manager — the approve must come from
// it, not the (STRK-free) derived account. No-op when zero. Returns the approve
// tx's block (when known) to seed the proving-block wait. Mirrors register.ts.
export async function approvePoolFee(feeAmount: bigint): Promise<number | undefined> {
  if (feeAmount === 0n) return undefined;
  // AVNU private-paymaster path: the pool fee is satisfied by AVNU's `fee_action`
  // (sponsored_private), not a manager STRK approve — skip it. Mirrors register.ts.
  if (config.paymaster) return undefined;
  const approveCall: Call = {
    contractAddress: config.strkToken,
    entrypoint: 'approve',
    calldata: [config.poolAddress, feeAmount.toString(), '0'],
  };
  // Route through managerExecute so this manager fee-approve shares the manager's
  // serialized, locally-sequenced nonce with the proven withdraw+burn/claim submit
  // that follows — avoids the back-to-back nonce collision (code 52). Mirrors
  // register.ts.
  const provider = getRpcProvider();
  const { blockNumber } = await submitAndTrack(
    provider,
    () => managerExecute(provider, approveCall, { tip: 0n }),
    { until: 'ACCEPTED_ON_L2' },
  );
  return blockNumber;
}
