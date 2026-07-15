import { afterEach, describe, expect, it, vi } from 'vitest';

// The indexer's `/v1/sync/incoming_state` JSON parse lives inside the SDK's
// IndexerDiscoveryProvider (third-party, not editable here). When the indexer
// returns a 500 / empty body, the SDK's raw `resp.json()` throws a bare
// "Unexpected end of JSON input" SyntaxError. discover.ts must catch that and
// rethrow a CLEAR, actionable error that names the endpoint — never the raw
// DOMException — so the balance loader can surface it instead of crashing.

const { discoverNotesMock } = vi.hoisted(() => ({ discoverNotesMock: vi.fn() }));

vi.mock('@starkware-libs/starknet-privacy-sdk', () => ({
  createPrivateTransfers: vi.fn(() => ({})),
  IndexerDiscoveryProvider: class {
    discoverNotes = discoverNotesMock;
  },
}));

vi.mock('./config', () => ({
  config: {
    indexerUrl: 'http://indexer.test',
    poolAddress: '0x1',
    proverUrl: 'http://prover.test',
    chainId: 'SN_SEPOLIA',
    depositToken: { address: '0x6', decimals: 6, symbol: 'USDC' },
  },
}));

import { discoverPrivateBalanceForAddress, formatTokenAmount } from './discover';

afterEach(() => {
  discoverNotesMock.mockReset();
});

describe('discoverPrivateBalanceForAddress – indexer error mapping', () => {
  it('a 500/empty indexer response surfaces a CLEAR error, NOT a bare DOMException', async () => {
    // Reproduce exactly what the SDK throws on an empty/500 body.
    let domException: unknown;
    try {
      JSON.parse('');
    } catch (e) {
      domException = e;
    }
    discoverNotesMock.mockRejectedValueOnce(domException);

    let thrown: unknown;
    try {
      await discoverPrivateBalanceForAddress({ snAddress: '0x2', viewingKey: 7n });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    // Clear + actionable: names the indexer endpoint…
    expect(msg).toMatch(/indexer/i);
    expect(msg).toMatch(/incoming_state/i);
    // …and must NOT be the cryptic raw JSON-parse exception.
    expect(msg).not.toBe('Unexpected end of JSON input');
  });

  it('a non-JSON-parse failure (e.g. network) is passed through unchanged', async () => {
    discoverNotesMock.mockRejectedValueOnce(new Error('Failed to fetch'));
    await expect(
      discoverPrivateBalanceForAddress({ snAddress: '0x2', viewingKey: 7n }),
    ).rejects.toThrowError(/Failed to fetch/);
  });

  it('sums note amounts on success', async () => {
    const notes = new Map<bigint, { amount: bigint }[]>([
      [0x6n, [{ amount: 10n }, { amount: 5n }]],
    ]);
    discoverNotesMock.mockResolvedValueOnce({ notes });
    await expect(
      discoverPrivateBalanceForAddress({ snAddress: '0x2', viewingKey: 7n }),
    ).resolves.toBe(15n);
  });
});

describe('formatTokenAmount', () => {
  it('formats a positive raw amount with trailing zeros trimmed', () => {
    expect(formatTokenAmount(1_500_000n, 6)).toBe('1.5');
    expect(formatTokenAmount(1_000_000n, 6)).toBe('1');
  });

  // #160: bigint '%'/'/ ' truncate toward zero, so formatting a negative value
  // without normalising the sign up front mixes a negative `whole` with a
  // negative `fraction` STRING, mangling the output (e.g. '-1.-5' instead of
  // '-1.5').
  it('#160: formats a negative raw amount correctly (not mangled like "-1.-5")', () => {
    expect(formatTokenAmount(-1_500_000n, 6)).toBe('-1.5');
    expect(formatTokenAmount(-1_000_000n, 6)).toBe('-1');
  });
});
