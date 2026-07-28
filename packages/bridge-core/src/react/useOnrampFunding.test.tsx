// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

/**
 * #179b / #201 (SDK-side regression): the card-on-ramp phase machine moved into this
 * hook (Slice E2). #201's fix — "keep the background reconcile alive across a modal
 * close" — MUST survive that move. After the ~8s foreground grace times out with no
 * balance delta, runGrace releases the UI to idle (phase 'idle') but KEEPS the session
 * live and polls SILENTLY for the remainder of the authoritative window. If the modal
 * then closes, `close()` must recognise that live-but-idle background reconcile
 * (reconcilingRef) and NOT tear it down — otherwise a late card delivery is silently
 * abandoned (card charged, no deposit), the exact #179 abandonment #201 closed.
 *
 * These drive the REAL hook via renderHook and inject the settlement poll through the
 * optional `waitForBalance` test seam so poll/grace timing is controllable. Each mirrors
 * one of #201's three DepositModal-level cases at the owning-SDK level:
 *   • Case B          — close DURING the background reconcile → late delivery still deposits.
 *   • Case B companion — same close, but NO payment ever lands → clean teardown, no deposit.
 *   • Case 3a         — a NEW session supersedes the reconcile, then close mid-flight tears
 *                       the new session down (the reconcilingRef stale-true hole).
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useOnrampFunding, type OnrampFundingDeps } from './useOnrampFunding';

const SN = '0xDERIVED_SN';
const GRACE = 8_000;
const DEADLINE = 720_000;

type WaitForBalance = NonNullable<OnrampFundingDeps['waitForBalance']>;

function makeDeps(overrides: Partial<OnrampFundingDeps> = {}): OnrampFundingDeps {
  return {
    readBaseline: vi.fn(async () => 0n),
    deposit: vi.fn(async () => {}),
    deriveIdentity: vi.fn(async () => SN),
    waitForBalance: vi.fn<WaitForBalance>(async () => {}),
    graceMs: GRACE,
    deadlineMs: DEADLINE,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useOnrampFunding — #179b/#201 background-reconcile survives modal close', () => {
  it('Case B: close() DURING the silent background reconcile must NOT abort it — a late delivery still deposits', async () => {
    const waitForBalance = vi.fn<WaitForBalance>();
    let resolveBackground!: () => void;
    waitForBalance
      // 1st = foreground grace (8s): times out with no delta → go background.
      .mockImplementationOnce(async (_a, _t, _b, _s, d) => {
        expect(d).toBe(GRACE);
        throw new Error('Timed out waiting for the card payment');
      })
      // 2nd = SILENT background reconcile: authoritative window, resolves AFTER close().
      .mockImplementationOnce(
        (_a, _t, _b, _s, d) =>
          new Promise<void>((resolve) => {
            expect(d).toBeGreaterThan(GRACE); // remainder of the authoritative window, not the grace
            resolveBackground = () => resolve();
          }),
      );
    const deposit = vi.fn(async () => {});
    const deps = makeDeps({ waitForBalance, deposit });
    const { result } = renderHook(() => useOnrampFunding(deps));

    await act(async () => {
      result.current.start({ snAddress: SN, targetWei: 5_000_000n, amount: '5' });
    });
    await waitFor(() => expect(result.current.phase).toBe('widget'));

    // Widget cancel → runGrace: foreground grace fails → background reconcile begins.
    await act(async () => {
      result.current.onCancel();
    });
    await waitFor(() => expect(waitForBalance).toHaveBeenCalledTimes(2));
    // UI released to idle while the background poll runs.
    await waitFor(() => expect(result.current.phase).toBe('idle'));

    // NOW the modal closes mid-reconcile. This must NOT abort the poll.
    await act(async () => {
      result.current.close();
    });

    // The late card delivery lands AFTER close → deposit MUST still fire.
    await act(async () => {
      resolveBackground();
    });
    await waitFor(() =>
      expect(deposit).toHaveBeenCalledWith({ snAddress: SN, amount: '5', sourceChainId: undefined }),
    );
    expect(result.current.error).toBeNull();
  });

  it('Case B companion: close() mid-reconcile with NO payment → clean teardown (no deposit, no hang)', async () => {
    const waitForBalance = vi.fn<WaitForBalance>();
    let rejectBackground!: () => void;
    waitForBalance
      .mockImplementationOnce(async () => {
        throw new Error('Timed out waiting for the card payment');
      })
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectBackground = () => reject(new Error('Timed out waiting for the card payment'));
          }),
      );
    const deposit = vi.fn(async () => {});
    const deps = makeDeps({ waitForBalance, deposit });
    const { result } = renderHook(() => useOnrampFunding(deps));

    await act(async () => {
      result.current.start({ snAddress: SN, targetWei: 5_000_000n, amount: '5' });
    });
    await waitFor(() => expect(result.current.phase).toBe('widget'));
    await act(async () => {
      result.current.onCancel();
    });
    await waitFor(() => expect(waitForBalance).toHaveBeenCalledTimes(2));

    await act(async () => {
      result.current.close();
    });
    // No delta → the background poll times out → clean teardown, no deposit.
    await act(async () => {
      rejectBackground();
      await Promise.resolve();
    });
    expect(deposit).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.phase).toBe('idle'));
    expect(result.current.error).toBeNull();
  });

  it('Case 3a: a NEW session supersedes a prior reconcile — close() while the new session is mid-flight tears it down (reconcilingRef reset, no leaked deposit)', async () => {
    const waitForBalance = vi.fn<WaitForBalance>();
    let resolveStaleBackground!: () => void;
    waitForBalance
      // 1st = session A foreground grace: times out → background reconcile begins.
      .mockImplementationOnce(async () => {
        throw new Error('Timed out');
      })
      // 2nd = session A background poll: pending (still live, reconcilingRef true).
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => { resolveStaleBackground = () => resolve(); }),
      )
      .mockImplementation(async () => {});

    // Session B's baseline read is held pending so B stays in 'baseline' (mid-flight,
    // NOT widget/polling/grace/depositing) when close() fires.
    let resolveBaselineB!: (v: bigint) => void;
    const readBaseline = vi
      .fn<(sn: string) => Promise<bigint>>()
      .mockResolvedValueOnce(0n) // session A baseline
      .mockImplementationOnce(
        () => new Promise<bigint>((resolve) => { resolveBaselineB = (v) => resolve(v); }),
      );
    const deposit = vi.fn(async () => {});
    const deps = makeDeps({ waitForBalance, readBaseline, deposit });
    const { result } = renderHook(() => useOnrampFunding(deps));

    // Session A: start → widget → cancel → foreground grace fails → background pending.
    await act(async () => {
      result.current.start({ snAddress: SN, targetWei: 5_000_000n, amount: '5' });
    });
    await waitFor(() => expect(result.current.phase).toBe('widget'));
    await act(async () => {
      result.current.onCancel();
    });
    await waitFor(() => expect(waitForBalance).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.phase).toBe('idle')); // reconcilingRef true

    // Start session B — its baseline read is pending, so B is held in 'baseline'.
    await act(async () => {
      result.current.start({ snAddress: SN, targetWei: 7_000_000n, amount: '7' });
    });
    await waitFor(() => expect(result.current.phase).toBe('baseline'));

    // Close while B is mid-flight. With the fix, start(B) reset reconcilingRef=false, so
    // close() reaches teardown() and tears B down. Without it, the stale reconcilingRef
    // (from A) no-ops the close and B survives.
    await act(async () => {
      result.current.close();
    });

    // B's baseline now resolves → isLive(B) false → the continuation bails (no widget).
    await act(async () => {
      resolveBaselineB(0n);
      await Promise.resolve();
    });
    expect(result.current.widget).toBeNull();
    expect(deposit).not.toHaveBeenCalled();

    // Tidy: the stale A background poll resolves late (isLive(A) false → no-op).
    await act(async () => {
      resolveStaleBackground();
      await Promise.resolve();
    });
    expect(deposit).not.toHaveBeenCalled();
  });
});
