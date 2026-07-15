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
function multiTokenClient(byToken: Record<string, bigint>): PublicClient {
  const lowered = Object.fromEntries(
    Object.entries(byToken).map(([addr, wei]) => [addr.toLowerCase(), wei]),
  );
  return createPublicClient({
    transport: custom({
      async request({ method, params }) {
        if (method === 'eth_call') {
          const to = ((params as [{ to?: string }])[0]?.to ?? '').toLowerCase();
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
