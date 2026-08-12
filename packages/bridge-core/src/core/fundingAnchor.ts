// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Funding anchor — the block from which a deposit wallet's burn history is COMPLETE.
//
// Recovery has to distinguish "we found no burn" from "there is no burn". Only the second
// justifies leaving a slot alone, and the difference is entirely a property of the window
// that was scanned: a scan from an arbitrary block back proves nothing, while a scan from
// the block the wallet came into existence covers every burn it could ever have made. The
// depositor of a return burn is the deposit wallet CONTRACT, and a contract cannot be
// msg.sender before it has code — so its deployment block is that anchor.
//
// The cap keeps the anchor affordable: 60 days of Polygon blocks is ~21 reads. Past the cap
// the answer is not "no burn" but "we did not look" — a distinct verdict the caller must
// treat as absence UNPROVEN, never settled. Raising the cap widens coverage, no migration.
//
// `getTransactionCount` on the derived EOA is NEVER an anchor: that key only signs EIP-712
// batches and never sends a transaction, so its nonce stays 0 for the wallet's whole life.
import type { PublicClient } from 'viem';

import { config } from './config';

// ≈60 days of ~2 s Polygon blocks. Mirrors the `recoveryCapBlocks` config default, which
// is what callers actually get; this is the compile-time constant callers can name.
export const RECOVERY_CAP_BLOCKS = 2_592_000n;

export type FundingAnchor =
  // No code at head ⇒ the wallet never existed ⇒ no wallet-executed burn can exist.
  // PROVEN absence, for one read.
  | { kind: 'never-deployed' }
  // Code already present at the cap floor: the wallet predates the window we are willing
  // to search, so its complete history is out of reach. Absence is NOT proven. Deliberately
  // carries no anchorBlock — the search never ran.
  | { kind: 'beyond-cap' }
  // The wallet's first block with code, plus the head that fact was read at. Scanning
  // [anchorBlock, head] INCLUSIVE covers every burn the wallet ever made — the anchor block
  // itself included, since deploy+burn in one transaction is a designed flow.
  | { kind: 'anchored'; anchorBlock: bigint; head: bigint };

// viem collapses an empty `eth_getCode` result to `undefined`; a raw provider returns '0x'.
// Treat both as codeless and anything else as deployed.
function hasCode(code: `0x${string}` | undefined): boolean {
  return code !== undefined && code !== '0x';
}

// Resolve the anchor for one deposit wallet. Every read is pinned to an explicit block so
// the verdict describes the head it reports rather than drifting with 'latest'.
//
// ANY read that throws propagates. An RPC failure is UNKNOWN — degrading it to
// 'never-deployed' would tell the caller a wallet has no burn history on the strength of a
// 429, and the caller's next step is to stop looking.
export async function resolveFundingAnchor(
  client: PublicClient,
  depositWallet: `0x${string}`,
  capBlocks: bigint = BigInt(config.recoveryCapBlocks),
): Promise<FundingAnchor> {
  if (capBlocks <= 0n) {
    throw new Error(`funding-anchor cap must be a positive block count (got ${capBlocks})`);
  }
  const readCode = (blockNumber: bigint) => client.getCode({ address: depositWallet, blockNumber });

  const head = await client.getBlockNumber();
  if (!hasCode(await readCode(head))) return { kind: 'never-deployed' };

  const capFloor = head > capBlocks ? head - capBlocks : 0n;
  if (hasCode(await readCode(capFloor))) {
    // Deployed at or before the floor. When the floor IS genesis the cap already spans the
    // whole chain, so [0, head] is a complete window and the anchor is 0 — only a floor
    // above genesis leaves history we refused to search.
    return capFloor === 0n ? { kind: 'anchored', anchorBlock: 0n, head } : { kind: 'beyond-cap' };
  }

  // Invariant: codeless at `lo`, code at `hi`. Each read halves the gap, so `hi` converges
  // on the first block with code — the deployment block.
  let lo = capFloor;
  let hi = head;
  while (hi - lo > 1n) {
    const mid = lo + (hi - lo) / 2n;
    if (hasCode(await readCode(mid))) hi = mid;
    else lo = mid;
  }
  return { kind: 'anchored', anchorBlock: hi, head };
}
