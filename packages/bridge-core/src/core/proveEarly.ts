// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Shared prove-early machinery: the "skip the PROVING_BLOCK_DEPTH aging wait when
// the account is provably quiescent" pattern used by bridgeOut.ts (withdraw/sell)
// and bridgeBack.ts (return claim). Extracted so both flows share ONE
// implementation instead of hand-copying it — bridgeBack.ts used to hand-copy this
// verbatim and its copy silently regressed to always-aging (a `?? getCurrentBlock()`
// fallback defeated its own "skip aging" comment), which a shared implementation
// makes structurally impossible to repeat.

import type { RpcProvider } from 'starknet';
import { discoverNoteIdsAtBlock } from './discover.js';
import { sanitizeErrorMessage } from './tx.js';
import {
  getCurrentBlock,
  waitForProvingBlock,
  IMMEDIATE_PROVING_BLOCK_DEPTH,
  PROVING_BLOCK_DEPTH,
} from './proving.js';

export interface QuiescenceGateArgs {
  provider: RpcProvider;
  snAddress: string;
  viewingKey: bigint;
  tokens: readonly bigint[];
  onStatus?: (s: string) => void;
}

export interface QuiescenceGateResult {
  eligible: boolean;
  immediateBase: number;
}

// SAFE to skip the aging wait only when the account committed NO state in the last
// IMMEDIATE_PROVING_BLOCK_DEPTH blocks — otherwise a stale immediate-base view can
// reuse an already-consumed write-once slot, and the SDK still builds a VALID proof
// that reverts ON-CHAIN (NON_ZERO_VALUE). Compares the account's spendable note-id
// SET (not count — a spent-with-no-change note is a removal a count/max gate would
// miss) at `latest - IMMEDIATE_PROVING_BLOCK_DEPTH` vs head. FAIL-SAFE: ANY discovery
// failure (indexer down, historical block_ref unsupported) degrades to "not
// eligible" — never aborts the caller's flow (this is a pre-relay read; failure is
// safe/retryable — worst case is today's aging wait).
export async function checkProveEarlyQuiescence(
  args: QuiescenceGateArgs,
): Promise<QuiescenceGateResult> {
  const { provider, snAddress, viewingKey, tokens, onStatus } = args;
  const immediateBase = Math.max(
    (await getCurrentBlock(provider)) - IMMEDIATE_PROVING_BLOCK_DEPTH,
    0,
  );
  let eligible = false;
  onStatus?.('Checking recent activity…');
  try {
    const [atBase, atHead] = await Promise.all([
      discoverNoteIdsAtBlock({ snAddress, viewingKey, tokens, blockIdentifier: immediateBase }),
      discoverNoteIdsAtBlock({ snAddress, viewingKey, tokens, blockIdentifier: 'pre_confirmed' }),
    ]);
    eligible = atBase.length === atHead.length && atBase.every((id, i) => id === atHead[i]);
    if (!eligible) onStatus?.('Recent pool activity detected; aging the proof…');
  } catch {
    eligible = false;
  }
  return { eligible, immediateBase };
}

export interface ProveWithImmediateFallbackArgs<T> {
  provider: RpcProvider;
  immediateBase: number;
  // Anchor to age from if the immediate attempt fails — the caller's freshest known
  // committed dependency (or the current head, when there is none). LAZY: only
  // invoked on the fallback path, so callers that already have a cheap in-hand value
  // (bridgeOut's pre-captured anchor) don't pay for a caller that needs a fresh RPC
  // read (bridgeBack, which has no other anchor when the immediate path was chosen).
  resolveAgingAnchor: () => number | Promise<number>;
  onStatus?: (s: string) => void;
  buildAndProveAt: (provingBlockId: number | string) => Promise<T>;
}

export interface ProveWithImmediateFallbackResult<T> {
  result: T;
  provingBlockId: number | string;
}

// Try the prove-early IMMEDIATE path first (no aging wait). The quiescence gate above
// is a pre-check, not a guarantee — a note can still land/spend in the race between
// the gate's read and this build. On ANY failure (catch-all: an indexer "latest
// tagged N" snapshot can surface the shortfall at the prove step, not compile), fall
// back ONCE to the aged path so the caller doesn't hard-fail.
export async function proveWithImmediateFallback<T>(
  args: ProveWithImmediateFallbackArgs<T>,
): Promise<ProveWithImmediateFallbackResult<T>> {
  const { provider, immediateBase, resolveAgingAnchor, onStatus, buildAndProveAt } = args;
  try {
    const result = await buildAndProveAt(immediateBase);
    return { result, provingBlockId: immediateBase };
  } catch (immediateErr) {
    onStatus?.(`Immediate prove failed (${sanitizeErrorMessage(immediateErr)}); aging…`);
    const agingAnchor = await resolveAgingAnchor();
    const agedBlockId = await waitForProvingBlock(
      provider,
      agingAnchor,
      onStatus,
      PROVING_BLOCK_DEPTH,
    );
    const result = await buildAndProveAt(agedBlockId);
    return { result, provingBlockId: agedBlockId };
  }
}
