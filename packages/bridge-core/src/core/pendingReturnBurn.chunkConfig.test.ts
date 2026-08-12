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
// resolution 'unknown', never a partial answer and never 'never-landed'. And the cap must not
// silently shrink the anchorless walk's REACH — a narrow cap buys more calls, not less history.

import { describe, expect, it, vi } from 'vitest';

import { InvalidRequestRpcError, RpcRequestError, type PublicClient } from 'viem';

import { initTestConfig } from '../../vitest.setup';
import { config } from './config';
import { encodeCommitmentHookData } from '../derivation/index';
import {
  FALLBACK_MAX_CHUNKS,
  PENDING_BURN_DEADLINE_GRACE_MS,
  resolvePendingReturnBurn,
  type PendingReturnBurn,
} from './pendingReturnBurn';

const DEPOSIT_WALLET = '0x000000000000000000000000000000000000bEEf';
const AMOUNT = 1_000_000n;
const COMMITMENT = 424242424242n;

// Anchored geometry, derived exactly as searchExactWindow derives it: lower = anchor - 600
// margin; upper = anchor + ceil((600s deadline + 120s grace) / 250ms) + 600 margin = 4480,
// which overshoots this head and clamps to it. 641 blocks, so chunk counts below are exact.
const ANCHOR = 1_000n;
const WINDOW_FROM = 400n;
const HEAD = 1_040n;
const WINDOW_BLOCKS = 641n;

// Walk geometry: a chain deep enough that the walk cannot hit genesis, and the lowest block
// WALK_REACH_BLOCKS (120_000) of reach bottoms out at — head - 120_000 + 1.
const DEEP_HEAD = 50_000_000n;
const WALK_REACH_FLOOR = 49_880_001n;

function chunkCount(blocks: bigint, cap: bigint): number {
  return Number((blocks + cap - 1n) / cap);
}

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
// timestamps of NOW — the shape where the walk genuinely spends its whole budget.
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

// How the configured Polygon RPC actually refuses an over-wide range (free tier, hard 10-block
// cap, code -32600): the provider's text sits on the inner RpcRequestError's `details` while
// the outer error stays generic. The resolver classifies nothing — any throw is 'unknown' — so
// this shape only proves a real rejection cannot be mistaken for an empty log set.
function rangeCapRejection(cap: bigint): unknown {
  const inner = new RpcRequestError({
    body: { method: 'eth_getLogs' },
    error: {
      code: -32600,
      message: `Under the Free tier plan you may only query up to a ${cap} block range.`,
    },
    url: 'https://rpc.example.invalid',
  });
  return new InvalidRequestRpcError(inner);
}

function fakeClient(p: {
  head: bigint;
  logsAt?: bigint[];
  // 1-based index of the getLogs call that rejects — the mid-window failure.
  throwOnCall?: number;
  // The provider's own hard range cap. Any wider request is REJECTED, as a real capped
  // provider does — so a passing test proves the resolver never asked for too much.
  providerCap?: bigint;
  // Block timestamps the anchorless walk reads. Default: NOW, so the walk can never
  // establish it reached back past the submit.
  blockTimestampMs?: (block: bigint) => number;
}) {
  const getLogs = vi.fn(async (a: { fromBlock: bigint; toBlock: bigint }) => {
    if (p.providerCap !== undefined && a.toBlock - a.fromBlock + 1n > p.providerCap) {
      throw rangeCapRejection(p.providerCap);
    }
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

// Block timestamps that PREDATE the submit from `boundary` downward, so the walk establishes
// it reached back past the submit a few chunks in instead of spending its whole budget.
function stopsBelow(boundary: bigint) {
  return (block: bigint) => (block <= boundary ? 0 : Date.now());
}

describe('the anchored window obeys the configured getLogs chunk size', () => {
  it('splits the window into exactly ceil(window / cap) chunks, each within the cap', async () => {
    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: '10' });
    const chain = fakeClient({ head: HEAD });

    await resolvePendingReturnBurn(anchoredRecord(), { client: chain.client });

    expect(chain.ranges().length).toBe(chunkCount(WINDOW_BLOCKS, 10n));
    expect(chain.ranges().length).toBe(65);
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
    const chain = fakeClient({
      head: DEEP_HEAD,
      blockTimestampMs: stopsBelow(DEEP_HEAD - 50n),
    });

    await resolvePendingReturnBurn(anchorlessRecord(), { client: chain.client });

    // Chunks of 10 descending from the head, stopping at the first whose lowest block
    // predates the submit: [head-9, head] … [head-59, head-50].
    expect(chain.ranges().length).toBe(6);
    for (const [from, to] of chain.ranges()) expect(to - from + 1n).toBeLessThanOrEqual(10n);
  });

  it('keeps the default walk at 10_000-block chunks, descending from the head', async () => {
    const chain = fakeClient({ head: DEEP_HEAD });

    await resolvePendingReturnBurn(anchorlessRecord(), { client: chain.client });

    expect(chain.ranges().slice(0, 2)).toEqual([
      [49_990_001n, 50_000_000n],
      [49_980_001n, 49_990_000n],
    ]);
    for (const [from, to] of chain.ranges()) expect(to - from + 1n).toBeLessThanOrEqual(10_000n);
  });
});

// A narrow cap is a property of the RPC PLAN. If it also shrank how far back the walk can
// look, an operator fixing their range-cap failures would silently trade away recovery
// history — at a 10-block cap, 12 chunks reach 120 blocks, ~4 minutes of Polygon.
describe('the anchorless walk reaches the same distance whatever the cap', () => {
  it('bottoms out at the same block at the default cap and at a 10-block cap', async () => {
    const wide = fakeClient({ head: DEEP_HEAD });
    await resolvePendingReturnBurn(anchorlessRecord(), { client: wide.client });

    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: '10' });
    const narrow = fakeClient({ head: DEEP_HEAD });
    await resolvePendingReturnBurn(anchorlessRecord(), { client: narrow.client });

    const lowest = (ranges: [bigint, bigint][]) => ranges[ranges.length - 1][0];
    expect(lowest(wide.ranges())).toBe(WALK_REACH_FLOOR);
    expect(lowest(narrow.ranges())).toBe(WALK_REACH_FLOOR);
  });

  it('spends the floor budget at the default cap and buys more calls at a narrow one', async () => {
    const wide = fakeClient({ head: DEEP_HEAD });
    await resolvePendingReturnBurn(anchorlessRecord(), { client: wide.client });
    expect(wide.ranges().length).toBe(FALLBACK_MAX_CHUNKS);

    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: '10' });
    const narrow = fakeClient({ head: DEEP_HEAD });
    await resolvePendingReturnBurn(anchorlessRecord(), { client: narrow.client });
    expect(narrow.ranges().length).toBe(12_000);
  });

  it('still reports an unreached submit as unknown rather than never-landed', async () => {
    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: '10' });
    const chain = fakeClient({ head: DEEP_HEAD });

    const resolution = await resolvePendingReturnBurn(anchorlessRecord(pastDeadline()), {
      client: chain.client,
    });

    expect(chain.ranges().length).toBe(12_000);
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
    const chain = fakeClient({ head: HEAD, throwOnCall: chunkCount(WINDOW_BLOCKS, 10n) });

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
      head: DEEP_HEAD,
      throwOnCall: 1,
      blockTimestampMs: () => 0,
    });

    const resolution = await resolvePendingReturnBurn(anchorlessRecord(pastDeadline()), {
      client: chain.client,
    });

    expect(resolution.kind).toBe('unknown');
  });
});

// PROBE A — end-to-end against a provider that REJECTS an over-wide range, which is the whole
// point of the config field. The `unknown` case is the pre-PR behavior: red against the parent
// commit, where the resolver's ranges ignored the config entirely.
describe('PROBE A: a provider with a hard range cap', () => {
  it('resolves a past-deadline anchored record when the config MATCHES the cap', async () => {
    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: '10' });
    const chain = fakeClient({ head: HEAD, providerCap: 10n });

    const resolution = await resolvePendingReturnBurn(anchoredRecord(pastDeadline()), {
      client: chain.client,
    });

    expect(resolution).toEqual({ kind: 'never-landed' });
    expect(chain.ranges().length).toBe(chunkCount(WINDOW_BLOCKS, 10n));
  });

  it('is stuck at unknown when the config is left ABOVE the cap', async () => {
    const chain = fakeClient({ head: HEAD, providerCap: 10n });

    const resolution = await resolvePendingReturnBurn(anchoredRecord(pastDeadline()), {
      client: chain.client,
    });

    expect(config.polygonGetLogsChunkBlocks).toBe(10_000);
    expect(resolution.kind).toBe('unknown');
  });

  it('resolves a past-deadline anchorless record when the config matches the cap', async () => {
    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: '10' });
    const chain = fakeClient({
      head: DEEP_HEAD,
      providerCap: 10n,
      blockTimestampMs: stopsBelow(DEEP_HEAD - 50n),
    });

    const resolution = await resolvePendingReturnBurn(anchorlessRecord(pastDeadline()), {
      client: chain.client,
    });

    expect(resolution).toEqual({ kind: 'never-landed' });
  });

  it('is stuck at unknown on the anchorless walk when the config is above the cap', async () => {
    const chain = fakeClient({
      head: DEEP_HEAD,
      providerCap: 10n,
      blockTimestampMs: stopsBelow(DEEP_HEAD - 50n),
    });

    const resolution = await resolvePendingReturnBurn(anchorlessRecord(pastDeadline()), {
      client: chain.client,
    });

    expect(resolution.kind).toBe('unknown');
  });
});

// PROBE B — the tiling invariant at every cap, not just the two the other tests use. A gap
// would hide a burn; an overlap would double-report one; a range above the cap would be
// rejected. Sweeping caps is what catches an off-by-one that happens to cancel at one value.
describe('PROBE B: chunks tile their range exactly, at every cap', () => {
  const CAPS = [1n, 2n, 3n, 7n, 10n, 100n, 10_000n];

  it.each(CAPS)('anchored window, cap %s', async (cap) => {
    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: cap.toString() });
    const chain = fakeClient({ head: HEAD, providerCap: cap });

    const resolution = await resolvePendingReturnBurn(anchoredRecord(pastDeadline()), {
      client: chain.client,
    });

    const ranges = chain.ranges();
    expect(resolution).toEqual({ kind: 'never-landed' });
    expect(ranges.length).toBe(chunkCount(WINDOW_BLOCKS, cap));
    expect(ranges[0][0]).toBe(WINDOW_FROM);
    expect(ranges[ranges.length - 1][1]).toBe(HEAD);
    for (const [from, to] of ranges) {
      expect(to).toBeGreaterThanOrEqual(from);
      expect(to - from + 1n).toBeLessThanOrEqual(cap);
    }
    // Ascending, contiguous, no overlap: each chunk resumes exactly one block past the last.
    for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBe(ranges[i - 1][1] + 1n);
  });

  it.each(CAPS)('anchorless walk, cap %s', async (cap) => {
    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: cap.toString() });
    const boundary = DEEP_HEAD - 50n;
    const chain = fakeClient({
      head: DEEP_HEAD,
      providerCap: cap,
      blockTimestampMs: stopsBelow(boundary),
    });

    const resolution = await resolvePendingReturnBurn(anchorlessRecord(pastDeadline()), {
      client: chain.client,
    });

    const ranges = chain.ranges();
    expect(resolution).toEqual({ kind: 'never-landed' });
    expect(ranges[0][1]).toBe(DEEP_HEAD);
    // The walk stops at the first chunk reaching at or below the boundary, and not before.
    expect(ranges[ranges.length - 1][0]).toBeLessThanOrEqual(boundary);
    if (ranges.length > 1) expect(ranges[ranges.length - 2][0]).toBeGreaterThan(boundary);
    for (const [from, to] of ranges) {
      expect(to).toBeGreaterThanOrEqual(from);
      expect(to - from + 1n).toBeLessThanOrEqual(cap);
    }
    // Descending, contiguous, no overlap: each chunk ends exactly one block below the last.
    for (let i = 1; i < ranges.length; i++) expect(ranges[i][1]).toBe(ranges[i - 1][0] - 1n);
  });
});
