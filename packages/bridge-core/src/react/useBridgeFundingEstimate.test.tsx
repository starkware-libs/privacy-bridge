// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

/**
 * Bug 1 (value-path): useBridgeFundingEstimate must NOT serve the previous bet's
 * `ready` plan during the debounce after the bet changes. If it did, a consumer
 * that reads `estimate.plan.fundMicro` (e.g. OrderTicket.runBuy) within that
 * window would burn the OLD bet's fund amount for the NEW bet.
 *
 * The fix resets `estimate` to `{status:'loading'}` synchronously at the TOP of
 * the effect (before scheduling the debounce timer), so no consumer ever sees a
 * `ready` plan that doesn't match the current bet.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeFundingPlan } from '../core/bridgeFunding';

// Control the plan per bet so we can tell bet A's plan from bet B's.
const fetchBridgeFundingPlanMock = vi.fn();
vi.mock('../core/bridgeFunding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/bridgeFunding')>();
  return {
    ...actual,
    fetchBridgeFundingPlan: (...args: unknown[]) => fetchBridgeFundingPlanMock(...args),
  };
});

import { useBridgeFundingEstimate } from './useBridgeFundingEstimate';

const DECIMALS = 6;

// A minimal plan whose fundMicro encodes which bet it was quoted for.
function planFor(betMicro: bigint): BridgeFundingPlan {
  return {
    betMicro,
    fundMicro: betMicro + 100_000n, // "old bet's fund amount" is distinguishable
    reserveMicro: 100_000n,
    projectedOrderMicro: betMicro,
    belowFloor: false,
    quote: { maxFee: 50_000n } as BridgeFundingPlan['quote'],
  } as BridgeFundingPlan;
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchBridgeFundingPlanMock.mockImplementation(
    async (betWei: bigint) => planFor(betWei),
  );
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('useBridgeFundingEstimate — Bug 1: no stale ready plan during the debounce', () => {
  it("does NOT serve bet A's ready plan while bet B is still inside the debounce window", async () => {
    const BET_A = 1_000_000n;
    const BET_B = 5_000_000n;

    const { result, rerender } = renderHook(({ bet }) => useBridgeFundingEstimate(bet, DECIMALS), {
      initialProps: { bet: BET_A as bigint | null },
    });

    // Settle bet A: run every timer + microtask so the plan resolves regardless of
    // the current DEBOUNCE_MS value — the test asserts the sync-invalidate contract,
    // not a specific delay.
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(result.current.status).toBe('ready');
    if (result.current.status === 'ready') {
      expect(result.current.plan.fundMicro).toBe(BET_A + 100_000n);
    }

    // Change to bet B and advance ONLY the synchronous microtask queue — no timers
    // fire, so the debounced fetch is still pending regardless of its length.
    rerender({ bet: BET_B });
    await act(async () => {
      await Promise.resolve();
    });

    // RED before the fix: status is still 'ready' with bet A's plan.
    // GREEN after: status is NOT 'ready' (reset to 'loading') → no stale plan.
    expect(result.current.status).not.toBe('ready');

    // Draining timers + microtasks settles bet B's plan.
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(result.current.status).toBe('ready');
    if (result.current.status === 'ready') {
      expect(result.current.plan.fundMicro).toBe(BET_B + 100_000n);
    }
  });
});
