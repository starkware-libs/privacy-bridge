// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// The burn scanner exists so a "no burn found" answer can be trusted. Every test here
// defends one of the two ways that trust breaks: a window the provider silently shrank,
// and a log the scanner silently dropped. Both would turn a stuck burn into `settled`.

import { describe, expect, it, vi } from 'vitest';

import { InvalidRequestRpcError, InternalRpcError, RpcRequestError, type PublicClient } from 'viem';

import { initTestConfig } from '../../vitest.setup';
import { config, getEvmCctpSource } from './config';
import { LogRangeCapError, scanDepositForBurnLogs } from './chunkedLogScan';

const WALLET_A = '0x00000000000000000000000000000000000000a1' as const;
const WALLET_B = '0x00000000000000000000000000000000000000b2' as const;

type GetLogsArgs = {
  address: `0x${string}`;
  args?: { depositor?: `0x${string}` | `0x${string}`[] };
  fromBlock: bigint;
  toBlock: bigint;
};

// One DepositForBurn as viem hands it back: decoded `args` plus the log's own position.
function fakeLog(
  block: bigint,
  overrides: Partial<{
    depositor: `0x${string}`;
    amount: bigint;
    destinationDomain: number;
    hookData: `0x${string}`;
    transactionHash: `0x${string}` | null;
    blockNumber: bigint | null;
    logIndex: number | null;
  }> = {},
) {
  const { depositor, amount, destinationDomain, hookData, ...log } = {
    depositor: WALLET_A,
    amount: 1_000_000n,
    destinationDomain: 25,
    hookData: '0xdead' as `0x${string}`,
    transactionHash: `0x${block.toString(16).padStart(64, '0')}` as `0x${string}`,
    blockNumber: block as bigint | null,
    logIndex: 0 as number | null,
    ...overrides,
  };
  return { ...log, args: { depositor, amount, destinationDomain, hookData } };
}

function fakeClient(logsFor: (p: GetLogsArgs) => unknown[] = () => [], chainId?: number) {
  const getLogs = vi.fn(async (p: GetLogsArgs) => logsFor(p));
  const getChainId = vi.fn(async () => chainId ?? config.polygon.chainId);
  return {
    getLogs,
    getChainId,
    client: { getLogs, getChainId } as unknown as PublicClient,
    ranges: () => getLogs.mock.calls.map((c) => [c[0].fromBlock, c[0].toBlock] as const),
  };
}

// The provider rejection this scanner has to recognize, built the way viem actually
// surfaces one: the provider's own text lives on the inner RpcRequestError's `details`,
// while the outer error's shortMessage is generic. Shape mirrors the 2026-08-11 probe of
// the configured Polygon RPC (free tier, hard 10-block cap, error code -32600).
function rangeCapRejection(
  message = 'Under the Free tier plan you may only query up to a 10 block range. ' +
    'Upgrade to PAYG to unlock larger ranges.',
): unknown {
  const inner = new RpcRequestError({
    body: { method: 'eth_getLogs' },
    error: { code: -32600, message },
    url: 'https://rpc.example.invalid',
  });
  return new InvalidRequestRpcError(inner);
}

function genericRejection(): unknown {
  const inner = new RpcRequestError({
    body: { method: 'eth_getLogs' },
    error: { code: -32603, message: 'internal error: upstream node unavailable' },
    url: 'https://rpc.example.invalid',
  });
  return new InternalRpcError(inner);
}

describe('scanDepositForBurnLogs', () => {
  it('chunks by the CONFIG value, with the first chunk starting at fromBlock', async () => {
    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: '10' });
    const chain = fakeClient();

    await scanDepositForBurnLogs(chain.client, {
      depositors: [WALLET_A],
      fromBlock: 100n,
      toBlock: 129n,
    });

    expect(chain.ranges()).toEqual([
      [100n, 109n],
      [110n, 119n],
      [120n, 129n],
    ]);
  });

  it('keeps every chunk within the cap as an INCLUSIVE span', async () => {
    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: '10' });
    const chain = fakeClient();

    await scanDepositForBurnLogs(chain.client, {
      depositors: [WALLET_A],
      fromBlock: 1n,
      toBlock: 42n,
    });

    for (const [from, to] of chain.ranges()) expect(to - from + 1n).toBeLessThanOrEqual(10n);
  });

  it('defaults the chunk size to 10_000 blocks', async () => {
    const chain = fakeClient();

    await scanDepositForBurnLogs(chain.client, {
      depositors: [WALLET_A],
      fromBlock: 1n,
      toBlock: 25_000n,
    });

    expect(config.polygonGetLogsChunkBlocks).toBe(10_000);
    expect(chain.ranges()).toEqual([
      [1n, 10_000n],
      [10_001n, 20_000n],
      [20_001n, 25_000n],
    ]);
  });

  it('honors an explicit chunkBlocks over the config', async () => {
    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: '10000' });
    const chain = fakeClient();

    await scanDepositForBurnLogs(chain.client, {
      depositors: [WALLET_A],
      fromBlock: 0n,
      toBlock: 4n,
      chunkBlocks: 2n,
    });

    expect(chain.ranges()).toEqual([
      [0n, 1n],
      [2n, 3n],
      [4n, 4n],
    ]);
  });

  it('scans a single-block window — deploy+burn in one tx must be findable', async () => {
    const chain = fakeClient((p) => (p.fromBlock === 500n ? [fakeLog(500n)] : []));

    const logs = await scanDepositForBurnLogs(chain.client, {
      depositors: [WALLET_A],
      fromBlock: 500n,
      toBlock: 500n,
    });

    expect(chain.ranges()).toEqual([[500n, 500n]]);
    expect(logs).toHaveLength(1);
    expect(logs[0].blockNumber).toBe(500n);
  });

  it('filters on the configured TokenMessenger and ALL depositors in one request', async () => {
    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: '10' });
    const chain = fakeClient();

    await scanDepositForBurnLogs(chain.client, {
      depositors: [WALLET_A, WALLET_B],
      fromBlock: 1n,
      toBlock: 5n,
    });

    const messenger = getEvmCctpSource(config.polygon.chainId)?.tokenMessenger;
    expect(chain.getLogs).toHaveBeenCalledTimes(1);
    expect(chain.getLogs.mock.calls[0][0].address).toBe(messenger);
    expect(chain.getLogs.mock.calls[0][0].args?.depositor).toEqual([WALLET_A, WALLET_B]);
  });

  it('returns matches oldest-first across chunks', async () => {
    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: '10' });
    const chain = fakeClient((p) =>
      p.fromBlock === 0n ? [fakeLog(3n)] : p.fromBlock === 10n ? [fakeLog(11n), fakeLog(12n)] : [],
    );

    const logs = await scanDepositForBurnLogs(chain.client, {
      depositors: [WALLET_A],
      fromBlock: 0n,
      toBlock: 19n,
    });

    expect(logs.map((l) => l.blockNumber)).toEqual([3n, 11n, 12n]);
  });

  it('projects the fields a count and a rebuild need', async () => {
    const chain = fakeClient(() => [
      fakeLog(7n, { amount: 42n, hookData: '0xc0ffee', logIndex: 3 }),
    ]);

    const [log] = await scanDepositForBurnLogs(chain.client, {
      depositors: [WALLET_A],
      fromBlock: 0n,
      toBlock: 7n,
    });

    expect(log).toEqual({
      depositor: WALLET_A,
      amount: 42n,
      destinationDomain: 25,
      hookData: '0xc0ffee',
      transactionHash: `0x${7n.toString(16).padStart(64, '0')}`,
      blockNumber: 7n,
      logIndex: 3,
    });
  });

  it('rejects with LogRangeCapError when the provider refuses the range', async () => {
    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: '10' });
    const chain = fakeClient();
    chain.getLogs.mockRejectedValueOnce(rangeCapRejection());

    const err = await scanDepositForBurnLogs(chain.client, {
      depositors: [WALLET_A],
      fromBlock: 0n,
      toBlock: 100n,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LogRangeCapError);
  });

  // A cap rejection is recognized by its TEXT, so a provider that words the same refusal
  // differently must not slip past as a generic failure. One signal is enough.
  it.each([
    ['request wording', 'You may only query up to a 10 block request.'],
    ['upsell wording', 'Free tier limit reached. Upgrade to PAYG to unlock larger ranges.'],
    ['result-limit wording', 'query returned more than 10000 results'],
    ['response-size wording', 'Log response size exceeded. Please use a smaller block range.'],
  ])('recognizes the %s of a range refusal', async (_label, message) => {
    const chain = fakeClient();
    chain.getLogs.mockRejectedValueOnce(rangeCapRejection(message));

    await expect(
      scanDepositForBurnLogs(chain.client, {
        depositors: [WALLET_A],
        fromBlock: 0n,
        toBlock: 5n,
      }),
    ).rejects.toBeInstanceOf(LogRangeCapError);
  });

  it('returns NO partial result when a later chunk is range-rejected', async () => {
    initTestConfig({ POLYGON_GET_LOGS_CHUNK_BLOCKS: '10' });
    const chain = fakeClient(() => [fakeLog(3n)]);
    chain.getLogs
      .mockImplementationOnce(async () => [fakeLog(3n)])
      .mockRejectedValueOnce(rangeCapRejection());

    await expect(
      scanDepositForBurnLogs(chain.client, {
        depositors: [WALLET_A],
        fromBlock: 0n,
        toBlock: 100n,
      }),
    ).rejects.toBeInstanceOf(LogRangeCapError);
  });

  it('leaves a GENERIC rpc failure unwrapped — it is not a range cap', async () => {
    const generic = genericRejection();
    const chain = fakeClient();
    chain.getLogs.mockRejectedValueOnce(generic);

    const err = await scanDepositForBurnLogs(chain.client, {
      depositors: [WALLET_A],
      fromBlock: 0n,
      toBlock: 5n,
    }).catch((e: unknown) => e);

    expect(err).toBe(generic);
    expect(err).not.toBeInstanceOf(LogRangeCapError);
  });

  it('rejects rather than dropping a log with no transaction hash', async () => {
    const chain = fakeClient(() => [fakeLog(3n, { transactionHash: null })]);

    await expect(
      scanDepositForBurnLogs(chain.client, {
        depositors: [WALLET_A],
        fromBlock: 0n,
        toBlock: 5n,
      }),
    ).rejects.toThrow(/incomplete/i);
  });

  it('rejects rather than dropping a log with no block number', async () => {
    const chain = fakeClient(() => [fakeLog(3n, { blockNumber: null })]);

    await expect(
      scanDepositForBurnLogs(chain.client, {
        depositors: [WALLET_A],
        fromBlock: 0n,
        toBlock: 5n,
      }),
    ).rejects.toThrow(/incomplete/i);
  });

  it('rejects rather than dropping a log whose depositor did not decode', async () => {
    const chain = fakeClient(() => [fakeLog(3n, { depositor: undefined as never })]);

    await expect(
      scanDepositForBurnLogs(chain.client, {
        depositors: [WALLET_A],
        fromBlock: 0n,
        toBlock: 5n,
      }),
    ).rejects.toThrow(/incomplete/i);
  });

  it('rejects an inverted window instead of reporting an empty one', async () => {
    const chain = fakeClient();

    await expect(
      scanDepositForBurnLogs(chain.client, {
        depositors: [WALLET_A],
        fromBlock: 10n,
        toBlock: 9n,
      }),
    ).rejects.toThrow(/range/i);
    expect(chain.getLogs).not.toHaveBeenCalled();
  });

  it('rejects a non-positive chunk size instead of looping forever', async () => {
    const chain = fakeClient();

    await expect(
      scanDepositForBurnLogs(chain.client, {
        depositors: [WALLET_A],
        fromBlock: 0n,
        toBlock: 5n,
        chunkBlocks: 0n,
      }),
    ).rejects.toThrow(/chunk/i);
  });

  it('reads nothing at all when there are no depositors to scan for', async () => {
    const chain = fakeClient();

    await expect(
      scanDepositForBurnLogs(chain.client, { depositors: [], fromBlock: 0n, toBlock: 5n }),
    ).resolves.toEqual([]);
    expect(chain.getLogs).not.toHaveBeenCalled();
  });

  it('rejects when no CCTP source is configured for the chain being scanned', async () => {
    const chain = fakeClient();

    await expect(
      scanDepositForBurnLogs(chain.client, {
        depositors: [WALLET_A],
        fromBlock: 0n,
        toBlock: 5n,
        evmChainId: 999_999,
      }),
    ).rejects.toThrow(/999999/);
  });

  it('refuses a client connected to a DIFFERENT chain, before reading a single log', async () => {
    // The worst failure this scanner can produce: a filter resolved for one chain, queried on
    // another, answers with a complete empty log set — which recovery consumes as proven
    // absence and turns a stuck burn into `settled`. A precondition in a comment cannot catch
    // it; the client has to be asked.
    const chain = fakeClient(() => [fakeLog(101n)], 1);

    await expect(
      scanDepositForBurnLogs(chain.client, {
        depositors: [WALLET_A],
        fromBlock: 100n,
        toBlock: 109n,
      }),
    ).rejects.toThrow(new RegExp(`${config.polygon.chainId}`));
    expect(chain.getLogs).not.toHaveBeenCalled();
  });

  it('propagates a getChainId failure instead of scanning on an unverified client', async () => {
    const chain = fakeClient(() => [fakeLog(101n)]);
    chain.getChainId.mockRejectedValue(new Error('rpc down'));

    await expect(
      scanDepositForBurnLogs(chain.client, {
        depositors: [WALLET_A],
        fromBlock: 100n,
        toBlock: 109n,
      }),
    ).rejects.toThrow(/rpc down/);
    expect(chain.getLogs).not.toHaveBeenCalled();
  });
});
