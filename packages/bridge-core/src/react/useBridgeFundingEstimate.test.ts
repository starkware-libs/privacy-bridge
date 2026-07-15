// useBridgeFundingEstimate — moved from apps/web/src/starknet/useBridgeFundingEstimate.test.ts
// (Slice Y: apps/web's copy was a bare `export * from '@starkware-libs/starknet-privacy-bridge/react'`
// re-export shim with no logic of its own; testing it required deep-mocking bridge-core's
// internal ../core/bridgeFunding module via the now-deleted `bridge-core/core/bridgeFunding`
// export subpath. That mock only works via a relative path from INSIDE this package, so the
// test moves here — same assertions, now targeting the hook directly.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const mockFetchBridgeFundingPlan = vi.fn();
vi.mock('../core/bridgeFunding', () => ({
  fetchBridgeFundingPlan: (...args: unknown[]) => mockFetchBridgeFundingPlan(...args),
  bridgeFundingHint: () => 'hint',
  microToHuman: (micro: bigint, decimals: number) => Number(micro) / 10 ** decimals,
}));

import { bridgeFundingEstimateHint, useBridgeFundingEstimate } from './useBridgeFundingEstimate';

beforeEach(() => {
  vi.useFakeTimers();
  mockFetchBridgeFundingPlan.mockReset();
  mockFetchBridgeFundingPlan.mockResolvedValue({
    betMicro: 1_000_000n,
    fundMicro: 1_301_372n,
    reserveMicro: 301_372n,
    swapSlippageReserveMicro: 5_026n,
    extraReserveMicro: 0n,
    quote: { maxFee: 246_346n, forwardFee: 200_000n, protocolFee: 46_346n, finalityThreshold: 2000 },
    projectedOrderMicro: 1_000_000n,
    belowFloor: false,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useBridgeFundingEstimate', () => {
  it('debounces and returns bet + fund + projected order', async () => {
    const { result, rerender } = renderHook(
      ({ wei }: { wei: bigint | null }) => useBridgeFundingEstimate(wei, 6),
      { initialProps: { wei: null as bigint | null } },
    );

    rerender({ wei: 1_000_000n });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.status).toBe('ready');
    if (result.current.status !== 'ready') throw new Error('expected ready');
    expect(result.current.betHuman).toBe(1);
    expect(result.current.fundHuman).toBeCloseTo(1.301372, 5);
    expect(result.current.projectedOrderHuman).toBe(1);
    // The hook always passes a fee-route opts object; with no sourceChainId
    // (apps/web's bid ticket) both route fields are undefined → default route (#198).
    // extraReserveMicro defaults to 0n when the caller passes no extra reserve, and
    // fast is undefined so fetchBridgeFundingPlan falls back to config.cctp.fast.
    expect(mockFetchBridgeFundingPlan).toHaveBeenCalledWith(1_000_000n, {
      sourceDomain: undefined,
      destDomain: undefined,
      extraReserveMicro: 0n,
      fast: undefined,
    });
  });

  it('forwards opts.fast to fetchBridgeFundingPlan and re-quotes when it flips', async () => {
    const { rerender } = renderHook(
      ({ fast }: { fast: boolean }) =>
        useBridgeFundingEstimate(1_000_000n, 6, undefined, { fast }),
      { initialProps: { fast: true } },
    );

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Fast tier threaded through verbatim.
    expect(mockFetchBridgeFundingPlan).toHaveBeenLastCalledWith(1_000_000n, {
      sourceDomain: undefined,
      destDomain: undefined,
      extraReserveMicro: 0n,
      fast: true,
    });

    // Flipping the tier is a dependency change → the effect re-runs and re-quotes.
    rerender({ fast: false });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(mockFetchBridgeFundingPlan).toHaveBeenLastCalledWith(1_000_000n, {
      sourceDomain: undefined,
      destDomain: undefined,
      extraReserveMicro: 0n,
      fast: false,
    });
  });
});

describe('bridgeFundingEstimateHint', () => {
  it('returns the bridge funding hint when ready', () => {
    const hint = bridgeFundingEstimateHint(
      {
        status: 'ready',
        plan: {
          betMicro: 1n,
          fundMicro: 2n,
          reserveMicro: 1n,
          swapSlippageReserveMicro: 0n,
          extraReserveMicro: 0n,
          quote: { maxFee: 1n, forwardFee: 1n, protocolFee: 0n, finalityThreshold: 2000 },
          projectedOrderMicro: 1n,
          belowFloor: false,
        },
        betHuman: 1,
        fundHuman: 2,
        reserveHuman: 1,
        extraReserveHuman: 0,
        feeHuman: 0.25,
        projectedOrderHuman: 1.25,
        belowFloor: false,
        exceedsCap: false,
        capError: null,
      },
      6,
      'USDC',
    );
    expect(hint).toBe('hint');
  });
});

describe('useBridgeFundingEstimate cap option', () => {
  it('has no cap error when no cap is given', async () => {
    const { result, rerender } = renderHook(
      ({ wei }: { wei: bigint | null }) => useBridgeFundingEstimate(wei, 6),
      { initialProps: { wei: null as bigint | null } },
    );
    rerender({ wei: 1_000_000n });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    if (result.current.status !== 'ready') throw new Error('expected ready');
    expect(result.current.exceedsCap).toBe(false);
    expect(result.current.capError).toBeNull();
  });

  it('forwards extraReserveMicro into fetchBridgeFundingPlan (feeds plan.fundMicro)', async () => {
    mockFetchBridgeFundingPlan.mockReset();
    mockFetchBridgeFundingPlan.mockResolvedValue({
      betMicro: 1_000_000n,
      fundMicro: 4_801_372n,
      reserveMicro: 3_801_372n,
      swapSlippageReserveMicro: 5_026n,
      extraReserveMicro: 3_500_000n,
      quote: { maxFee: 246_346n, forwardFee: 200_000n, protocolFee: 46_346n, finalityThreshold: 2000 },
      projectedOrderMicro: 1_000_000n,
      belowFloor: false,
    });
    const { result, rerender } = renderHook(
      ({ wei }: { wei: bigint | null }) =>
        useBridgeFundingEstimate(wei, 6, undefined, { extraReserveMicro: 3_500_000n }),
      { initialProps: { wei: null as bigint | null } },
    );
    rerender({ wei: 1_000_000n });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(mockFetchBridgeFundingPlan).toHaveBeenCalledWith(1_000_000n, {
      sourceDomain: undefined,
      destDomain: undefined,
      extraReserveMicro: 3_500_000n,
    });
    if (result.current.status !== 'ready') throw new Error('expected ready');
    expect(result.current.fundHuman).toBeCloseTo(4.801372, 5);
    expect(result.current.extraReserveHuman).toBeCloseTo(3.5, 5);
  });

  it('flags exceedsCap + a capError message when the total funded amount exceeds the cap', async () => {
    const { result, rerender } = renderHook(
      ({ wei }: { wei: bigint | null }) =>
        useBridgeFundingEstimate(wei, 6, undefined, {
          cap: { amountMicro: 1_000_000n, symbol: 'USDC' },
        }),
      { initialProps: { wei: null as bigint | null } },
    );
    // fundMicro resolves to 1_301_372n (mocked above) — above the 1_000_000n cap.
    rerender({ wei: 1_000_000n });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    if (result.current.status !== 'ready') throw new Error('expected ready');
    expect(result.current.exceedsCap).toBe(true);
    expect(result.current.capError).toMatch(/exceeds the 1 USDC cap/);
  });
});
