// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// resolveOpenReturn classifies ONE WAL entry. Every test here defends the same property:
// a verdict that moves funds (`reburn`) or drops the entry (`claimed`) is only ever reached
// from a completed, matched, COMMITTED on-chain read. A failed, ambiguous, or merely
// pre-confirmed read must land on `unknown`.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PublicClient } from 'viem';

import { config } from './config';
import { initTestConfig } from '../../vitest.setup';
import { encodeCommitmentHookData } from '../derivation/index';
import { spyOnSecretSinks } from './__testkit__/secretSinks';

// PARTIAL mocks throughout: LogRangeCapError / IrisMessageUnavailableError must stay the real
// classes, or the classifier's `instanceof` splits turn green for the wrong reason.
vi.mock('./chunkedLogScan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chunkedLogScan')>();
  return { ...actual, scanDepositForBurnLogs: vi.fn() };
});
vi.mock('./polygonMint', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./polygonMint')>();
  return { ...actual, fetchCctpMessageByTxHash: vi.fn() };
});
vi.mock('./depositIn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./depositIn')>();
  return { ...actual, isCctpMessageNonceUsed: vi.fn() };
});
vi.mock('./returnIn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./returnIn')>();
  return { ...actual, writeRecoveredInflightReturn: vi.fn() };
});
vi.mock('./polygonClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./polygonClient')>();
  return { ...actual, sumErc20Balances: vi.fn() };
});

import { LogRangeCapError, scanDepositForBurnLogs, type DepositForBurnLog } from './chunkedLogScan';
import { fetchCctpMessageByTxHash, IrisMessageUnavailableError } from './polygonMint';
import { isCctpMessageNonceUsed } from './depositIn';
import { writeRecoveredInflightReturn, DEFAULT_BATCH_DEADLINE_MS } from './returnIn';
import {
  PENDING_BURN_DEADLINE_GRACE_MS,
  DEADLINE_WINDOW_BLOCKS,
  blocksForSpanMs,
} from './pendingReturnBurn';
import { sumErc20Balances } from './polygonClient';
import {
  resolveOpenReturn,
  MAX_INTENT_SCAN_REQUESTS,
  type OpenReturnEntry,
  type OpenReturnVerdict,
} from './resolveOpenReturn';

const mScan = vi.mocked(scanDepositForBurnLogs);
const mIris = vi.mocked(fetchCctpMessageByTxHash);
const mNonceUsed = vi.mocked(isCctpMessageNonceUsed);
const mWrite = vi.mocked(writeRecoveredInflightReturn);
const mBalance = vi.mocked(sumErc20Balances);

const DEPOSIT_WALLET = '0x00000000000000000000000000000000000000a1' as const;
const COMMITMENT = '987654321';
const OTHER_COMMITMENT = '111222333';
const OUR_HOOK = encodeCommitmentHookData(BigInt(COMMITMENT));
const STALE_HOOK = encodeCommitmentHookData(BigInt(OTHER_COMMITMENT));
const BURN_TX = `0x${'ab'.repeat(32)}` as const;
const OTHER_BURN_TX = `0x${'cd'.repeat(32)}` as const;
const THIRD_BURN_TX = `0x${'ef'.repeat(32)}` as const;
const INBOUND_ANONYMIZER = '0x4';
const MESSAGE = `0x${'11'.repeat(64)}` as const;
const HEAD = 2_000n;
const INTENT_BLOCK = 1_000n;
const DUST = 10_000n;
const NOW_MS = 1_770_000_000_000;
// The window a just-written intent is allowed to have an unmined burn in. Reused from the
// pending-record deadline, not a second timeout of its own.
const QUIET_MS = DEFAULT_BATCH_DEADLINE_MS + PENDING_BURN_DEADLINE_GRACE_MS;

function entry(over: Partial<OpenReturnEntry> = {}): OpenReturnEntry {
  return {
    state: 'intent',
    accountIndex: 3,
    commitment: COMMITMENT,
    intentBlock: INTENT_BLOCK,
    sourceDomain: config.polygon.domain,
    evmChainId: config.polygon.chainId,
    inboundAnonymizer: INBOUND_ANONYMIZER,
    amountWei: 5_000_000n,
    ...over,
  };
}

function burnLog(over: Partial<DepositForBurnLog> = {}): DepositForBurnLog {
  return {
    depositor: DEPOSIT_WALLET,
    amount: 5_000_000n,
    destinationDomain: config.cctp.starknetDomain,
    hookData: OUR_HOOK,
    transactionHash: BURN_TX,
    blockNumber: 1_010n,
    logIndex: 0,
    ...over,
  };
}

function fakeClient(
  over: {
    head?: bigint | (() => Promise<bigint>);
    receipt?: () => Promise<{ status: 'success' | 'reverted' }>;
    chainId?: number;
  } = {},
) {
  const { head = HEAD } = over;
  const getBlockNumber = vi.fn(typeof head === 'function' ? head : async () => head);
  const getChainId = vi.fn(async () => over.chainId ?? config.polygon.chainId);
  const getTransactionReceipt = vi.fn(
    over.receipt ??
      (async () => {
        throw new Error('transaction not found');
      }),
  );
  return {
    getBlockNumber,
    getChainId,
    getTransactionReceipt,
    client: { getBlockNumber, getChainId, getTransactionReceipt } as unknown as PublicClient,
  };
}

function resolve(over: Partial<Parameters<typeof resolveOpenReturn>[0]> = {}) {
  return resolveOpenReturn({
    entry: entry(),
    client: fakeClient().client,
    depositWallet: DEPOSIT_WALLET,
    dustFloorWei: DUST,
    nowMs: NOW_MS,
    ...over,
  });
}

// L5: a reason is part of the contract, not a debug string — assert the exact literal so a
// mutation that swaps two of them goes red.
function unknownReason(verdict: OpenReturnVerdict): string {
  if (verdict.kind !== 'unknown') throw new Error(`expected unknown, got ${verdict.kind}`);
  return verdict.reason;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Every suite except the budget one asserts CLASSIFICATION, so each declares the regime it
  // means instead of inheriting a cost default that can move underneath it: a chunk wide enough
  // to span the deadline window in ONE request. The shipped default is deliberately far below
  // that (10 blocks, the free-tier-safe floor) — the budget suite runs there and pins what it
  // costs.
  initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: '10000' });
  mScan.mockResolvedValue([]);
  mBalance.mockResolvedValue(0n);
  mIris.mockResolvedValue({ message: MESSAGE, attestation: '0x00' });
  mNonceUsed.mockResolvedValue(false);
  mWrite.mockReturnValue('written');
});

// The intent scan is capped at the block span in which a burn for this intent could still
// execute. The relayer's batch deadline is contract-enforced, so execution past it is
// impossible — the same property that licenses concluding "never landed" at all.
describe('resolveOpenReturn — the intent scan window is deadline-capped', () => {
  const CAP_END = INTENT_BLOCK + DEADLINE_WINDOW_BLOCKS;
  // Unlike the suite's simple mock, this one HONORS the requested range — otherwise "a burn
  // beyond the cap is unreachable" would be asserted by a mock that returns it at any range.
  function stageRangeAware(logs: DepositForBurnLog[]) {
    mScan.mockImplementation(async (_client, p) =>
      logs.filter((log) => log.blockNumber >= p.fromBlock && log.blockNumber <= p.toBlock),
    );
  }

  it('never sizes the block window below the time window the freshness gate licenses', () => {
    expect(DEADLINE_WINDOW_BLOCKS).toBeGreaterThanOrEqual(
      blocksForSpanMs(DEFAULT_BATCH_DEADLINE_MS + PENDING_BURN_DEADLINE_GRACE_MS),
    );
  });

  // The relation above is scale-INVARIANT: it still holds if both sides shrink together, so it
  // cannot defend the window's magnitude. These two literals can. Without them, narrowing the
  // window to the rejected deadline+grace candidate (2880 blocks), or relaxing the block-time
  // floor from 250ms to a Polygon-realistic 2000ms, both stay green.
  it('holds the window at the 8400-block magnitude the design settled on', () => {
    expect(DEADLINE_WINDOW_BLOCKS).toBeGreaterThanOrEqual(8400n);
  });

  it('still counts a 30-minute span at a sub-second block time', () => {
    expect(blocksForSpanMs(30 * 60_000)).toBeGreaterThanOrEqual(7200n);
  });

  it('caps toBlock at the deadline window while pinning the balance to the live head', async () => {
    const farHead = CAP_END + 500_000n;
    const { client } = fakeClient({ head: farHead });
    stageRangeAware([]);
    mBalance.mockResolvedValue(DUST + 1n);

    expect(await resolve({ client })).toEqual({ kind: 'reburn' });
    // The two heights DIVERGE on purpose: the scan asks how far a burn could have landed, the
    // balance asks what is on the wallet NOW. Sound because no burn can exist past the cap.
    expect(mScan.mock.calls[0]![1].toBlock).toBe(CAP_END);
    expect(mBalance.mock.calls[0]![3]).toEqual({ blockNumber: farHead });
  });

  it('scans to the head when the head sits inside the deadline window', async () => {
    const nearHead = CAP_END - 1n;
    const { client } = fakeClient({ head: nearHead });
    stageRangeAware([]);
    mBalance.mockResolvedValue(DUST + 1n);

    await resolve({ client });

    expect(mScan.mock.calls[0]![1].toBlock).toBe(nearHead);
    expect(mBalance.mock.calls[0]![3]).toEqual({ blockNumber: nearHead });
  });

  it('still finds a burn that landed inside the capped window', async () => {
    const { client } = fakeClient({ head: CAP_END + 500_000n });
    stageRangeAware([burnLog({ blockNumber: CAP_END - 1n })]);
    mBalance.mockResolvedValue(5_000_000n);

    expect(await resolve({ client })).toEqual({
      kind: 'burn-found',
      burnTx: BURN_TX,
      amountWei: 5_000_000n,
    });
  });

  it('finds a burn inside the window even while the intent is still young', async () => {
    const { client } = fakeClient({ head: CAP_END + 500_000n });
    stageRangeAware([burnLog({ blockNumber: INTENT_BLOCK + 1n })]);

    expect((await resolve({ client, entry: entry({ intentAtMs: NOW_MS }) })).kind).toBe(
      'burn-found',
    );
  });

  it('cannot see a burn beyond the cap, and reburns on the evidence it does have', async () => {
    const { client } = fakeClient({ head: CAP_END + 500_000n });
    stageRangeAware([burnLog({ blockNumber: CAP_END + 1n })]);
    mBalance.mockResolvedValue(DUST + 1n);

    // Unreachable BY CONSTRUCTION: the range-aware mock would have returned it had the scan
    // asked. Past the contract-enforced deadline such a burn cannot exist, which is what makes
    // the reburn sound rather than merely uninformed.
    expect(await resolve({ client })).toEqual({ kind: 'reburn' });
  });

  it('leaves the lagging-head guard untouched', async () => {
    const { client } = fakeClient({ head: INTENT_BLOCK - 1n });

    expect(unknownReason(await resolve({ client }))).toBe('head-behind-intent-block');
    expect(mScan).not.toHaveBeenCalled();
  });
});

// The window is bounded in BLOCKS, but its cost in eth_getLogs REQUESTS is the window divided
// by the operator's chunk size — unbounded from this module's point of view. So the request
// count is capped too, and the cap fails CLOSED: an exhausted budget can never answer "no burn
// happened", because that answer is what licenses a second burn.
describe('resolveOpenReturn — the scan spends a bounded request budget', () => {
  const CAP_END = INTENT_BLOCK + DEADLINE_WINDOW_BLOCKS;
  const FAR_HEAD = CAP_END + 500_000n;

  // Chunk small enough that the window needs far more than the budget: 8401 inclusive blocks
  // at 10 per request is 841 requests against a budget of 10. Stated explicitly rather than
  // left to the default, even though 10 IS the default today.
  function withStarvedChunk() {
    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: '10' });
  }

  // One request per call, honoring the requested slice — mirrors what the real scanner does
  // when its range is exactly one chunk wide.
  function stageSliceAware(logs: DepositForBurnLog[]) {
    mScan.mockImplementation(async (_client, p) =>
      logs.filter((log) => log.blockNumber >= p.fromBlock && log.blockNumber <= p.toBlock),
    );
  }

  it('stops at the budget and refuses to reburn from partial coverage', async () => {
    withStarvedChunk();
    stageSliceAware([]);
    const { client } = fakeClient({ head: FAR_HEAD });
    // The would-be reburn: funds present, intent long past the freshness deadline. Under FULL
    // coverage this is `reburn`; under partial coverage it must not be.
    mBalance.mockResolvedValue(5_000_000n);

    const verdict = await resolve({ client, entry: entry({ intentAtMs: NOW_MS - QUIET_MS - 1 }) });

    expect(verdict.kind).not.toBe('reburn');
    expect(unknownReason(verdict)).toBe('burn-scan-budget-exhausted');
    expect(mScan).toHaveBeenCalledTimes(MAX_INTENT_SCAN_REQUESTS);
    expect(MAX_INTENT_SCAN_REQUESTS).toBe(10);
  });

  it('walks contiguous chunk-wide slices from the intent block', async () => {
    withStarvedChunk();
    stageSliceAware([]);
    const { client } = fakeClient({ head: FAR_HEAD });

    await resolve({ client });

    const ranges = mScan.mock.calls.map(([, p]) => [p.fromBlock, p.toBlock] as const);
    expect(ranges[0]).toEqual([INTENT_BLOCK, INTENT_BLOCK + 9n]);
    expect(ranges[1]).toEqual([INTENT_BLOCK + 10n, INTENT_BLOCK + 19n]);
    expect(ranges.at(-1)).toEqual([INTENT_BLOCK + 90n, INTENT_BLOCK + 99n]);
  });

  it('stops as soon as a matched burn appears, well inside the budget', async () => {
    withStarvedChunk();
    // Third slice: [intentBlock+20, intentBlock+29].
    stageSliceAware([burnLog({ blockNumber: INTENT_BLOCK + 25n })]);
    const { client } = fakeClient({ head: FAR_HEAD });

    expect(await resolve({ client })).toEqual({
      kind: 'burn-found',
      burnTx: BURN_TX,
      amountWei: 5_000_000n,
    });
    // Positive evidence is still positive under partial coverage — and it costs 3, not 10.
    expect(mScan).toHaveBeenCalledTimes(3);
  });

  it('spends one request when the chunk size covers the window within budget', async () => {
    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: '10000' });
    mScan.mockResolvedValue([]);
    mBalance.mockResolvedValue(DUST + 1n);
    const { client } = fakeClient({ head: FAR_HEAD });

    // Full coverage ⇒ every verdict is exactly what it was before the budget existed.
    expect(await resolve({ client })).toEqual({ kind: 'reburn' });
    expect(mScan).toHaveBeenCalledTimes(1);
  });

  it('treats a chunk that covers the window in exactly the budget as full coverage', async () => {
    // 8401 inclusive blocks / 10 requests ⇒ 841 blocks per request is the threshold.
    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: '841' });
    mScan.mockResolvedValue([]);
    mBalance.mockResolvedValue(DUST + 1n);
    const { client } = fakeClient({ head: FAR_HEAD });

    expect(await resolve({ client })).toEqual({ kind: 'reburn' });
    expect(mScan).toHaveBeenCalledTimes(1);
  });

  it('degrades one block below that threshold', async () => {
    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: '840' });
    stageSliceAware([]);
    mBalance.mockResolvedValue(5_000_000n);
    const { client } = fakeClient({ head: FAR_HEAD });

    expect(unknownReason(await resolve({ client }))).toBe('burn-scan-budget-exhausted');
  });

  // The shipped default is the free-tier-safe floor, well under the coverage threshold. So out
  // of the box the intent path can only ever see chunk × budget = 100 blocks and otherwise
  // withholds judgement. That is the intended fail-safe, not a regression — but it is the
  // difference between "resume works" and "resume says it cannot tell yet", so it is pinned
  // here: this test goes red if either the default or the budget moves.
  it('is budget-starved under the shipped default chunk size', async () => {
    initTestConfig();
    stageSliceAware([]);
    mBalance.mockResolvedValue(5_000_000n);
    const { client } = fakeClient({ head: FAR_HEAD });

    expect(config.polygonGetLogsChunkBlocks).toBe(10);
    const verdict = await resolve({ client, entry: entry({ intentAtMs: NOW_MS - QUIET_MS - 1 }) });
    expect(unknownReason(verdict)).toBe('burn-scan-budget-exhausted');
  });

  it('leaves a scan failure reported as a scan failure, not as budget exhaustion', async () => {
    withStarvedChunk();
    mScan.mockRejectedValue(new LogRangeCapError('provider refused the range'));
    const { client } = fakeClient({ head: FAR_HEAD });

    expect(unknownReason(await resolve({ client }))).toBe('burn-scan-range-capped');
  });
});

describe('resolveOpenReturn — intent entries scan first', () => {
  it('classifies a hookData-matched burn as burn-found without consulting the balance', async () => {
    mScan.mockResolvedValue([burnLog()]);
    mBalance.mockResolvedValue(5_000_000n); // far above dust — must not produce `reburn`

    const verdict = await resolve();

    expect(verdict).toEqual({ kind: 'burn-found', burnTx: BURN_TX, amountWei: 5_000_000n });
    expect(mBalance).not.toHaveBeenCalled();
  });

  it('scans [intentBlock, head] for the entry own chain and lets config size the chunks', async () => {
    await resolve();

    expect(mScan).toHaveBeenCalledTimes(1);
    const [, params] = mScan.mock.calls[0]!;
    expect(params.depositors).toEqual([DEPOSIT_WALLET]);
    expect(params.fromBlock).toBe(INTENT_BLOCK);
    expect(params.toBlock).toBe(HEAD);
    expect(params.evmChainId).toBe(config.polygon.chainId);
    expect(params.chunkBlocks).toBeUndefined();
  });

  // L6
  it('still scans the single-block window when the head equals the intent block', async () => {
    mBalance.mockResolvedValue(DUST + 1n);
    const { client } = fakeClient({ head: INTENT_BLOCK });

    expect(await resolve({ client })).toEqual({ kind: 'reburn' });
    const [, params] = mScan.mock.calls[0]!;
    expect(params.fromBlock).toBe(INTENT_BLOCK);
    expect(params.toBlock).toBe(INTENT_BLOCK);
  });

  // L1: provider log order is not guaranteed, so the pick must not depend on it.
  it('finds the matched burn regardless of the order the provider returned logs in', async () => {
    mScan.mockResolvedValue([
      burnLog({ blockNumber: 1_500n, hookData: STALE_HOOK, transactionHash: OTHER_BURN_TX }),
      burnLog({ blockNumber: 1_010n, hookData: OUR_HOOK, transactionHash: BURN_TX }),
    ]);

    expect(await resolve()).toEqual({ kind: 'burn-found', burnTx: BURN_TX, amountWei: 5_000_000n });
  });

  // L2: two burns carrying the SAME commitment is a state this module cannot explain.
  it('refuses to pick between two hookData-matched burns', async () => {
    mScan.mockResolvedValue([
      burnLog({ blockNumber: 1_010n, transactionHash: BURN_TX }),
      burnLog({ blockNumber: 1_500n, transactionHash: THIRD_BURN_TX }),
    ]);
    mBalance.mockResolvedValue(5_000_000n);

    expect(unknownReason(await resolve())).toBe('multiple-matched-burns');
  });

  it('refuses to pick between two matched burns whatever order they arrive in', async () => {
    mScan.mockResolvedValue([
      burnLog({ blockNumber: 1_500n, transactionHash: THIRD_BURN_TX }),
      burnLog({ blockNumber: 1_010n, transactionHash: BURN_TX }),
    ]);

    expect(unknownReason(await resolve())).toBe('multiple-matched-burns');
  });

  it('refuses to attribute a right-depositor burn whose hookData carries a stale commitment', async () => {
    mScan.mockResolvedValue([burnLog({ hookData: STALE_HOOK, transactionHash: OTHER_BURN_TX })]);
    mBalance.mockResolvedValue(5_000_000n);

    const verdict = await resolve();

    expect(verdict.kind).toBe('reburn');
    // L3: the orphan is reported, not swallowed — it is the only handle on a burn nothing owns.
    expect(verdict).toEqual({ kind: 'reburn', orphanBurnTxs: [OTHER_BURN_TX] });
  });

  it('omits the orphan list when every scanned log matched or none existed', async () => {
    mBalance.mockResolvedValue(DUST + 1n);

    expect(await resolve()).toEqual({ kind: 'reburn' });
  });

  it('reburns when no matched burn exists and the balance is above the dust floor', async () => {
    mBalance.mockResolvedValue(DUST + 1n);

    expect(await resolve()).toEqual({ kind: 'reburn' });
  });

  it('answers unknown when no matched burn exists and the balance is at the dust floor', async () => {
    mBalance.mockResolvedValue(DUST);

    expect(unknownReason(await resolve())).toBe('no-burn-and-balance-at-dust');
  });

  it('answers unknown when no matched burn exists and the balance is below the dust floor', async () => {
    mBalance.mockResolvedValue(0n);

    expect(unknownReason(await resolve())).toBe('no-burn-and-balance-at-dust');
  });

  // H2a: the scan and the balance must describe ONE height, or a burn mined between the two
  // reads is invisible to the scan and already gone from the balance.
  it('pins the balance read to the same block the scan ended at', async () => {
    mBalance.mockResolvedValue(0n);

    await resolve();

    const [, tokens, address, opts] = mBalance.mock.calls[0]!;
    expect(tokens).toEqual([config.polygon.usdc]);
    expect(address).toBe(DEPOSIT_WALLET);
    expect(opts).toEqual({ blockNumber: HEAD });
  });
});

// H2b: a full-balance burn that has not been mined yet looks exactly like a burn that was
// never submitted. Only the age of the intent separates them.
describe('resolveOpenReturn — a young intent is not evidence of a missing burn', () => {
  it('withholds reburn while the burn could still be executing', async () => {
    mBalance.mockResolvedValue(5_000_000n);

    const verdict = await resolve({ entry: entry({ intentAtMs: NOW_MS - 1_000 }) });

    expect(verdict.kind).not.toBe('reburn');
    expect(unknownReason(verdict)).toBe('intent-too-young');
  });

  it('withholds reburn on the last millisecond of the quiet window', async () => {
    mBalance.mockResolvedValue(5_000_000n);

    expect(unknownReason(await resolve({ entry: entry({ intentAtMs: NOW_MS - QUIET_MS }) }))).toBe(
      'intent-too-young',
    );
  });

  it('reburns once the quiet window has elapsed', async () => {
    mBalance.mockResolvedValue(5_000_000n);

    expect(await resolve({ entry: entry({ intentAtMs: NOW_MS - QUIET_MS - 1 }) })).toEqual({
      kind: 'reburn',
    });
  });

  it('treats a missing intentAtMs as past the deadline, like returnIn treats a missing stamp', async () => {
    mBalance.mockResolvedValue(5_000_000n);

    expect(await resolve({ entry: entry() })).toEqual({ kind: 'reburn' });
  });

  it('treats a future intentAtMs as conservatively live', async () => {
    mBalance.mockResolvedValue(5_000_000n);

    expect(unknownReason(await resolve({ entry: entry({ intentAtMs: NOW_MS + 60_000 }) }))).toBe(
      'intent-too-young',
    );
  });

  it('never lets youth suppress a matched burn', async () => {
    mScan.mockResolvedValue([burnLog()]);

    expect((await resolve({ entry: entry({ intentAtMs: NOW_MS }) })).kind).toBe('burn-found');
  });
});

describe('resolveOpenReturn — a failed read is UNKNOWN, never a classification', () => {
  it('answers unknown on a range-capped scan and never consults the balance to override it', async () => {
    mScan.mockRejectedValue(new LogRangeCapError('provider refused the range'));
    mBalance.mockResolvedValue(5_000_000n);

    expect(unknownReason(await resolve())).toBe('burn-scan-range-capped');
    expect(mBalance).not.toHaveBeenCalled();
  });

  it('answers unknown on any other scan failure', async () => {
    mScan.mockRejectedValue(new Error('socket hang up'));

    expect(unknownReason(await resolve())).toBe('burn-scan-failed');
  });

  it('answers unknown when the head read fails, so no window is ever assumed', async () => {
    const { client } = fakeClient({
      head: async () => {
        throw new Error('rpc down');
      },
    });

    expect(unknownReason(await resolve({ client }))).toBe('head-read-failed');
    expect(mScan).not.toHaveBeenCalled();
  });

  it('answers unknown when the node head lags the intent block', async () => {
    const { client } = fakeClient({ head: INTENT_BLOCK - 1n });

    expect(unknownReason(await resolve({ client }))).toBe('head-behind-intent-block');
    expect(mScan).not.toHaveBeenCalled();
  });

  it('answers unknown when the balance read throws after a clean no-match scan', async () => {
    mBalance.mockRejectedValue(new Error('multicall reverted'));

    expect(unknownReason(await resolve())).toBe('balance-read-failed');
  });

  // L4: one stale entry pointing at a retired chain must not abort a whole resume pass.
  it('answers unknown for an entry on a chain this build has no CCTP source for', async () => {
    expect(unknownReason(await resolve({ entry: entry({ evmChainId: 999_999 }) }))).toBe(
      'unsupported-chain',
    );
  });

  it('never leaks an RPC endpoint or key into the unknown reason', async () => {
    const leaky = new Error(
      'HTTP request failed. URL: https://polygon-amoy.rpc.example.invalid/v2/SECRETKEY',
    );
    const reasons: string[] = [];

    mScan.mockRejectedValue(leaky);
    reasons.push(unknownReason(await resolve()));
    mScan.mockResolvedValue([]);
    mBalance.mockRejectedValue(leaky);
    reasons.push(unknownReason(await resolve()));
    mIris.mockRejectedValue(leaky);
    reasons.push(
      unknownReason(await resolve({ entry: entry({ state: 'burned', burnTx: BURN_TX }) })),
    );

    for (const reason of reasons) {
      expect(reason).toMatch(/^[a-z0-9-]+$/);
      expect(reason).not.toContain('SECRETKEY');
      expect(reason.toLowerCase()).not.toContain('http');
    }
  });
});

describe('resolveOpenReturn — scanFirst:false still requires a clean scan to reburn', () => {
  it('cannot reburn while the scan answers unknown, even with a fat balance', async () => {
    mBalance.mockResolvedValue(5_000_000n);
    mScan.mockRejectedValue(new LogRangeCapError('provider refused the range'));

    expect(unknownReason(await resolve({ scanFirst: false }))).toBe('burn-scan-range-capped');
  });

  it('reads the balance before the scan and stops there when the balance read throws', async () => {
    mBalance.mockRejectedValue(new Error('multicall reverted'));

    expect(unknownReason(await resolve({ scanFirst: false }))).toBe('balance-read-failed');
    expect(mScan).not.toHaveBeenCalled();
  });

  it('pins the eager balance read to the scan height too', async () => {
    mBalance.mockResolvedValue(0n);

    await resolve({ scanFirst: false });

    expect(mBalance.mock.calls[0]![3]).toEqual({ blockNumber: HEAD });
  });

  it('still prefers a matched burn over an above-dust balance', async () => {
    mBalance.mockResolvedValue(5_000_000n);
    mScan.mockResolvedValue([burnLog()]);

    expect(await resolve({ scanFirst: false })).toEqual({
      kind: 'burn-found',
      burnTx: BURN_TX,
      amountWei: 5_000_000n,
    });
  });
});

describe('resolveOpenReturn — burned entries', () => {
  const burned = () => entry({ state: 'burned', burnTx: BURN_TX });

  it('classifies a consumed CCTP nonce as claimed and writes no cursor', async () => {
    mNonceUsed.mockResolvedValue(true);

    expect(await resolve({ entry: burned() })).toEqual({ kind: 'claimed' });
    expect(mWrite).not.toHaveBeenCalled();
    expect(mScan).not.toHaveBeenCalled();
  });

  // H1: `claimed` makes the app DELETE the entry — the only handle on the funds. A
  // pre-confirmed claim that never commits would delete it against a claim that never
  // happened, so the delete decision must read COMMITTED state.
  it('reads the nonce at latest, not the default pre-confirmed view', async () => {
    mNonceUsed.mockResolvedValue(true);

    await resolve({ entry: burned() });

    expect(mNonceUsed).toHaveBeenCalledWith(MESSAGE, { blockIdentifier: 'latest' });
  });

  it('never claims on a nonce that is consumed only at pre-confirmed', async () => {
    mNonceUsed.mockImplementation(async (_message, opts) => opts?.blockIdentifier !== 'latest');

    const verdict = await resolve({ entry: burned() });

    expect(verdict.kind).not.toBe('claimed');
    expect(verdict).toEqual({ kind: 'continue-claim', write: 'written' });
  });

  it.each(['written', 'tracked', 'occupied'] as const)(
    'surfaces the %s cursor-write outcome on an unused nonce',
    async (outcome) => {
      mWrite.mockReturnValue(outcome);

      expect(await resolve({ entry: burned() })).toEqual({
        kind: 'continue-claim',
        write: outcome,
      });
    },
  );

  it('pins the rebuilt cursor to the entry own inbound anonymizer and amount', async () => {
    await resolve({ entry: burned() });

    const [wallet, record] = mWrite.mock.calls[0]!;
    expect(wallet).toBe(DEPOSIT_WALLET);
    expect(record).toMatchObject({
      accountIndex: 3,
      burnTx: BURN_TX,
      sourceDomain: config.polygon.domain,
      amountWei: 5_000_000n,
      commitment: COMMITMENT,
      evmChainId: config.polygon.chainId,
      inboundAnonymizer: INBOUND_ANONYMIZER,
    });
  });

  // The cursor slot key is `${channel ?? ''}:${accountIndex}`, so a dropped or invented
  // channel resolves the rebuilt cursor against the wrong slot.
  it('forwards the entry channel to the cursor writer', async () => {
    await resolve({ entry: entry({ state: 'burned', burnTx: BURN_TX, channel: 'fast' }) });

    expect(mWrite.mock.calls[0]![1].channel).toBe('fast');
  });

  it('leaves channel absent on the record when the entry has none', async () => {
    await resolve({ entry: burned() });

    expect('channel' in mWrite.mock.calls[0]![1]).toBe(false);
  });

  it('answers unknown when the nonce read throws', async () => {
    mNonceUsed.mockRejectedValue(new Error('starknet rpc 502'));

    expect(unknownReason(await resolve({ entry: burned() }))).toBe('nonce-read-failed');
    expect(mWrite).not.toHaveBeenCalled();
  });

  it('throws on a burned entry with no burnTx — a schema violation is never a verdict', async () => {
    await expect(resolve({ entry: entry({ state: 'burned' }) })).rejects.toThrow(/burnTx/);
    expect(mIris).not.toHaveBeenCalled();
  });

  it('throws on a burned entry whose burnTx is not a hash', async () => {
    await expect(
      resolve({ entry: entry({ state: 'burned', burnTx: 'not-hex' as `0x${string}` }) }),
    ).rejects.toThrow(/burnTx/);
  });
});

// M1: the four ways Iris can fail to hand over our message say different things, and W4
// renders them differently. Collapsing them loses the distinction.
describe('resolveOpenReturn — Iris failures stay distinguishable', () => {
  const burned = () => entry({ state: 'burned', burnTx: BURN_TX });

  it.each([
    ['not-indexed', 'iris-not-indexed'],
    ['unmatched', 'iris-unmatched'],
    ['incomplete', 'iris-incomplete'],
  ] as const)('maps the %s bucket to %s', async (reason, expected) => {
    mIris.mockRejectedValue(new IrisMessageUnavailableError(reason, 'no usable message'));

    expect(unknownReason(await resolve({ entry: burned() }))).toBe(expected);
    expect(mWrite).not.toHaveBeenCalled();
  });

  it('answers unknown iris-terminal on a rejected attestation — never claimed', async () => {
    mIris.mockRejectedValue(new Error('CCTP attestation failed (Iris status "failed")'));

    expect(unknownReason(await resolve({ entry: burned() }))).toBe('iris-terminal');
    expect(mWrite).not.toHaveBeenCalled();
  });
});

// M1 (second half): a MINED, reverted burn tx proves THAT tx will never attest, which is what
// turns an otherwise endless retry into an answer. It does NOT prove the funds are still on the
// deposit wallet — a second device's burn reverts on insufficient balance precisely because the
// first device's burn took them — so the caller demotes the entry to `intent` and re-resolves
// rather than deleting it.
describe('resolveOpenReturn — a reverted burn tx is terminal for that tx', () => {
  const burned = () => entry({ state: 'burned', burnTx: BURN_TX });

  beforeEach(() => {
    mIris.mockRejectedValue(new IrisMessageUnavailableError('not-indexed', 'no message'));
  });

  it('reports burn-reverted when the burn tx has a mined failure receipt', async () => {
    const { client } = fakeClient({ receipt: async () => ({ status: 'reverted' }) });

    expect(await resolve({ entry: burned(), client })).toEqual({
      kind: 'burn-reverted',
      burnTx: BURN_TX,
    });
    expect(mWrite).not.toHaveBeenCalled();
  });

  it('stays unknown when the receipt shows the burn succeeded and Iris is merely behind', async () => {
    const { client } = fakeClient({ receipt: async () => ({ status: 'success' }) });

    expect(unknownReason(await resolve({ entry: burned(), client }))).toBe('iris-not-indexed');
  });

  it('stays unknown when no node holds the burn tx', async () => {
    const { client } = fakeClient();

    expect(unknownReason(await resolve({ entry: burned(), client }))).toBe('iris-not-indexed');
  });

  it('refuses to read a reverted receipt off a client on the wrong chain', async () => {
    const { client, getTransactionReceipt } = fakeClient({
      chainId: 1,
      receipt: async () => ({ status: 'reverted' }),
    });

    expect(unknownReason(await resolve({ entry: burned(), client }))).toBe('iris-not-indexed');
    expect(getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('does not spend a receipt read when Iris already holds our message', async () => {
    mIris.mockResolvedValue({ message: MESSAGE, attestation: '0x00' });
    const { client, getTransactionReceipt } = fakeClient();

    await resolve({ entry: burned(), client });

    expect(getTransactionReceipt).not.toHaveBeenCalled();
  });

  // The narrowing is the point: `incomplete` means Iris HAS our message and is still working on
  // it, so the burn plainly succeeded and a receipt could only ever say `success`. Widening the
  // condition would spend an RPC on every in-progress attestation.
  it('does not spend a receipt read on the incomplete bucket, where Iris holds the message', async () => {
    mIris.mockRejectedValue(new IrisMessageUnavailableError('incomplete', 'still attesting'));
    const { client, getTransactionReceipt } = fakeClient({
      receipt: async () => ({ status: 'reverted' }),
    });

    // Even a reverted receipt must not be consulted, let alone reach the verdict.
    expect(unknownReason(await resolve({ entry: burned(), client }))).toBe('iris-incomplete');
    expect(getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('does not spend a receipt read when Iris rejected the attestation', async () => {
    mIris.mockRejectedValue(new Error('CCTP attestation failed (Iris status "failed")'));
    const { client, getTransactionReceipt } = fakeClient({
      receipt: async () => ({ status: 'reverted' }),
    });

    expect(unknownReason(await resolve({ entry: burned(), client }))).toBe('iris-terminal');
    expect(getTransactionReceipt).not.toHaveBeenCalled();
  });
});

describe('resolveOpenReturn — hookData is the required discriminator', () => {
  it('passes expectedHookData derived from the entry commitment to Iris', async () => {
    await resolve({ entry: entry({ state: 'burned', burnTx: BURN_TX }) });

    const [txHash, opts] = mIris.mock.calls[0]!;
    expect(txHash).toBe(BURN_TX);
    expect(opts.sourceDomain).toBe(config.polygon.domain);
    expect(opts.match.expectedSourceDomain).toBe(config.polygon.domain);
    expect(opts.match.expectedHookData).toBe(OUR_HOOK);
    expect(opts.match.expectedHookData).toBe(encodeCommitmentHookData(BigInt(COMMITMENT)));
  });

  // M2: a commitment that encodes to the zero hookData would match nothing on chain, so a
  // real burn would read as absent and the entry would reburn.
  it.each(['', '0', '0x0', 'not-a-number', '12x'])(
    'throws rather than classifying an entry whose commitment is %s',
    async (commitment) => {
      await expect(resolve({ entry: entry({ commitment }) })).rejects.toThrow(/commitment/);
      expect(mScan).not.toHaveBeenCalled();
    },
  );

  it('accepts a canonical non-zero decimal commitment', async () => {
    mBalance.mockResolvedValue(DUST + 1n);

    expect(await resolve({ entry: entry({ commitment: '1' }) })).toEqual({ kind: 'reburn' });
  });
});

describe('resolveOpenReturn — the cursor write is lock-scoped', () => {
  it('runs the write inside the supplied lock', async () => {
    const order: string[] = [];
    const withCursorWriteLock = async <T>(fn: () => Promise<T>) => {
      order.push('lock-in');
      const out = await fn();
      order.push('lock-out');
      return out;
    };
    mWrite.mockImplementation(() => {
      order.push('write');
      return 'written';
    });

    await resolve({ entry: entry({ state: 'burned', burnTx: BURN_TX }), withCursorWriteLock });

    expect(order).toEqual(['lock-in', 'write', 'lock-out']);
  });

  it('rejects when the lock throws, and never writes outside it', async () => {
    const withCursorWriteLock = async () => {
      throw new Error('lock unavailable');
    };

    await expect(
      resolve({ entry: entry({ state: 'burned', burnTx: BURN_TX }), withCursorWriteLock }),
    ).rejects.toThrow(/lock unavailable/);
    expect(mWrite).not.toHaveBeenCalled();
  });
});

describe('resolveOpenReturn — reachability and sinks', () => {
  it('is exported from the public api barrel, or the app cannot reach it', async () => {
    const api = await import('../api');

    expect(typeof api.resolveOpenReturn).toBe('function');
  });

  it('never writes a provider error to console or storage', async () => {
    const leaky = new Error(
      'HTTP request failed. URL: https://polygon-amoy.rpc.example.invalid/v2/SECRETKEY',
    );
    mScan.mockRejectedValue(leaky);
    const sinks = spyOnSecretSinks();

    try {
      expect((await resolve()).kind).toBe('unknown');
      expect(() => sinks.assertNeverLeaked('SECRETKEY')).not.toThrow();
      expect(() => sinks.assertNeverLeaked('rpc.example.invalid')).not.toThrow();
    } finally {
      sinks.restore();
    }
  });
});
