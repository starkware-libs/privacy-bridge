// Regression (Slice E2, BUG-1/#193): a wallet network switch mid-flight invalidates
// the session (the modal responds by calling cancel()), so no stale-chain probe or
// stale-derive result is applied. Proven at the hook via the token/isLive invariant:
// after cancel(), an in-flight baseline read OR poll resolving late is a NO-OP.
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

describe('useOnrampFunding — network-switch-mid-flight (BUG-1/#193)', () => {
  it('switch during BASELINE → session invalidated, stale baseline result not applied', async () => {
    let resolveBaseline!: (v: bigint) => void;
    const readBaseline = vi.fn(
      () => new Promise<bigint>((resolve) => { resolveBaseline = resolve; }),
    );
    const deps = makeDeps({ readBaseline });
    const { result } = renderHook(() => useOnrampFunding(deps));

    act(() => result.current.start({ ...SESSION }));
    await waitFor(() => expect(result.current.phase).toBe('baseline'));

    // Network switch → the modal invalidates the flow.
    act(() => result.current.cancel());
    expect(result.current.phase).toBe('idle');

    // The pre-switch baseline read completes — must NOT advance the (now stale) flow.
    await act(async () => {
      resolveBaseline(999n);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.phase).toBe('idle');
    expect(result.current.widget).toBeNull();
    expect(deps.waitForBalance).not.toHaveBeenCalled();
    expect(deps.deposit).not.toHaveBeenCalled();
  });

  it('switch during POLL → session invalidated, stale poll does not deposit', async () => {
    let resolvePoll!: () => void;
    const waitForBalance = vi
      .fn<OnrampFundingDeps['waitForBalance']>()
      .mockImplementation(() => new Promise<void>((resolve) => { resolvePoll = () => resolve(); }));
    const deps = makeDeps({ waitForBalance });
    const { result } = renderHook(() => useOnrampFunding(deps));

    act(() => result.current.start({ ...SESSION }));
    await waitFor(() => expect(result.current.phase).toBe('widget'));
    act(() => result.current.onSettled());
    expect(result.current.phase).toBe('polling');

    // Network switch mid-poll → invalidate.
    act(() => result.current.cancel());

    // The pre-switch poll resolves late — its token is stale → no deposit.
    await act(async () => {
      resolvePoll();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(deps.deposit).not.toHaveBeenCalled();
  });
});
