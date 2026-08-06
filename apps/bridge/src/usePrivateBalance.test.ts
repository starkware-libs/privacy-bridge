// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Controllable identity/network mocks. Default: a derived, ready session.
type MockIdentity = {
  snAddress: string | null;
  viewingKey: bigint | null;
  deriveStatus: { status: 'idle' | 'pending' | 'error' | 'ready' };
};
let mockIdentity: MockIdentity = {
  snAddress: '0xsn-A',
  viewingKey: 123n,
  deriveStatus: { status: 'ready' },
};
vi.mock('./IdentityContext', () => ({
  useIdentity: () => mockIdentity,
}));
vi.mock('./NetworkContext', () => ({
  useNetwork: () => ({ networkEpoch: 0 }),
}));

// A queue of deferred promises so each poll can be resolved/rejected on demand,
// letting us assert the overlap guard (no stacking) and sticky-error behavior.
type Deferred = { resolve: (v: bigint) => void; reject: (e: unknown) => void };
let pending: Deferred[] = [];
const discover = vi.fn(
  () =>
    new Promise<bigint>((resolve, reject) => {
      pending.push({ resolve, reject });
    }),
);
vi.mock('@starkware-libs/starknet-privacy-bridge', () => ({
  discoverPrivateBalanceForAddress: () => discover(),
}));

import { usePrivateBalance } from './usePrivateBalance';

describe('usePrivateBalance', () => {
  beforeEach(() => {
    pending = [];
    discover.mockClear();
    mockIdentity = { snAddress: '0xsn-A', viewingKey: 123n, deriveStatus: { status: 'ready' } };
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches immediately and does NOT stack a second poll while one is in flight', async () => {
    const { result } = renderHook(() => usePrivateBalance());

    // Immediate first fetch (no 1s wait).
    expect(discover).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('loading');

    // A tick fires while the first is still unresolved — overlap guard skips it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(discover).toHaveBeenCalledTimes(1);

    // Resolve the first; next interval tick issues a fresh call.
    await act(async () => {
      pending[0].resolve(500n);
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.balance).toBe(500n);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('keeps the last good balance on a transient poll error (sticky)', async () => {
    const { result } = renderHook(() => usePrivateBalance());

    await act(async () => {
      pending[0].resolve(750n);
    });
    expect(result.current.balance).toBe(750n);
    expect(result.current.status).toBe('ready');

    // Next poll fails — value stays, status flips to error (non-destructive).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      pending[1].reject(new Error('indexer down'));
    });
    expect(result.current.balance).toBe(750n);
    expect(result.current.status).toBe('error');
    expect(result.current.error).toContain('indexer down');

    // Recovery clears the error.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      pending[2].resolve(800n);
    });
    expect(result.current.balance).toBe(800n);
    expect(result.current.status).toBe('ready');
    expect(result.current.error).toBeUndefined();
  });

  it('is idle (no polling) until a session is derived', () => {
    mockIdentity = { snAddress: null, viewingKey: null, deriveStatus: { status: 'idle' } };
    const { result } = renderHook(() => usePrivateBalance());
    expect(discover).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  // Bugbot MED #239: a DERIVED session must never read as 'idle' (which the widget
  // renders as "Sign to see your private balance"), even while the tab is hidden and
  // polling is paused. 'idle' means NOT-derived only.
  it('leaves idle immediately when derived even if the tab is hidden (no false sign prompt)', () => {
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      // mockIdentity is the default derived/ready session.
      const { result } = renderHook(() => usePrivateBalance());
      // Hidden ⇒ polling paused (no fetch)…
      expect(discover).not.toHaveBeenCalled();
      // …but a derived session is 'loading', NOT 'idle'.
      expect(result.current.status).toBe('loading');
    } finally {
      spy.mockRestore();
    }
  });
});
