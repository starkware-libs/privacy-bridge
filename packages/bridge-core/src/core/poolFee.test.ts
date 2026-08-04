import { beforeEach, describe, expect, it, vi } from 'vitest';

const callContract = vi.fn();

vi.mock('./provider', () => ({
  getRpcProvider: () => ({ callContract }),
}));

import { fetchPoolFeeAmount, fetchPoolFeeStrk, readPoolFeeAmount } from './poolFee';

// 6 STRK in wei — the pool's deployed protocol fee.
const SIX_STRK_WEI = 6_000_000_000_000_000_000n;

beforeEach(() => {
  callContract.mockReset();
});

describe('readPoolFeeAmount', () => {
  it('reads the pool fee (wei) from get_fee_amount', async () => {
    callContract.mockResolvedValueOnce([`0x${SIX_STRK_WEI.toString(16)}`]);
    await expect(readPoolFeeAmount()).resolves.toBe(SIX_STRK_WEI);
    expect(callContract).toHaveBeenCalledWith(
      expect.objectContaining({ entrypoint: 'get_fee_amount', calldata: [] }),
    );
  });

  it('propagates an unreadable view as null (NOT 0 — unknown is not free)', async () => {
    callContract.mockRejectedValueOnce(new Error('rpc down'));
    await expect(readPoolFeeAmount()).resolves.toBeNull();
  });

  it('propagates an empty result as null', async () => {
    callContract.mockResolvedValueOnce([]);
    await expect(readPoolFeeAmount()).resolves.toBeNull();
  });
});

describe('fetchPoolFeeAmount', () => {
  it('collapses an unreadable view to 0 for the approve path', async () => {
    callContract.mockRejectedValueOnce(new Error('rpc down'));
    await expect(fetchPoolFeeAmount()).resolves.toBe(0n);
  });

  it('returns the live fee when readable', async () => {
    callContract.mockResolvedValueOnce([`0x${SIX_STRK_WEI.toString(16)}`]);
    await expect(fetchPoolFeeAmount()).resolves.toBe(SIX_STRK_WEI);
  });
});

describe('fetchPoolFeeStrk', () => {
  it('formats the live fee into human STRK units', async () => {
    callContract.mockResolvedValueOnce([`0x${SIX_STRK_WEI.toString(16)}`]);
    await expect(fetchPoolFeeStrk()).resolves.toBe('6');
  });

  it('tracks a fee change on-chain with no client change', async () => {
    callContract.mockResolvedValueOnce([`0x${(7_500_000_000_000_000_000n).toString(16)}`]);
    await expect(fetchPoolFeeStrk()).resolves.toBe('7.5');
  });

  // An unreadable view or a non-positive read must leave the caller on its configured
  // fallback: strkFeeToUsdc turns a '0' fee into its own '0.5' default, which would
  // size a reserve off a number that has nothing to do with the pool.
  it('returns null when the view is unavailable', async () => {
    callContract.mockRejectedValueOnce(new Error('rpc down'));
    await expect(fetchPoolFeeStrk()).resolves.toBeNull();
  });

  it('returns null on a zero fee rather than a "0" estimate', async () => {
    callContract.mockResolvedValueOnce(['0x0']);
    await expect(fetchPoolFeeStrk()).resolves.toBeNull();
  });
});
