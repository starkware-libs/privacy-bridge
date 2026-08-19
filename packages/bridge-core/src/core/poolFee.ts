// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Shared pool STRK protocol-fee helpers: the single place that READS the pool's fee
// (`get_fee_amount`) and the manager-paid fee-approve that settles it. Used by
// bridgeOut.ts (withdraw+burn / cash-out), bridgeBack.ts (claim), register.ts, and
// by consuming apps for the user-facing fee estimate.

import type { Call } from 'starknet';
import { formatUnits } from 'viem';
import { config } from './config.js';
import { getRpcProvider } from './provider.js';
import { managerExecute } from './proven-submit.js';
import { submitAndTrack } from './tx.js';

// STRK is an 18-decimal token, so `get_fee_amount` (wei) → human units divides by 1e18.
const STRK_DECIMALS = 18;

// Reads the pool's protocol fee (STRK wei) via `get_fee_amount` — the pool itself is
// the source of truth for the fee, so a protocol-fee change needs no client release.
// The pool's `apply_actions` calls `collect_fee()`, pulling this from the tx caller —
// the MANAGER (the manager-paid submit's sender; see proven-submit.ts).
//
// Propagates an UNAVAILABLE view as `null`: "the fee is 0" and "we couldn't read the
// fee" are different facts, and a caller that RESERVES the fee must not treat the
// second as the first (see fetchPoolFeeStrk). Callers that can prove 0 is safe use
// fetchPoolFeeAmount below.
export async function readPoolFeeAmount(): Promise<bigint | null> {
  try {
    const result = await getRpcProvider().callContract({
      contractAddress: config.poolAddress,
      entrypoint: 'get_fee_amount',
      calldata: [],
    });
    return result[0] !== undefined ? BigInt(result[0]) : null;
  } catch {
    return null;
  }
}

// readPoolFeeAmount with an unreadable view collapsed to 0 — safe for the APPROVE
// path only, where a 0 means "skip the approve" and the pool's own `collect_fee()`
// is the authority that reverts if a fee was in fact due.
export async function fetchPoolFeeAmount(): Promise<bigint> {
  return (await readPoolFeeAmount()) ?? 0n;
}

// The live pool fee in HUMAN STRK units — the shape `config.depositFeeStrk` and
// `strkFeeToUsdc` take — so the UI's fee estimate tracks the pool's on-chain fee
// instead of a baked-in number.
//
// `null` when the view is unavailable OR reads non-positive, so the caller keeps its
// configured fallback (`config.depositFeeStrk`). A non-positive read must NOT become
// a '0' estimate: strkFeeToUsdc rejects a non-positive fee and returns its own '0.5'
// default, which would silently size a reserve off a number unrelated to the pool.
export async function fetchPoolFeeStrk(): Promise<string | null> {
  const wei = await readPoolFeeAmount();
  if (wei === null || wei <= 0n) return null;
  return formatUnits(wei, STRK_DECIMALS);
}

// Approves `feeAmount` STRK from the MANAGER to the pool so `collect_fee()` can
// pull it during `apply_actions`. The manager is the proven submit's sender, so
// collect_fee()'s get_caller_address() is the manager — the approve must come from
// it, not the (STRK-free) derived account. No-op when zero. Returns the approve
// tx's block (when known) to seed the proving-block wait.
export async function approvePoolFee(feeAmount: bigint): Promise<number | undefined> {
  if (feeAmount === 0n) return undefined;
  // AVNU private-paymaster path: the pool fee is satisfied by AVNU's `fee_action`
  // (sponsored_private), not a manager STRK approve — skip it.
  if (config.paymaster) return undefined;
  const approveCall: Call = {
    contractAddress: config.strkToken,
    entrypoint: 'approve',
    calldata: [config.poolAddress, feeAmount.toString(), '0'],
  };
  // Route through managerExecute so this manager fee-approve shares the manager's
  // serialized, locally-sequenced nonce with the proven withdraw+burn/claim submit
  // that follows — avoids the back-to-back nonce collision (code 52).
  const provider = getRpcProvider();
  const { blockNumber } = await submitAndTrack(
    provider,
    () => managerExecute(provider, approveCall, { tip: 0n }),
    { until: 'ACCEPTED_ON_L2' },
  );
  return blockNumber;
}
