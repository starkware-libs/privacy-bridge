// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Regression (Slice E2, #189): reopening the modal mid-poll must invalidate the
// stale poll continuation — it must NOT deposit, and a FRESH session that lands
// funds must deposit exactly once (no double-deposit from the persisted poll).
// The modal models a reopen as cancel() (hard reset) followed by a new start().
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

describe('useOnrampFunding — reopen-mid-poll (#189)', () => {
  it('stale poll continuation is a no-op on reopen; the fresh session deposits exactly once', async () => {
    let resolveStalePoll!: () => void;
    const waitForBalance = vi
      .fn<OnrampFundingDeps['waitForBalance']>()
      // 1st call = session A poll: controllable, resolves LATE (after reopen).
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => { resolveStalePoll = () => resolve(); }),
      )
      // 2nd call = fresh session B poll: resolves immediately.
      .mockImplementation(async () => {});
    const deposit = vi.fn(async () => {});
    const deps = makeDeps({ waitForBalance, deposit });
    const { result } = renderHook(() => useOnrampFunding(deps));

    // Session A: start → widget → success hint → polling (poll A pending).
    act(() => result.current.start({ ...SESSION }));
    await waitFor(() => expect(result.current.phase).toBe('widget'));
    act(() => result.current.onSettled());
    expect(result.current.phase).toBe('polling');

    // Reopen: cancel() (hard reset) then a FRESH start (session B).
    act(() => result.current.cancel());
    act(() => result.current.start({ ...SESSION }));
    await waitFor(() => expect(result.current.phase).toBe('widget'));
    act(() => result.current.onSettled()); // session B poll resolves immediately → deposit B
    await waitFor(() => expect(deposit).toHaveBeenCalledTimes(1));

    // Now the STALE session-A poll resolves late — its token no longer owns the
    // flow, so it must be a NO-OP and must NOT fire a SECOND deposit.
    await act(async () => {
      resolveStalePoll();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(deposit).toHaveBeenCalledTimes(1);
  });
});
