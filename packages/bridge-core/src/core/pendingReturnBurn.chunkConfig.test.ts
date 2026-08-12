// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// The resolver's getLogs ranges must obey POLYGON_GET_LOGS_CHUNK_BLOCKS — at BOTH sites.
//
// The bug these pin: the config field capped only chunkedLogScan, while this resolver sized
// its own ranges from module constants. On a provider with a hard 10-block cap every resolver
// call was rejected, so resolvePendingReturnBurn could only ever answer 'unknown' and the
// double-burn guard never released. One env var has to fix every getLogs path.
//
// Chunking must not buy that by weakening a verdict: a chunk that throws makes the whole
// resolution 'unknown', never a partial answer and never 'never-landed'.

import { describe, expect, it, vi } from 'vitest';

import type { PublicClient } from 'viem';

import { initTestConfig } from '../../vitest.setup';
import { config } from './config';
import { encodeCommitmentHookData } from '../derivation/index';
import {
  PENDING_BURN_DEADLINE_GRACE_MS,
  resolvePendingReturnBurn,
  type PendingReturnBurn,
} from './pendingReturnBurn';

const DEPOSIT_WALLET = '0x000000000000000000000000000000000000bEEf';
const AMOUNT = 1_000_000n;
const COMMITMENT = 424242424242n;
const ANCHOR = 1_000n;
// Window under the anchored record below: [ANCHOR - 600, head] once the deadline span
// (600s + 120s grace over a 250ms floor = 2880 blocks) overshoots the head.
const WINDOW_FROM = 400n;
const HEAD = 1_040n;
// The walk's ceiling, mirrored from pendingReturnBurn.ts (FALLBACK_MAX_CHUNKS).
const MAX_WALK_CHUNKS = 12;

function anchoredRecord(overrides: Partial<PendingReturnBurn> = {}): PendingReturnBurn {
  const submittedAtMs = overrides.submittedAtMs ?? Date.now();
  return {
    accountIndex: 3,
    depositWallet: DEPOSIT_WALLET,
    amount: AMOUNT.toString(),
    commitment: COMMITMENT.toString(),
    sourceDomain: config.polygon.domain,
    evmChainId: config.polygon.chainId,
    inboundAnonymizer: '0x49abc',
    submittedAtMs,
    fromBlock: ANCHOR.toString(),
    deadlineMs: submittedAtMs + 600_000,
    ...overrides,
  };
}

// No anchor, and a submit old enough that the walk cannot reach back past it against block
// timestamps of NOW — the shape where the walk genuinely runs its whole budget.
function anchorlessRecord(overrides: Partial<PendingReturnBurn> = {}): PendingReturnBurn {
  const record = anchoredRecord({ submittedAtMs: Date.now() - 86_400_000, ...overrides });
  delete record.fromBlock;
  return record;
}

// A record whose batch can no longer execute, so a CLEAN no-match scan is entitled to
// answer 'never-landed'. Every "an error keeps it unknown" test uses this shape — against a
// still-mineable record the answer would be 'pending' either way and the test would be vacuous.
function pastDeadline(overrides: Partial<PendingReturnBurn> = {}): Partial<PendingReturnBurn> {
  const submittedAtMs = Date.now() - 10 * 60_000 - PENDING_BURN_DEADLINE_GRACE_MS;
  return { submittedAtMs, deadlineMs: submittedAtMs + 1_000, ...overrides };
}

// A DepositForBurn this record's own commitment matches.
function matchingLog(block: bigint) {
  return {
    transactionHash: `0x${block.toString(16).padStart(64, '0')}` as `0x${string}`,
    args: {
      amount: AMOUNT,
      depositor: DEPOSIT_WALLET,
      destinationDomain: config.cctp.starknetDomain,
      hookData: encodeCommitmentHookData(COMMITMENT),
    },
  };
}

function fakeClient(p: {
  head: bigint;
  logsAt?: bigint[];
  // 1-based index of the getLogs call that rejects — the mid-window failure.
  throwOnCall?: number;
  // Block timestamps the anchorless walk reads. Default: NOW, so the walk can never
  // establish it reached back past the submit.
  blockTimestampMs?: (block: bigint) => number;
}) {
  const getLogs = vi.fn(async (a: { fromBlock: bigint; toBlock: bigint }) => {
    if (p.throwOnCall !== undefined && getLogs.mock.calls.length === p.throwOnCall) {
      throw new Error('provider refused the range');
    }
    return (p.logsAt ?? [])
      .filter((block) => block >= a.fromBlock && block <= a.toBlock)
      .map(matchingLog);
  });
  const getBlockNumber = vi.fn(async () => p.head);
  const getBlock = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({
    timestamp: BigInt(Math.floor((p.blockTimestampMs?.(blockNumber) ?? Date.now()) / 1000)),
  }));
  return {
    getLogs,
    client: { getLogs, getBlockNumber, getBlock } as unknown as PublicClient,
    ranges: () =>
      getLogs.mock.calls.map((c) => [c[0].fromBlock, c[0].toBlock] as [bigint, bigint]),
  };
}

describe('the anchored window obeys the configured getLogs chunk size', () => {
  it('splits the window into chunks no wider than the cap, as an INCLUSIVE span', async () => {
    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: '10' });
    const chain = fakeClient({ head: HEAD });

    await resolvePendingReturnBurn(anchoredRecord(), { client: chain.client });

    expect(chain.ranges().length).toBeGreaterThan(1);
    for (const [from, to] of chain.ranges()) expect(to - from + 1n).toBeLessThanOrEqual(10n);
  });

  it('covers the whole window contiguously — no gap a burn could hide in', async () => {
    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: '10' });
    const chain = fakeClient({ head: HEAD });

    await resolvePendingReturnBurn(anchoredRecord(), { client: chain.client });

    const ranges = chain.ranges();
    expect(ranges[0][0]).toBe(WINDOW_FROM);
    expect(ranges[ranges.length - 1][1]).toBe(HEAD);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBe(ranges[i - 1][1] + 1n);
  });

  it('issues ONE call spanning the whole window under the default config', async () => {
    const chain = fakeClient({ head: HEAD });

    await resolvePendingReturnBurn(anchoredRecord(), { client: chain.client });

    expect(config.polygonGetLogsChunkBlocks).toBe(10_000);
    expect(chain.ranges()).toEqual([[WINDOW_FROM, HEAD]]);
  });

  it('still finds a burn that sits in a LATER chunk', async () => {
    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: '10' });
    const chain = fakeClient({ head: HEAD, logsAt: [1_007n] });

    const resolution = await resolvePendingReturnBurn(anchoredRecord(), { client: chain.client });

    expect(resolution).toEqual({ kind: 'landed', burnTx: matchingLog(1_007n).transactionHash });
  });

  it('promotes the OLDEST match when a wallet burned more than once', async () => {
    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: '10' });
    const chain = fakeClient({ head: HEAD, logsAt: [512n, 1_007n] });

    const resolution = await resolvePendingReturnBurn(anchoredRecord(), { client: chain.client });

    expect(resolution).toEqual({ kind: 'landed', burnTx: matchingLog(512n).transactionHash });
  });

  it('keeps the tip-only scan a single block when the anchor sits above the head', async () => {
    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: '10' });
    const chain = fakeClient({ head: 500n });

    await resolvePendingReturnBurn(anchoredRecord({ fromBlock: '9000' }), {
      client: chain.client,
    });

    expect(chain.ranges()).toEqual([[500n, 500n]]);
  });
});

describe('the anchorless walk obeys the configured getLogs chunk size', () => {
  it('walks back in chunks no wider than the cap, as an INCLUSIVE span', async () => {
    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: '10' });
    const chain = fakeClient({ head: 50_000_000n });

    await resolvePendingReturnBurn(anchorlessRecord(), { client: chain.client });

    expect(chain.ranges().length).toBeGreaterThan(1);
    for (const [from, to] of chain.ranges()) expect(to - from + 1n).toBeLessThanOrEqual(10n);
  });

  it('keeps the default walk at 10_000-block chunks, descending from the head', async () => {
    const chain = fakeClient({ head: 50_000_000n });

    await resolvePendingReturnBurn(anchorlessRecord(), { client: chain.client });

    expect(chain.ranges().slice(0, 2)).toEqual([
      [49_990_001n, 50_000_000n],
      [49_980_001n, 49_990_000n],
    ]);
    for (const [from, to] of chain.ranges()) expect(to - from + 1n).toBeLessThanOrEqual(10_000n);
  });

  it('still stops at the chunk budget rather than scanning forever', async () => {
    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: '10' });
    const chain = fakeClient({ head: 50_000_000n });

    const resolution = await resolvePendingReturnBurn(anchorlessRecord(pastDeadline()), {
      client: chain.client,
    });

    expect(chain.ranges().length).toBeLessThanOrEqual(MAX_WALK_CHUNKS);
    // Reach is now the cap times the budget, so a shrunk cap reaches less far — and reports
    // that honestly as 'unknown' rather than releasing the guard on an unproven absence.
    expect(resolution.kind).toBe('unknown');
  });
});

describe("a chunk that throws makes the whole resolution 'unknown'", () => {
  it('answers never-landed when EVERY chunk of a past-deadline window came back clean', async () => {
    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: '10' });
    const chain = fakeClient({ head: HEAD });

    const resolution = await resolvePendingReturnBurn(anchoredRecord(pastDeadline()), {
      client: chain.client,
    });

    expect(resolution).toEqual({ kind: 'never-landed' });
  });

  it('never answers never-landed when a MID-WINDOW chunk failed', async () => {
    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: '10' });
    const chain = fakeClient({ head: HEAD, throwOnCall: 3 });

    const resolution = await resolvePendingReturnBurn(anchoredRecord(pastDeadline()), {
      client: chain.client,
    });

    expect(resolution.kind).toBe('unknown');
  });

  it('never answers never-landed when the LAST chunk of the window failed', async () => {
    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: '10' });
    const probe = fakeClient({ head: HEAD });
    await resolvePendingReturnBurn(anchoredRecord(), { client: probe.client });
    const chunkCount = probe.ranges().length;

    const chain = fakeClient({ head: HEAD, throwOnCall: chunkCount });
    const resolution = await resolvePendingReturnBurn(anchoredRecord(pastDeadline()), {
      client: chain.client,
    });

    expect(resolution.kind).toBe('unknown');
  });

  it('never answers never-landed when a chunk of the anchorless walk failed', async () => {
    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: '10' });
    // Block timestamps PREDATE the submit, so a clean walk would establish absence on its
    // first chunk — the failure is the only thing standing between this and 'never-landed'.
    const chain = fakeClient({
      head: 50_000_000n,
      throwOnCall: 1,
      blockTimestampMs: () => 0,
    });

    const resolution = await resolvePendingReturnBurn(anchorlessRecord(pastDeadline()), {
      client: chain.client,
    });

    expect(resolution.kind).toBe('unknown');
  });
});
