// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Warm fee-rows cache: the estimate settles synchronously (no debounce, no fetch, no
// `loading` flash) and never serves a plan for stale inputs. Cold/expired → the
// debounced `loading` path.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planFromFeeRows } from '../core/bridgeFunding';
import {
  ESTIMATE_FEE_MAX_AGE_MS,
  fetchCctpFeeRows,
  resetCctpFeeCache,
  resolveFeeRoute,
  type IrisFeeRow,
} from '../core/cctpFees';
import { useBridgeFundingEstimate } from './useBridgeFundingEstimate';

const DECIMALS = 6;
const BET_A = 1_000_000n;
const BET_B = 5_000_000n;
const ROWS: IrisFeeRow[] = [
  { finalityThreshold: 1000, minimumFee: 12, forwardFee: { low: 74497, med: 74497, high: 75003 } },
  { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 74497, med: 74497, high: 75003 } },
];
// Polygon Amoy in the testnet fixture config: selecting it switches to the EVM→Starknet route.
const SOURCE_CHAIN_ID = 80002;

const globalFetch = vi.fn<typeof fetch>();

async function warmDefaultRoute(): Promise<void> {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(ROWS)));
  await fetchCctpFeeRows(resolveFeeRoute(), {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    maxAgeMs: ESTIMATE_FEE_MAX_AGE_MS,
  });
}

function renderEstimate(initial: { bet: bigint; sourceChainId?: number }) {
  const seen: string[] = [];
  const hook = renderHook(
    ({ bet, sourceChainId }) => {
      const estimate = useBridgeFundingEstimate(bet, DECIMALS, sourceChainId);
      seen.push(estimate.status);
      return estimate;
    },
    { initialProps: initial },
  );
  return { ...hook, seen };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetCctpFeeCache();
  globalFetch.mockReset();
  globalFetch.mockImplementation(() => new Promise<Response>(() => {})); // never settles
  vi.stubGlobal('fetch', globalFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetCctpFeeCache();
});

describe('useBridgeFundingEstimate — warm fee-rows cache', () => {
  it('settles to ready without a debounce or a network call', async () => {
    await warmDefaultRoute();
    const { result, seen } = renderEstimate({ bet: BET_A });

    expect(result.current.status).toBe('ready');
    if (result.current.status === 'ready') {
      expect(result.current.plan).toEqual(planFromFeeRows(BET_A, ROWS, resolveFeeRoute()));
    }
    expect(seen).not.toContain('loading');
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('re-quotes a bet change in the same commit, never flashing loading', async () => {
    await warmDefaultRoute();
    const { result, rerender, seen } = renderEstimate({ bet: BET_A });

    rerender({ bet: BET_B });

    expect(result.current.status).toBe('ready');
    if (result.current.status === 'ready') expect(result.current.plan.betMicro).toBe(BET_B);
    expect(seen).not.toContain('loading');
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('a route change with no cached rows drops the old plan to loading', async () => {
    await warmDefaultRoute();
    const { result, rerender } = renderEstimate({ bet: BET_A });
    expect(result.current.status).toBe('ready');

    rerender({ bet: BET_A, sourceChainId: SOURCE_CHAIN_ID });

    expect(result.current.status).toBe('loading');
  });

  it('expired rows take the debounced cold path', async () => {
    await warmDefaultRoute();
    vi.advanceTimersByTime(ESTIMATE_FEE_MAX_AGE_MS);
    const { result } = renderEstimate({ bet: BET_A });

    expect(result.current.status).toBe('loading');
    expect(globalFetch).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(globalFetch).toHaveBeenCalledTimes(1);
  });
});
