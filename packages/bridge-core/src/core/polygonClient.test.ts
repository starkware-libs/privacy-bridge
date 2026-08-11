import { describe, it, expect } from 'vitest';
import { createPublicClient, custom, encodeAbiParameters, type PublicClient } from 'viem';
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
let blocksAskedSink: string[] | null = null;

function multiTokenClient(byToken: Record<string, bigint>): PublicClient {
  const lowered = Object.fromEntries(
    Object.entries(byToken).map(([addr, wei]) => [addr.toLowerCase(), wei]),
  );
  return createPublicClient({
    transport: custom({
      async request({ method, params }) {
        if (method === 'eth_blockNumber') return '0x64';
        if (method === 'eth_call') {
          const [call, blockTag] = params as [{ to?: string }, string];
          blocksAskedSink?.push(blockTag);
          const to = (call.to ?? '').toLowerCase();
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
  it('pins every balance read to ONE explicit block, never "latest"', async () => {
    // The summed tokens are stations the SAME funds pass through (in-place
    // conversions), so reads answered at different "latest"s can count one chunk of
    // money once per token. One pinned block makes the sum a statement about a
    // single state root, however viem chunks or retries the calls.
    blocksAskedSink = [];
    const client = multiTokenClient({ [TOKEN_A]: 1n, [TOKEN_B]: 2n, [TOKEN_C]: 4n });
    await sumErc20Balances(client, [TOKEN_A, TOKEN_B, TOKEN_C], '0x000000000000000000000000000000000000dEaD');
    expect(blocksAskedSink.length).toBe(3);
    expect(new Set(blocksAskedSink).size).toBe(1);
    expect(blocksAskedSink[0]).not.toBe('latest');
    blocksAskedSink = null;
  });

  it('honors a caller-pinned blockNumber without fetching its own', async () => {
    blocksAskedSink = [];
    const client = multiTokenClient({ [TOKEN_A]: 1n });
    await sumErc20Balances(client, [TOKEN_A], '0x000000000000000000000000000000000000dEaD', {
      blockNumber: 0x42n,
    });
    expect(blocksAskedSink).toEqual(['0x42']);
    blocksAskedSink = null;
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
    blocksAskedSink = [];
    const client = multiTokenClient({});
    expect(await sumErc20Balances(client, ['', ''], '0x000000000000000000000000000000000000dEaD')).toBe(0n);
    expect(blocksAskedSink).toEqual([]);
    blocksAskedSink = null;
  });
});
