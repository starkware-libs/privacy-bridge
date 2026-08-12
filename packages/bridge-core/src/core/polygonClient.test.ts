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
import { readUsdcBalance, sumErc20Balances } from './polygonClient';

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
