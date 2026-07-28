// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Regression (Slice E2): cancel while the baseline read is IN FLIGHT must drop the
// result — the flow must NOT advance to 'widget'/'polling' and must NOT deposit.
// This is the token/isLive invalidation invariant applied to the earliest async
// continuation (derive → baseline). Ported from the DepositModal card-on-ramp
// machine into the frozen useOnrampFunding hook.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useOnrampFunding, type OnrampFundingDeps } from './useOnrampFunding';

function makeDeps(overrides: Partial<OnrampFundingDeps> = {}): OnrampFundingDeps {
  return {
    readBaseline: vi.fn(async () => 0n),
    waitForBalance: vi.fn(async () => {}),
    deposit: vi.fn(async () => {}),
    deriveIdentity: vi.fn(async () => '0xSN'),
    deadlineMs: 720_000,
    graceMs: 8_000,
    ...overrides,
  };
}

const SESSION = { snAddress: '0xSN', targetWei: 5_000_000n, amount: '5' } as const;

afterEach(() => vi.restoreAllMocks());

describe('useOnrampFunding — cancel-during-baseline', () => {
  it('cancel while the baseline read is in flight → result dropped, no widget/poll/deposit', async () => {
    let resolveBaseline!: (v: bigint) => void;
    const readBaseline = vi.fn(
      () => new Promise<bigint>((resolve) => { resolveBaseline = resolve; }),
    );
    const deps = makeDeps({ readBaseline });
    const { result } = renderHook(() => useOnrampFunding(deps));

    act(() => result.current.start({ ...SESSION }));
    // The baseline read is pending → phase is 'baseline'.
    await waitFor(() => expect(result.current.phase).toBe('baseline'));
    expect(readBaseline).toHaveBeenCalledTimes(1);

    // Cancel (e.g. modal reopened / user takeover) while the read is in flight.
    act(() => result.current.cancel());
    expect(result.current.phase).toBe('idle');

    // The baseline now resolves — the continuation must be a NO-OP: it must not
    // enter 'widget'/'polling', must not mount a widget, and must not deposit.
    await act(async () => {
      resolveBaseline(0n);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.phase).toBe('idle');
    expect(result.current.widget).toBeNull();
    expect(deps.waitForBalance).not.toHaveBeenCalled();
    expect(deps.deposit).not.toHaveBeenCalled();
  });

  it('cancel while the DERIVE (null snAddress) is in flight → no widget, no deposit', async () => {
    let resolveDerive!: (v: string | null) => void;
    const deriveIdentity = vi.fn(
      () => new Promise<string | null>((resolve) => { resolveDerive = resolve; }),
    );
    const readBaseline = vi.fn(async () => 0n);
    const deps = makeDeps({ deriveIdentity, readBaseline });
    const { result } = renderHook(() => useOnrampFunding(deps));

    // Start with NO snAddress → the hook derives first (folded into 'baseline').
    act(() => result.current.start({ snAddress: null, targetWei: 5_000_000n, amount: '5' }));
    await waitFor(() => expect(deriveIdentity).toHaveBeenCalledTimes(1));

    act(() => result.current.cancel());

    await act(async () => {
      resolveDerive('0xSN');
      await Promise.resolve();
      await Promise.resolve();
    });
    // Stale derive resolved after cancel → must not read baseline, mount, or deposit.
    expect(readBaseline).not.toHaveBeenCalled();
    expect(result.current.widget).toBeNull();
    expect(deps.deposit).not.toHaveBeenCalled();
  });
});
