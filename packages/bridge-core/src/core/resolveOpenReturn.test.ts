// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// resolveOpenReturn classifies ONE WAL entry. Every test here defends the same property:
// a verdict that moves funds (`reburn`) or drops the entry (`claimed`) is only ever reached
// from a completed, matched on-chain read. A failed read must land on `unknown`.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PublicClient } from 'viem';

import { config } from './config';
import { encodeCommitmentHookData } from '../derivation/index';
import { spyOnSecretSinks } from './__testkit__/secretSinks';

// PARTIAL mocks throughout: LogRangeCapError / IrisMessageUnavailableError must stay the real
// classes, or the classifier's `instanceof` split turns green for the wrong reason.
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
import { writeRecoveredInflightReturn } from './returnIn';
import { sumErc20Balances } from './polygonClient';
import {
  resolveOpenReturn,
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
const INBOUND_ANONYMIZER = '0x4';
const MESSAGE = `0x${'11'.repeat(64)}` as const;
const HEAD = 2_000n;
const INTENT_BLOCK = 1_000n;
const DUST = 10_000n;

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

function fakeClient(head: bigint | (() => Promise<bigint>) = HEAD) {
  const getBlockNumber = vi.fn(typeof head === 'bigint' ? async () => head : head);
  return { getBlockNumber, client: { getBlockNumber } as unknown as PublicClient };
}

function resolve(over: Partial<Parameters<typeof resolveOpenReturn>[0]> = {}) {
  return resolveOpenReturn({
    entry: entry(),
    client: fakeClient().client,
    depositWallet: DEPOSIT_WALLET,
    dustFloorWei: DUST,
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mScan.mockResolvedValue([]);
  mBalance.mockResolvedValue(0n);
  mIris.mockResolvedValue({ message: MESSAGE, attestation: '0x00' });
  mNonceUsed.mockResolvedValue(false);
  mWrite.mockReturnValue('written');
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

  it('takes the OLDEST matched log when a commitment carries more than one burn', async () => {
    mScan.mockResolvedValue([
      burnLog({ blockNumber: 1_010n, transactionHash: BURN_TX, amount: 4_000_000n }),
      burnLog({ blockNumber: 1_500n, transactionHash: OTHER_BURN_TX, amount: 9_000_000n }),
    ]);

    expect(await resolve()).toEqual({
      kind: 'burn-found',
      burnTx: BURN_TX,
      amountWei: 4_000_000n,
    });
  });

  it('refuses to attribute a right-depositor burn whose hookData carries a stale commitment', async () => {
    mScan.mockResolvedValue([burnLog({ hookData: STALE_HOOK, transactionHash: OTHER_BURN_TX })]);
    mBalance.mockResolvedValue(5_000_000n);

    const verdict = await resolve();

    expect(verdict.kind).not.toBe('burn-found');
    expect(verdict).toEqual({ kind: 'reburn' });
  });

  it('reburns when no matched burn exists and the balance is above the dust floor', async () => {
    mBalance.mockResolvedValue(DUST + 1n);

    expect(await resolve()).toEqual({ kind: 'reburn' });
  });

  it('answers unknown when no matched burn exists and the balance is at the dust floor', async () => {
    mBalance.mockResolvedValue(DUST);

    expect((await resolve()).kind).toBe('unknown');
  });

  it('answers unknown when no matched burn exists and the balance is below the dust floor', async () => {
    mBalance.mockResolvedValue(0n);

    expect((await resolve()).kind).toBe('unknown');
  });

  it('reads the balance for the entry own chain USDC', async () => {
    mBalance.mockResolvedValue(0n);

    await resolve();

    const [, tokens, address] = mBalance.mock.calls[0]!;
    expect(tokens).toEqual([config.polygon.usdc]);
    expect(address).toBe(DEPOSIT_WALLET);
  });
});

describe('resolveOpenReturn — a failed read is UNKNOWN, never a classification', () => {
  it('answers unknown on a range-capped scan and never consults the balance to override it', async () => {
    mScan.mockRejectedValue(new LogRangeCapError('provider refused the range'));
    mBalance.mockResolvedValue(5_000_000n);

    const verdict = await resolve();

    expect(verdict.kind).toBe('unknown');
    expect(mBalance).not.toHaveBeenCalled();
  });

  it('answers unknown on any other scan failure', async () => {
    mScan.mockRejectedValue(new Error('socket hang up'));

    expect((await resolve()).kind).toBe('unknown');
  });

  it('answers unknown when the head read fails, so no window is ever assumed', async () => {
    const { client } = fakeClient(async () => {
      throw new Error('rpc down');
    });

    expect((await resolve({ client })).kind).toBe('unknown');
    expect(mScan).not.toHaveBeenCalled();
  });

  it('answers unknown when the node head lags the intent block', async () => {
    const { client } = fakeClient(INTENT_BLOCK - 1n);

    expect((await resolve({ client })).kind).toBe('unknown');
    expect(mScan).not.toHaveBeenCalled();
  });

  it('answers unknown when the balance read throws after a clean no-match scan', async () => {
    mBalance.mockRejectedValue(new Error('multicall reverted'));

    expect((await resolve()).kind).toBe('unknown');
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

    expect((await resolve({ scanFirst: false })).kind).toBe('unknown');
  });

  it('reads the balance before the scan and stops there when the balance read throws', async () => {
    mBalance.mockRejectedValue(new Error('multicall reverted'));

    expect((await resolve({ scanFirst: false })).kind).toBe('unknown');
    expect(mScan).not.toHaveBeenCalled();
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

  // The cursor slot key is `${channel ?? ''}:${accountIndex}`, so a dropped channel writes a
  // cursor the claim machinery resolves against the wrong slot.
  it('forwards the entry channel to the cursor writer', async () => {
    await resolve({ entry: entry({ state: 'burned', burnTx: BURN_TX, channel: 'fast' }) });

    expect(mWrite.mock.calls[0]![1].channel).toBe('fast');
  });

  it('leaves channel absent on the record when the entry has none', async () => {
    await resolve({ entry: burned() });

    expect('channel' in mWrite.mock.calls[0]![1]).toBe(false);
  });

  it('answers unknown when Iris has not indexed the burn', async () => {
    mIris.mockRejectedValue(new IrisMessageUnavailableError('not-indexed', 'no message'));

    expect((await resolve({ entry: burned() })).kind).toBe('unknown');
    expect(mWrite).not.toHaveBeenCalled();
  });

  it('answers unknown on a terminal Iris attestation failure — never claimed', async () => {
    mIris.mockRejectedValue(new Error('CCTP attestation failed (Iris status "failed")'));

    expect((await resolve({ entry: burned() })).kind).toBe('unknown');
    expect(mWrite).not.toHaveBeenCalled();
  });

  it('answers unknown when the nonce read throws', async () => {
    mNonceUsed.mockRejectedValue(new Error('starknet rpc 502'));

    expect((await resolve({ entry: burned() })).kind).toBe('unknown');
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

function unknownReason(verdict: OpenReturnVerdict): string {
  if (verdict.kind !== 'unknown') throw new Error(`expected unknown, got ${verdict.kind}`);
  return verdict.reason;
}
