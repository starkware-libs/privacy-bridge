// useDepositCctpFeeEstimate — Slice C. Mocks fetchForwardMaxFee so these tests
// exercise only the hook's debounce/cancel/fail-open bookkeeping, not the real
// Iris fee lookup (covered by core/cctpFees.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const mockFetchForwardMaxFee = vi.fn();
vi.mock('../core/cctpFees', () => ({
  fetchForwardMaxFee: (...args: unknown[]) => mockFetchForwardMaxFee(...args),
}));

import { useDepositCctpFeeEstimate } from './useDepositCctpFeeEstimate';

// Polygon Amoy — a real EVM CCTP source under the testnet config the vitest env
// stubs (packages/bridge-core/vitest.config.ts), so getEvmCctpSource resolves it.
const SOURCE_CHAIN_ID = 80002;
// Ethereum Sepolia — a second real source, for the stale-result-dropped case.
const OTHER_SOURCE_CHAIN_ID = 11155111;

beforeEach(() => {
  vi.useFakeTimers();
  mockFetchForwardMaxFee.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDepositCctpFeeEstimate', () => {
  it('idle when amount is null/non-positive or the source chain is unsupported', () => {
    const { result, rerender } = renderHook(
      ({ amount }: { amount: bigint | null }) =>
        useDepositCctpFeeEstimate(amount, SOURCE_CHAIN_ID),
      { initialProps: { amount: null } },
    );
    expect(result.current).toEqual({ status: 'idle', maxFeeRaw: 0n });

    rerender({ amount: 0n });
    expect(result.current).toEqual({ status: 'idle', maxFeeRaw: 0n });

    const unsupported = renderHook(() =>
      useDepositCctpFeeEstimate(1_000_000n, 999_999_999),
    );
    expect(unsupported.result.current).toEqual({ status: 'idle', maxFeeRaw: 0n });
    expect(mockFetchForwardMaxFee).not.toHaveBeenCalled();
  });

  it('debounces then resolves to ready with the quoted maxFee', async () => {
    mockFetchForwardMaxFee.mockResolvedValue({
      maxFee: 12_345n,
      forwardFee: 10_000n,
      protocolFee: 2_345n,
      finalityThreshold: 1000,
    });

    const { result } = renderHook(() =>
      useDepositCctpFeeEstimate(1_000_000n, SOURCE_CHAIN_ID),
    );
    expect(result.current).toEqual({ status: 'loading', maxFeeRaw: 0n });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(result.current).toEqual({ status: 'ready', maxFeeRaw: 12_345n });
  });

  it('fail-open: a rejected quote resolves to ready/0n, never stuck loading', async () => {
    mockFetchForwardMaxFee.mockRejectedValue(new Error('iris down'));

    const { result } = renderHook(() =>
      useDepositCctpFeeEstimate(1_000_000n, SOURCE_CHAIN_ID),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(result.current).toEqual({ status: 'ready', maxFeeRaw: 0n });
  });

  it('cancel-on-dep-change / stale-result-dropped: switching chains mid-debounce drops the old quote', async () => {
    let resolveFirst!: (v: unknown) => void;
    mockFetchForwardMaxFee.mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)));
    mockFetchForwardMaxFee.mockImplementationOnce(() =>
      Promise.resolve({ maxFee: 999n, forwardFee: 900n, protocolFee: 99n, finalityThreshold: 1000 }),
    );

    const { result, rerender } = renderHook(
      ({ chainId }: { chainId: number }) => useDepositCctpFeeEstimate(1_000_000n, chainId),
      { initialProps: { chainId: SOURCE_CHAIN_ID } },
    );

    // Let the first debounce fire, kicking off the (still-pending) fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(mockFetchForwardMaxFee).toHaveBeenCalledTimes(1);

    // Switch source chain before the first fetch resolves — this must cancel it.
    rerender({ chainId: OTHER_SOURCE_CHAIN_ID });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(mockFetchForwardMaxFee).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({ status: 'ready', maxFeeRaw: 999n });

    // Now resolve the stale FIRST fetch — must NOT clobber the second chain's result.
    await act(async () => {
      resolveFirst({ maxFee: 111n, forwardFee: 100n, protocolFee: 11n, finalityThreshold: 1000 });
      await Promise.resolve();
    });
    expect(result.current).toEqual({ status: 'ready', maxFeeRaw: 999n });
  });
});
