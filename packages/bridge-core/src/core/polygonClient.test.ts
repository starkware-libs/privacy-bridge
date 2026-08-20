// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { describe, it, expect } from 'vitest';
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  multicall3Abi,
  type PublicClient,
} from 'viem';
import { readUsdcBalance, sumErc20Balances, sumErc20BalancesMany } from './polygonClient';

// A viem client whose transport answers eth_call with a canned uint256 result,
// so we test the balanceOf decode without any network.
function mockClient(returnWei: bigint): PublicClient {
  return createPublicClient({
    transport: custom({
      async request({ method }) {
        if (method === 'eth_call') {
          return encodeAbiParameters([{ type: 'uint256' }], [returnWei]);
        }
        if (method === 'eth_chainId') return '0x13882'; // 80002
        throw new Error(`unexpected method ${method}`);
      },
    }),
  });
}

describe('readUsdcBalance', () => {
  it('decodes the balanceOf uint256 result into a bigint', async () => {
    const client = mockClient(1_500_000n); // 1.5 USDC at 6 dp
    const balance = await readUsdcBalance(client, '0x000000000000000000000000000000000000dEaD');
    expect(balance).toBe(1_500_000n);
  });

  it('returns 0n for an empty EOA', async () => {
    const client = mockClient(0n);
    const balance = await readUsdcBalance(client, '0x000000000000000000000000000000000000dEaD');
    expect(balance).toBe(0n);
  });
});

// A client that returns a DIFFERENT balance per token, keyed by the `to`
// (token contract) address of the eth_call — so we can assert a per-token sum
// across an arbitrary token list (the generic multi-token helper).
let aggregate3CallsSink: string[] | null = null;

function multiTokenClient(byToken: Record<string, bigint>): PublicClient {
  const lowered = Object.fromEntries(
    Object.entries(byToken).map(([addr, wei]) => [addr.toLowerCase(), wei]),
  );
  return createPublicClient({
    transport: custom({
      async request({ method, params }) {
        if (method === 'eth_call') {
          const [call] = params as [{ to?: string; data?: `0x${string}` }];
          const to = (call.to ?? '').toLowerCase();
          // The sum arrives as ONE aggregate3 call to the canonical Multicall3 —
          // decode the inner calls and answer each from the per-token table, exactly
          // as the deployed contract would.
          if (to === '0xca11bde05977b3631167028862be2a173976ca11') {
            aggregate3CallsSink?.push(call.data ?? '0x');
            const { args } = decodeFunctionData({ abi: multicall3Abi, data: call.data! });
            const innerCalls = args![0] as readonly { target: string }[];
            return encodeFunctionResult({
              abi: multicall3Abi,
              functionName: 'aggregate3',
              result: innerCalls.map((inner) => ({
                success: true,
                returnData: encodeAbiParameters(
                  [{ type: 'uint256' }],
                  [lowered[inner.target.toLowerCase()] ?? 0n],
                ),
              })),
            });
          }
          const wei = lowered[to] ?? 0n;
          return encodeAbiParameters([{ type: 'uint256' }], [wei]);
        }
        if (method === 'eth_chainId') return '0x13882'; // 80002
        throw new Error(`unexpected method ${method}`);
      },
    }),
  });
}

// Checksummed placeholder addresses (readContract validates EIP-55 checksum).
const TOKEN_A = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // Polygon USDC.e
const TOKEN_B = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'; // pUSD
const TOKEN_C = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'; // Polygon native USDC

describe('sumErc20Balances', () => {
  it('sums balanceOf across multiple tokens', async () => {
    const client = multiTokenClient({ [TOKEN_A]: 250_000n, [TOKEN_B]: 1_000_000n, [TOKEN_C]: 500_000n });
    const total = await sumErc20Balances(
      client,
      [TOKEN_A, TOKEN_B, TOKEN_C],
      '0x000000000000000000000000000000000000dEaD',
    );
    expect(total).toBe(1_750_000n);
  });

  it('treats a token holding 0 as contributing 0 (not a failure)', async () => {
    const client = multiTokenClient({ [TOKEN_A]: 0n, [TOKEN_B]: 1_000_000n, [TOKEN_C]: 0n });
    const total = await sumErc20Balances(
      client,
      [TOKEN_A, TOKEN_B, TOKEN_C],
      '0x000000000000000000000000000000000000dEaD',
    );
    expect(total).toBe(1_000_000n);
  });

  it('returns 0n for an empty token list', async () => {
    const client = multiTokenClient({});
    const total = await sumErc20Balances(client, [], '0x000000000000000000000000000000000000dEaD');
    expect(total).toBe(0n);
  });

  it('skips falsy/empty token entries without failing the read', async () => {
    const client = multiTokenClient({ [TOKEN_A]: 42n });
    const total = await sumErc20Balances(
      client,
      [TOKEN_A, '', TOKEN_B],
      '0x000000000000000000000000000000000000dEaD',
    );
    expect(total).toBe(42n);
  });
});

describe('sumErc20Balances — atomicity and dedupe', () => {
  it('fetches ALL balances in ONE aggregate3 eth_call — the atomicity boundary', async () => {
    // The summed tokens are stations the SAME funds pass through (in-place
    // conversions). N separate reads can straddle a conversion tx and count one chunk
    // of money once per token; a single aggregate3 is one EVM execution at one state
    // root, and enters any outer batch as ONE entry that can never be split.
    aggregate3CallsSink = [];
    const client = multiTokenClient({ [TOKEN_A]: 1n, [TOKEN_B]: 2n, [TOKEN_C]: 4n });
    const total = await sumErc20Balances(
      client,
      [TOKEN_A, TOKEN_B, TOKEN_C],
      '0x000000000000000000000000000000000000dEaD',
    );
    expect(total).toBe(7n);
    expect(aggregate3CallsSink.length).toBe(1);
    aggregate3CallsSink = null;
  });

  it('does not split an arbitrary 29-token sum into multiple aggregate3 calls', async () => {
    // `sumErc20Balances` is public and accepts arbitrary token lists. Viem's default inner
    // multicall byte cap splits 29 balanceOf calls, which would turn the promised one-state
    // snapshot back into separate latest-block reads.
    const tokens = Array.from(
      { length: 29 },
      (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`,
    );
    const balances = Object.fromEntries(tokens.map((token) => [token, 1n]));
    aggregate3CallsSink = [];

    const total = await sumErc20Balances(
      multiTokenClient(balances),
      tokens,
      '0x000000000000000000000000000000000000dEaD',
    );

    expect(total).toBe(29n);
    expect(aggregate3CallsSink).toHaveLength(1);
    aggregate3CallsSink = null;
  });

  it('works on a client built without a chain (explicit multicall3 address)', async () => {
    // Callers and tests pass minimal clients; the canonical Multicall3 address is
    // byte-identical across Polygon/Amoy, so the read must not require client.chain.
    const client = multiTokenClient({ [TOKEN_B]: 9n });
    expect(
      await sumErc20Balances(client, [TOKEN_B], '0x000000000000000000000000000000000000dEaD'),
    ).toBe(9n);
  });

  it('counts a repeated address ONCE, however it is cased', async () => {
    // Token addresses often come from independent config keys; two keys pointing at
    // one contract must not double that balance — a silent error in the user's favour.
    const client = multiTokenClient({ [TOKEN_B]: 5n });
    const total = await sumErc20Balances(
      client,
      [TOKEN_B, TOKEN_B.toLowerCase(), TOKEN_B],
      '0x000000000000000000000000000000000000dEaD',
    );
    expect(total).toBe(5n);
  });

  it('returns 0n for an all-falsy token list without any network round trip', async () => {
    aggregate3CallsSink = [];
    const client = multiTokenClient({});
    expect(await sumErc20Balances(client, ['', ''], '0x000000000000000000000000000000000000dEaD')).toBe(0n);
    expect(aggregate3CallsSink).toEqual([]);
    aggregate3CallsSink = null;
  });
});


// A client keyed by (token, holder) so a multi-ADDRESS sweep can be asserted: the existing
// multiTokenClient keys by token alone, which cannot tell two addresses apart.
function perHolderClient(
  byTokenAndHolder: Record<string, Record<string, bigint>>,
  callSink?: {
    aggregate3Count: number;
    innerCallCount: number;
    // Entries per aggregate3, in call order — what the size cap actually bounds.
    entriesPerCall?: number[];
    // The block each aggregate3 was answered at ('latest' when unpinned), so a multi-chunk
    // read can be shown to describe ONE height.
    blocksPerCall?: unknown[];
    blockNumberReads?: number;
  },
): PublicClient {
  const table = Object.fromEntries(
    Object.entries(byTokenAndHolder).map(([token, holders]) => [
      token.toLowerCase(),
      Object.fromEntries(Object.entries(holders).map(([h, wei]) => [h.toLowerCase(), wei])),
    ]),
  );
  return createPublicClient({
    transport: custom({
      async request({ method, params }) {
        if (method === 'eth_chainId') return '0x13882';
        if (method === 'eth_blockNumber') {
          if (callSink) callSink.blockNumberReads = (callSink.blockNumberReads ?? 0) + 1;
          return '0x2a';
        }
        if (method !== 'eth_call') throw new Error(`unexpected method ${method}`);
        const [call, blockTag] = params as [{ to?: string; data?: `0x${string}` }, unknown];
        if ((call.to ?? '').toLowerCase() !== '0xca11bde05977b3631167028862be2a173976ca11') {
          throw new Error('expected every read to arrive as an aggregate3');
        }
        const { args } = decodeFunctionData({ abi: multicall3Abi, data: call.data! });
        const innerCalls = args![0] as readonly { target: string; callData: `0x${string}` }[];
        if (callSink) {
          callSink.aggregate3Count += 1;
          callSink.innerCallCount += innerCalls.length;
          callSink.entriesPerCall?.push(innerCalls.length);
          callSink.blocksPerCall?.push(blockTag);
        }
        return encodeFunctionResult({
          abi: multicall3Abi,
          functionName: 'aggregate3',
          result: innerCalls.map((inner) => {
            // balanceOf(address) — the holder is the last 20 bytes of the 32-byte arg.
            const holder = `0x${inner.callData.slice(-40)}`.toLowerCase();
            const wei = table[inner.target.toLowerCase()]?.[holder] ?? 0n;
            return { success: true, returnData: encodeAbiParameters([{ type: 'uint256' }], [wei]) };
          }),
        });
      },
    }),
  });
}

const SWEEP_TOKEN_A = '0x1111111111111111111111111111111111111111';
const SWEEP_TOKEN_B = '0x2222222222222222222222222222222222222222';
const SWEEP_TOKEN_C = '0x3333333333333333333333333333333333333333';
const HOLDER_1 = '0x00000000000000000000000000000000000000a1' as const;
const HOLDER_2 = '0x00000000000000000000000000000000000000a2' as const;
const HOLDER_3 = '0x00000000000000000000000000000000000000a3' as const;

describe('sumErc20BalancesMany', () => {
  it('sums each address across every token, in the order asked', async () => {
    const client = perHolderClient({
      [SWEEP_TOKEN_A]: { [HOLDER_1]: 10n, [HOLDER_2]: 300n },
      [SWEEP_TOKEN_B]: { [HOLDER_1]: 5n, [HOLDER_3]: 7n },
    });
    const sums = await sumErc20BalancesMany(client, [SWEEP_TOKEN_A, SWEEP_TOKEN_B], [
      HOLDER_1,
      HOLDER_2,
      HOLDER_3,
    ]);
    expect(sums).toEqual([15n, 300n, 7n]);
  });

  it('reads the WHOLE set in ONE aggregate3 — the point of the helper', async () => {
    // Per-address sums cost one dedicated eth_call each, because an explicit multicall can
    // never be batched with another (viem excludes aggregate3 calldata from its tick
    // batcher). Six addresses x two tokens must be one call carrying twelve inner reads.
    const sink = { aggregate3Count: 0, innerCallCount: 0 };
    const holders = [HOLDER_1, HOLDER_2, HOLDER_3, HOLDER_1, HOLDER_2, HOLDER_3];
    const client = perHolderClient({ [SWEEP_TOKEN_A]: {}, [SWEEP_TOKEN_B]: {} }, sink);
    await sumErc20BalancesMany(client, [SWEEP_TOKEN_A, SWEEP_TOKEN_B], holders);
    expect(sink.aggregate3Count).toBe(1);
    expect(sink.innerCallCount).toBe(holders.length * 2);
  });

  it('keeps a repeated address as its own entry rather than deduping the shape away', async () => {
    const client = perHolderClient({ [SWEEP_TOKEN_A]: { [HOLDER_1]: 42n } });
    const sums = await sumErc20BalancesMany(client, [SWEEP_TOKEN_A], [HOLDER_1, HOLDER_1]);
    expect(sums).toEqual([42n, 42n]);
  });

  it('counts a token named twice ONCE per address', async () => {
    // The same guard sumErc20Balances has: a config pointing two token keys at one contract
    // must not double every balance. Silent and in the user's favour is the worst shape.
    const client = perHolderClient({ [SWEEP_TOKEN_A]: { [HOLDER_1]: 100n } });
    const sums = await sumErc20BalancesMany(
      client,
      [SWEEP_TOKEN_A, SWEEP_TOKEN_A.toUpperCase().replace('0X', '0x'), SWEEP_TOKEN_A],
      [HOLDER_1],
    );
    expect(sums).toEqual([100n]);
  });

  it('returns a zero per address for an empty token list, sending no request', async () => {
    const sink = { aggregate3Count: 0, innerCallCount: 0 };
    const client = perHolderClient({}, sink);
    expect(await sumErc20BalancesMany(client, [], [HOLDER_1, HOLDER_2])).toEqual([0n, 0n]);
    expect(sink.aggregate3Count).toBe(0);
  });

  it('returns an empty array for no addresses, sending no request', async () => {
    const sink = { aggregate3Count: 0, innerCallCount: 0 };
    const client = perHolderClient({ [SWEEP_TOKEN_A]: {} }, sink);
    expect(await sumErc20BalancesMany(client, [SWEEP_TOKEN_A], [])).toEqual([]);
    // An aggregate3 with no calls is a wasted round trip, not a neutral one.
    expect(sink.aggregate3Count).toBe(0);
  });

  it('drops falsy token entries, matching sumErc20Balances', async () => {
    const client = perHolderClient({ [SWEEP_TOKEN_A]: { [HOLDER_1]: 9n } });
    const sums = await sumErc20BalancesMany(client, ['', SWEEP_TOKEN_A, ''], [HOLDER_1]);
    expect(sums).toEqual([9n]);
  });
});

describe('sumErc20Balances (now delegating to the many-address form)', () => {
  it('still returns the single-address sum unchanged', async () => {
    const client = perHolderClient({
      [SWEEP_TOKEN_A]: { [HOLDER_1]: 10n },
      [SWEEP_TOKEN_B]: { [HOLDER_1]: 5n },
    });
    expect(await sumErc20Balances(client, [SWEEP_TOKEN_A, SWEEP_TOKEN_B], HOLDER_1)).toBe(15n);
  });

  it('still costs exactly one aggregate3', async () => {
    const sink = { aggregate3Count: 0, innerCallCount: 0 };
    const client = perHolderClient({ [SWEEP_TOKEN_A]: {}, [SWEEP_TOKEN_B]: {} }, sink);
    await sumErc20Balances(client, [SWEEP_TOKEN_A, SWEEP_TOKEN_B], HOLDER_1);
    expect(sink.aggregate3Count).toBe(1);
    expect(sink.innerCallCount).toBe(2);
  });

  it('still returns 0n when the token list is empty, with no request', async () => {
    const sink = { aggregate3Count: 0, innerCallCount: 0 };
    const client = perHolderClient({}, sink);
    expect(await sumErc20Balances(client, [], HOLDER_1)).toBe(0n);
    expect(sink.aggregate3Count).toBe(0);
  });
});


describe('sumErc20BalancesMany — size cap', () => {
  const MAX_CALLS = 512; // mirrors MAX_BALANCE_CALLS_PER_AGGREGATE3
  const holder = (index: number) =>
    `0x${(index + 0x1000).toString(16).padStart(40, '0')}` as `0x${string}`;

  function sink() {
    return {
      aggregate3Count: 0,
      innerCallCount: 0,
      entriesPerCall: [] as number[],
      blocksPerCall: [] as unknown[],
      blockNumberReads: 0,
    };
  }

  it('keeps a realistic caller in ONE call, unchanged and unpinned', async () => {
    // A bid-scan wave: ten indices at two addresses each. The cap is a robustness floor, so
    // it must be invisible here — one call, and no extra eth_blockNumber round trip.
    const spy = sink();
    const client = perHolderClient({ [SWEEP_TOKEN_A]: {}, [SWEEP_TOKEN_B]: {} }, spy);
    const addresses = Array.from({ length: 20 }, (_unused, i) => holder(i));
    await sumErc20BalancesMany(client, [SWEEP_TOKEN_A, SWEEP_TOKEN_B], addresses);
    expect(spy.aggregate3Count).toBe(1);
    expect(spy.blockNumberReads).toBe(0);
    expect(spy.blocksPerCall).toEqual(['latest']);
  });

  it('splits a caller past the cap instead of sending one oversized call', async () => {
    // Without a cap this is a single ~900-entry aggregate3 that fails all-or-nothing.
    const spy = sink();
    const client = perHolderClient(
      { [SWEEP_TOKEN_A]: {}, [SWEEP_TOKEN_B]: {}, [SWEEP_TOKEN_C]: {} },
      spy,
    );
    const addresses = Array.from({ length: 300 }, (_unused, i) => holder(i));
    await sumErc20BalancesMany(
      client,
      [SWEEP_TOKEN_A, SWEEP_TOKEN_B, SWEEP_TOKEN_C],
      addresses,
    );
    expect(spy.aggregate3Count).toBeGreaterThan(1);
    for (const entries of spy.entriesPerCall) expect(entries).toBeLessThanOrEqual(MAX_CALLS);
    // Every (address, token) pair still read exactly once.
    expect(spy.innerCallCount).toBe(300 * 3);
  });

  it('never splits a single address across two calls', async () => {
    // The money invariant: the three tokens are stations the same funds pass through, so one
    // address's sum straddling two state roots is the phantom-balance bug all over again.
    const spy = sink();
    const client = perHolderClient(
      { [SWEEP_TOKEN_A]: {}, [SWEEP_TOKEN_B]: {}, [SWEEP_TOKEN_C]: {} },
      spy,
    );
    const addresses = Array.from({ length: 400 }, (_unused, i) => holder(i));
    await sumErc20BalancesMany(client, [SWEEP_TOKEN_A, SWEEP_TOKEN_B, SWEEP_TOKEN_C], addresses);
    // Every chunk is a whole number of addresses.
    for (const entries of spy.entriesPerCall) expect(entries % 3).toBe(0);
  });

  it('pins EVERY chunk to one height, so a split read still describes one state root', async () => {
    const spy = sink();
    const client = perHolderClient(
      { [SWEEP_TOKEN_A]: {}, [SWEEP_TOKEN_B]: {}, [SWEEP_TOKEN_C]: {} },
      spy,
    );
    const addresses = Array.from({ length: 400 }, (_unused, i) => holder(i));
    await sumErc20BalancesMany(client, [SWEEP_TOKEN_A, SWEEP_TOKEN_B, SWEEP_TOKEN_C], addresses);
    expect(spy.aggregate3Count).toBeGreaterThan(1);
    // One eth_blockNumber for the whole read, and every chunk answered at that height —
    // otherwise funds moving BETWEEN addresses mid-read could be counted twice.
    expect(spy.blockNumberReads).toBe(1);
    expect(new Set(spy.blocksPerCall).size).toBe(1);
    expect(spy.blocksPerCall[0]).toBe('0x2a');
  });

  it('respects a caller-supplied blockNumber instead of reading its own', async () => {
    const spy = sink();
    const client = perHolderClient(
      { [SWEEP_TOKEN_A]: {}, [SWEEP_TOKEN_B]: {}, [SWEEP_TOKEN_C]: {} },
      spy,
    );
    const addresses = Array.from({ length: 400 }, (_unused, i) => holder(i));
    await sumErc20BalancesMany(
      client,
      [SWEEP_TOKEN_A, SWEEP_TOKEN_B, SWEEP_TOKEN_C],
      addresses,
      { blockNumber: 0x99n },
    );
    expect(spy.blockNumberReads).toBe(0);
    expect(new Set(spy.blocksPerCall)).toEqual(new Set(['0x99']));
  });

  it('sums correctly ACROSS a chunk boundary', async () => {
    // The slicing is per chunk now, so an off-by-one in the offset maths would misattribute
    // balances to the wrong address — silently, and in nobody's favour.
    const addresses = Array.from({ length: 400 }, (_unused, i) => holder(i));
    const first = addresses[0]!;
    const last = addresses[399]!;
    const middle = addresses[200]!;
    const client = perHolderClient({
      [SWEEP_TOKEN_A]: { [first]: 1n, [middle]: 20n, [last]: 300n },
      [SWEEP_TOKEN_B]: { [first]: 2n, [middle]: 30n, [last]: 400n },
      [SWEEP_TOKEN_C]: { [middle]: 40n },
    });
    const sums = await sumErc20BalancesMany(
      client,
      [SWEEP_TOKEN_A, SWEEP_TOKEN_B, SWEEP_TOKEN_C],
      addresses,
    );
    expect(sums).toHaveLength(400);
    expect(sums[0]).toBe(3n);
    expect(sums[200]).toBe(90n);
    expect(sums[399]).toBe(700n);
    // Everything else is zero — no balance leaked across a boundary.
    expect(sums.filter((sum) => sum !== 0n)).toEqual([3n, 90n, 700n]);
  });

  it('yields the cap rather than split a sum when the token list alone exceeds it', async () => {
    // Degenerate but the priority must be explicit: exceeding a robustness limit is
    // recoverable, splitting one address's sum is a money bug.
    const manyTokens = Array.from(
      { length: MAX_CALLS + 10 },
      (_unused, i) => `0x${(i + 0x5000).toString(16).padStart(40, '0')}`,
    );
    const spy = sink();
    const client = perHolderClient({}, spy);
    await sumErc20BalancesMany(client, manyTokens, [holder(1), holder(2)]);
    // One address per chunk, each over the nominal cap, and neither sum split.
    expect(spy.aggregate3Count).toBe(2);
    for (const entries of spy.entriesPerCall) expect(entries).toBe(manyTokens.length);
  });
});
