import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchStrkPriceUsd } from './strkPrice';

function mockFetch(impl: () => Promise<Response> | Response): void {
  vi.stubGlobal('fetch', vi.fn(impl));
}

describe('fetchStrkPriceUsd', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('parses the Coinbase shape {data:{amount}}', async () => {
    mockFetch(() => new Response(JSON.stringify({ data: { amount: '0.0295' } }), { status: 200 }));
    await expect(fetchStrkPriceUsd()).resolves.toBe(0.0295);
  });

  it('parses the Binance shape {price}', async () => {
    mockFetch(() => new Response(JSON.stringify({ price: '0.0298' }), { status: 200 }));
    await expect(fetchStrkPriceUsd()).resolves.toBe(0.0298);
  });

  it('parses the CoinGecko shape {starknet:{usd}}', async () => {
    mockFetch(() => new Response(JSON.stringify({ starknet: { usd: 0.031 } }), { status: 200 }));
    await expect(fetchStrkPriceUsd()).resolves.toBe(0.031);
  });

  it('returns null on a non-OK response', async () => {
    mockFetch(() => new Response('nope', { status: 503 }));
    await expect(fetchStrkPriceUsd()).resolves.toBeNull();
  });

  it('returns null on a thrown/aborted fetch', async () => {
    mockFetch(() => {
      throw new Error('network down');
    });
    await expect(fetchStrkPriceUsd()).resolves.toBeNull();
  });

  it('returns null on an unrecognized shape or non-positive price', async () => {
    mockFetch(() => new Response(JSON.stringify({ data: { amount: '0' } }), { status: 200 }));
    await expect(fetchStrkPriceUsd()).resolves.toBeNull();
  });
});
