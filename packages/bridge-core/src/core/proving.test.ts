// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcProvider } from 'starknet';
import {
  PROVING_BLOCK_DEPTH,
  IMMEDIATE_PROVING_BLOCK_DEPTH,
  waitForProvingBlock,
  isProofExpiredError,
  isNodeLagError,
} from './proving';

// Unit test for the proving-block selector (proving.ts).
//
// THE CONTRACT (see proving.ts header + the Q3 fix):
//   - Prove at `latest - PROVING_BLOCK_DEPTH` (the sequencer rejects proofs past
//     latest-10; we prove at latest-8 with headroom).
//   - The aging WAIT only fires BETWEEN DEPENDENT actions: a recent
//     `lastTxBlockNumber` whose committed state the next proof must read. It
//     busy-waits ~1s/iter until that tx is buried >= PROVING_BLOCK_DEPTH deep.
//   - When `lastTxBlockNumber` is undefined (an INDEPENDENT action) OR already
//     buried, it returns immediately with NO wait.
//   - Result is clamped to >= 0 for very young chains.
//
// We mock only the provider's getBlockNumber (the single chain read), advancing
// the reported head per poll iteration with fake timers to exercise the wait.

const getBlockNumber = vi.fn<() => Promise<number>>();
const provider = { getBlockNumber } as unknown as RpcProvider;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('waitForProvingBlock — independent / already-buried (no wait)', () => {
  it('(#8) independent action (lastTxBlockNumber undefined) never enters the wait loop', async () => {
    getBlockNumber.mockResolvedValue(100);

    const proveAt = await waitForProvingBlock(provider, undefined);

    // Proves at latest - DEPTH immediately, with a SINGLE chain read (no poll).
    expect(proveAt).toBe(100 - PROVING_BLOCK_DEPTH);
    expect(getBlockNumber).toHaveBeenCalledTimes(1);
  });

  it('(#5) buried last tx returns latest - DEPTH immediately with one read, no sleep', async () => {
    getBlockNumber.mockResolvedValue(100);
    // Last tx at 50 is far older than 100 - 8 = 92 → already buried.
    const onStatus = vi.fn();

    const proveAt = await waitForProvingBlock(provider, 50, onStatus);

    expect(proveAt).toBe(92);
    expect(getBlockNumber).toHaveBeenCalledTimes(1);
    // No aging wait → no countdown status emitted.
    expect(onStatus).not.toHaveBeenCalled();
  });
});

describe('waitForProvingBlock — recent last tx (waits until buried)', () => {
  it('(#6) busy-waits until the last tx is buried >= DEPTH deep, re-reading head each iter', async () => {
    vi.useFakeTimers();
    // Last tx at block 100. It must be buried until latest - 8 >= 100, i.e.
    // latest >= 108. Advance the reported head one block per poll iteration.
    const lastTx = 100;
    let head = 105; // start: 105 - 8 = 97 < 100 → must wait
    getBlockNumber.mockImplementation(async () => head);

    const onStatus = vi.fn();
    let settled = false;
    const p = waitForProvingBlock(provider, lastTx, onStatus).then((v) => {
      settled = true;
      return v;
    });

    // Drive the poll loop: bump the head one block then flush the 1s sleep so the
    // loop's next re-read sees the aged chain. The loop CONTINUES while
    // `lastTx >= head - DEPTH` (i.e. head <= 108) and exits once head >= 109.
    for (let i = 0; i < 15 && !settled; i++) {
      head += 1;
      await vi.advanceTimersByTimeAsync(1000);
    }
    const finalHead = head;
    const proveAt = await p;

    // Once head reaches 109, latest - 8 = 101 > lastTx (100) → loop exits and it
    // proves at the buried block.
    expect(proveAt).toBe(finalHead - PROVING_BLOCK_DEPTH);
    expect(proveAt).toBeGreaterThanOrEqual(lastTx);
    // Re-read the head multiple times (initial + one per poll iteration).
    expect(getBlockNumber.mock.calls.length).toBeGreaterThan(1);

    // The countdown status was surfaced while blocking, and it DECREASES
    // (~N more) as the chain ages — so the multi-block wait doesn't look stuck.
    expect(onStatus).toHaveBeenCalled();
    const counts = onStatus.mock.calls
      .map((c) => /~(\d+) more/.exec(c[0] as string)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number);
    expect(counts.length).toBeGreaterThan(1);
    // Monotonically non-increasing countdown.
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
    }
    vi.useRealTimers();
  });
});

describe('waitForProvingBlock — custom (IMMEDIATE) depth (Part A / Part C prove-early)', () => {
  it('proves at latest - IMMEDIATE_PROVING_BLOCK_DEPTH when given the immediate depth (no aging)', async () => {
    // The immediate depth is DEEPER than the default so the base clears the sequencer's
    // ~10-block get_block_hash floor even without an aging wait (blocks do not pass
    // between prove and execute on the prove-early path).
    expect(IMMEDIATE_PROVING_BLOCK_DEPTH).toBeGreaterThan(PROVING_BLOCK_DEPTH);
    expect(IMMEDIATE_PROVING_BLOCK_DEPTH).toBeGreaterThanOrEqual(10);
    getBlockNumber.mockResolvedValue(100);
    const onStatus = vi.fn();

    // Independent action (undefined last tx) + the immediate depth → prove NOW at
    // latest - IMMEDIATE_PROVING_BLOCK_DEPTH, one read, no aging wait.
    const proveAt = await waitForProvingBlock(provider, undefined, onStatus, IMMEDIATE_PROVING_BLOCK_DEPTH);

    expect(proveAt).toBe(100 - IMMEDIATE_PROVING_BLOCK_DEPTH);
    expect(getBlockNumber).toHaveBeenCalledTimes(1);
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('still ages against a recent dependency at the custom depth when one is supplied', async () => {
    vi.useFakeTimers();
    const lastTx = 100;
    let head = 108; // 108 - 12 = 96 < 100 → must wait at the immediate depth
    getBlockNumber.mockImplementation(async () => head);

    let settled = false;
    const p = waitForProvingBlock(provider, lastTx, undefined, IMMEDIATE_PROVING_BLOCK_DEPTH).then((v) => {
      settled = true;
      return v;
    });
    for (let i = 0; i < 20 && !settled; i++) {
      head += 1;
      await vi.advanceTimersByTimeAsync(1000);
    }
    const proveAt = await p;
    // Exits once head - 12 > 100, i.e. head >= 113 → proves at head - 12 (>= lastTx).
    expect(proveAt).toBe(head - IMMEDIATE_PROVING_BLOCK_DEPTH);
    expect(proveAt).toBeGreaterThanOrEqual(lastTx);
    vi.useRealTimers();
  });
});

describe('isProofExpiredError — pool proof-freshness reverts', () => {
  it('matches PROOF_EXPIRED and INVALID_BASE_BLOCK_NUMBER (base-block stale)', () => {
    expect(isProofExpiredError(new Error('submitAndTrack: 0xabc REVERTED: PROOF_EXPIRED'))).toBe(true);
    expect(
      isProofExpiredError(new Error('submitAndTrack: 0xabc REVERTED: INVALID_BASE_BLOCK_NUMBER')),
    ).toBe(true);
  });

  it('does NOT match a stale-nonce / register-collision / generic revert (distinct failure)', () => {
    expect(isProofExpiredError(new Error('submitAndTrack: 0xabc REVERTED: NON_ZERO_VALUE'))).toBe(false);
    expect(isProofExpiredError(new Error('stale proof nonce'))).toBe(false);
    expect(isProofExpiredError(new Error('insufficient balance'))).toBe(false);
    expect(isProofExpiredError(undefined)).toBe(false);
  });
});

describe('isNodeLagError — full-node lag on the proof base block', () => {
  // The exact AVNU code-156 blob from the field (bridgeBack claim submit).
  const SAMPLE =
    'AVNU paymaster paymaster_executeTransaction error (code 156): An error occurred ' +
    '(TRANSACTION_EXECUTION_ERROR): execution error execution starknet error ValidationFailure: ' +
    '"Invalid proof facts: Block hash mismatch for block 11830268. Proof block hash: ' +
    '2599008338855316138244232038147531977139677293890288556207521894200097029093, ' +
    'stored block hash: 0."';

  it('matches the field code-156 ValidationFailure with a ZERO stored hash (retryable lag)', () => {
    expect(isNodeLagError(new Error(SAMPLE))).toBe(true);
    expect(isNodeLagError(SAMPLE)).toBe(true);
  });

  it('matches the 0x0 / zero-padded stored-hash variants', () => {
    expect(
      isNodeLagError('Block hash mismatch for block 5. Proof block hash: 0xabc, stored block hash: 0x0'),
    ).toBe(true);
    expect(
      isNodeLagError('Block hash mismatch for block 5. stored block hash: 0x000000000000'),
    ).toBe(true);
  });

  it('does NOT match a NON-zero stored hash (genuine reorg/anchor mismatch, not fixable by waiting)', () => {
    expect(
      isNodeLagError(
        'Block hash mismatch for block 5. Proof block hash: 0xabc, stored block hash: 0x5ab12',
      ),
    ).toBe(false);
  });

  it('does NOT match a genuine proof-verification failure or unrelated errors', () => {
    expect(isNodeLagError(new Error('proof verification failed'))).toBe(false);
    expect(isNodeLagError(new Error('invalid proof'))).toBe(false);
    expect(isNodeLagError(new Error('submitAndTrack: 0xabc REVERTED: PROOF_EXPIRED'))).toBe(false);
    expect(isNodeLagError(new Error('pre-confirmed data unavailable: gateway error'))).toBe(false);
    expect(isNodeLagError(undefined)).toBe(false);
  });
});

describe('waitForProvingBlock — clamp', () => {
  it('(#7) clamps to >= 0 on a young chain (latest < DEPTH)', async () => {
    // Head at 3, DEPTH 8 → latest - DEPTH = -5; must clamp to 0.
    getBlockNumber.mockResolvedValue(3);

    // lastTx undefined so we don't enter the wait loop (3 - 8 = -5, and an
    // undefined lastTx skips the wait regardless).
    const proveAt = await waitForProvingBlock(provider, undefined);

    expect(proveAt).toBe(0);
  });
});
