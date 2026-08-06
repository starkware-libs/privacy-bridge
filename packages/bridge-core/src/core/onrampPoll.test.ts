// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Unit test for the on-ramp settlement poll (waitForDepositTokenBalance). It must
// resolve once the derived account's deposit-token balance reaches baseline+target
// (card payment settled), swallow a transient RPC error and keep polling, and reject
// when the generous deadline elapses (so a stuck/abandoned payment can't hang the
// flow forever). Fake timers keep the 2.5s sleep / 12-min deadline fast. Moved from
// apps/web (IdentityContext) alongside the poll itself.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Controllable balance read — the only boundary the poll touches. Mocking the whole
// module keeps deposit's heavier starknet import graph out of this unit test.
const getSnDepositTokenBalance = vi.fn<(address: string) => Promise<bigint>>();
vi.mock('./deposit', () => ({
  getDepositTokenBalance: (address: string) => getSnDepositTokenBalance(address),
}));

beforeEach(() => {
  getSnDepositTokenBalance.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('waitForDepositTokenBalance', () => {
  it('resolves once the balance reaches baseline + target (returns < target then >= target)', async () => {
    const { waitForDepositTokenBalance } = await import('./onrampPoll');
    getSnDepositTokenBalance
      .mockResolvedValueOnce(5n) // first poll: not yet funded
      .mockResolvedValueOnce(100n); // second poll: funded

    const onStatus = vi.fn();
    // baseline 0 → required = 100n (the from-empty case).
    const promise = waitForDepositTokenBalance('0xDERIVED_SN', 100n, 0n, onStatus);

    // Advance past the 2.5s sleep between polls (flush microtasks each tick).
    await vi.advanceTimersByTimeAsync(2500);
    await expect(promise).resolves.toBeUndefined();
    expect(getSnDepositTokenBalance).toHaveBeenCalledTimes(2);
    expect(onStatus).toHaveBeenCalled();
  });

  it('retries past a single transient RPC error after the card payment settled', async () => {
    const { waitForDepositTokenBalance } = await import('./onrampPoll');
    getSnDepositTokenBalance
      .mockRejectedValueOnce(new Error('fetch failed')) // transient RPC blip
      .mockResolvedValueOnce(100n); // funds have landed

    const promise = waitForDepositTokenBalance('0xDERIVED_SN', 100n, 0n, vi.fn());
    // Advance past the inter-poll sleep so the retry runs.
    await vi.advanceTimersByTimeAsync(2500);
    await expect(promise).resolves.toBeUndefined();
    expect(getSnDepositTokenBalance).toHaveBeenCalledTimes(2);
  });

  it('rejects once the deadline elapses without reaching the target', async () => {
    const { waitForDepositTokenBalance } = await import('./onrampPoll');
    getSnDepositTokenBalance.mockResolvedValue(0n); // never funded

    const promise = waitForDepositTokenBalance('0xDERIVED_SN', 100n, 0n, vi.fn());
    const assertion = expect(promise).rejects.toThrow(/Timed out waiting for the card payment/i);

    // Run past the 12-min deadline (720_000ms) — each tick is a 2.5s sleep.
    await vi.advanceTimersByTimeAsync(720_000 + 2500);
    await assertion;
  });

  it('does NOT resolve on pre-existing funds — waits for a delta above baseline', async () => {
    const { waitForDepositTokenBalance } = await import('./onrampPoll');
    // baseline = 100n (account already holds >= target of 100n). The poll must
    // wait for balance >= 200n (baseline + target), not >= 100n.
    getSnDepositTokenBalance
      .mockResolvedValueOnce(100n) // poll 1: still only the pre-existing balance
      .mockResolvedValueOnce(150n) // poll 2: partial — still below baseline+target
      .mockResolvedValue(200n); // poll 3+: NEW funds landed (delta == target)

    const promise = waitForDepositTokenBalance('0xDERIVED_SN', 100n, 100n, vi.fn());

    // After the first poll the balance equals the target in absolute terms; an
    // absolute check would resolve here. Advance one sleep and assert it has NOT.
    await vi.advanceTimersByTimeAsync(2500);
    expect(getSnDepositTokenBalance).toHaveBeenCalledTimes(2);

    // Advance until the delta lands; only then does it resolve.
    await vi.advanceTimersByTimeAsync(2500);
    await expect(promise).resolves.toBeUndefined();
    expect(getSnDepositTokenBalance).toHaveBeenCalledTimes(3);
  });

  it('rejects on deadline when balance stays at baseline (no new funds)', async () => {
    const { waitForDepositTokenBalance } = await import('./onrampPoll');
    getSnDepositTokenBalance.mockResolvedValue(100n); // stuck at baseline forever

    const promise = waitForDepositTokenBalance('0xDERIVED_SN', 100n, 100n, vi.fn());
    const assertion = expect(promise).rejects.toThrow(/Timed out waiting for the card payment/i);

    await vi.advanceTimersByTimeAsync(720_000 + 2500);
    await assertion;
  });
});
