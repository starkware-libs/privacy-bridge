// Core fund-safety spec for the frozen on-ramp phase machine (Slice E2). These
// assertions were ported from the DepositModal card-on-ramp white-box tests so the
// session/token/isLive machine keeps its coverage after moving into /react. The
// component test (DepositModal.onramp.test.tsx) now drives the REAL hook and stays
// as an integration check; this file is the unit-level contract.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useOnrampFunding, type OnrampFundingDeps } from './useOnrampFunding';

const GRACE = 8_000;
const AUTHORITATIVE = 720_000;

function makeDeps(overrides: Partial<OnrampFundingDeps> = {}): OnrampFundingDeps {
  return {
    readBaseline: vi.fn(async () => 0n),
    waitForBalance: vi.fn(async () => {}),
    deposit: vi.fn(async () => {}),
    deriveIdentity: vi.fn(async () => '0xSN'),
    deadlineMs: AUTHORITATIVE,
    graceMs: GRACE,
    ...overrides,
  };
}

const SESSION = { snAddress: '0xSN', targetWei: 5_000_000n, amount: '5' } as const;

afterEach(() => vi.restoreAllMocks());

describe('useOnrampFunding — phase machine', () => {
  it('starts idle with no widget/status/error', () => {
    const { result } = renderHook(() => useOnrampFunding(makeDeps()));
    expect(result.current.phase).toBe('idle');
    expect(result.current.widget).toBeNull();
    expect(result.current.status).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('start → baseline read → widget, then onSettled → poll (DELTA) → deposit', async () => {
    const readBaseline = vi.fn(async () => 100n);
    const waitForBalance = vi.fn<OnrampFundingDeps['waitForBalance']>(async () => {});
    const deposit = vi.fn(async () => {});
    const deps = makeDeps({ readBaseline, waitForBalance, deposit });
    const { result } = renderHook(() => useOnrampFunding(deps));

    act(() => result.current.start({ ...SESSION }));
    await waitFor(() => expect(result.current.phase).toBe('widget'));
    expect(result.current.widget).toEqual({ snAddress: '0xSN', token: expect.any(Number) });

    act(() => result.current.onSettled());
    await waitFor(() => expect(deposit).toHaveBeenCalledTimes(1));
    // The poll is a DELTA against the captured baseline (100n), not an absolute.
    expect(waitForBalance).toHaveBeenCalledWith('0xSN', 5_000_000n, 100n, expect.any(Function), undefined);
    // Deposit uses the frozen session amount + chain.
    expect(deposit).toHaveBeenCalledWith(
      expect.objectContaining({ snAddress: '0xSN', amount: '5' }),
    );
  });

  it('derives when snAddress is null, then reads baseline at the derived address', async () => {
    const deriveIdentity = vi.fn(async () => '0xDERIVED');
    const readBaseline = vi.fn(async () => 0n);
    const deps = makeDeps({ deriveIdentity, readBaseline });
    const { result } = renderHook(() => useOnrampFunding(deps));

    act(() => result.current.start({ snAddress: null, targetWei: 5n, amount: '5' }));
    await waitFor(() => expect(result.current.phase).toBe('widget'));
    expect(deriveIdentity).toHaveBeenCalledTimes(1);
    expect(readBaseline).toHaveBeenCalledWith('0xDERIVED');
    expect(result.current.widget?.snAddress).toBe('0xDERIVED');
  });

  it('derive returning null → error, no widget, no baseline read', async () => {
    const deriveIdentity = vi.fn(async () => null);
    const readBaseline = vi.fn(async () => 0n);
    const deps = makeDeps({ deriveIdentity, readBaseline });
    const { result } = renderHook(() => useOnrampFunding(deps));

    act(() => result.current.start({ snAddress: null, targetWei: 5n, amount: '5' }));
    await waitFor(() => expect(result.current.error).toMatch(/sign to derive/i));
    expect(result.current.phase).toBe('idle');
    expect(result.current.widget).toBeNull();
    expect(readBaseline).not.toHaveBeenCalled();
  });

  it('baseline read throws → FAIL CLOSED: error surfaced, no poll, no deposit (no 0n fallback)', async () => {
    const readBaseline = vi.fn(async () => { throw new Error('RPC error'); });
    const deps = makeDeps({ readBaseline });
    const { result } = renderHook(() => useOnrampFunding(deps));

    act(() => result.current.start({ ...SESSION }));
    await waitFor(() => expect(result.current.error).toMatch(/could not read.*balance|try again/i));
    expect(result.current.phase).toBe('idle');
    expect(result.current.widget).toBeNull();
    expect(deps.waitForBalance).not.toHaveBeenCalled();
    expect(deps.deposit).not.toHaveBeenCalled();
  });

  it('main poll rejects → error surfaced (not silent)', async () => {
    const waitForBalance = vi.fn<OnrampFundingDeps['waitForBalance']>(async () => {
      throw new Error('Card funding timed out');
    });
    const deps = makeDeps({ waitForBalance });
    const { result } = renderHook(() => useOnrampFunding(deps));

    act(() => result.current.start({ ...SESSION }));
    await waitFor(() => expect(result.current.phase).toBe('widget'));
    act(() => result.current.onSettled());
    await waitFor(() => expect(result.current.error).toMatch(/timed out/i));
    expect(deps.deposit).not.toHaveBeenCalled();
  });

  it('onCancel (widget) with no funds → grace times out → silent idle, no error, no deposit', async () => {
    const waitForBalance = vi.fn<OnrampFundingDeps['waitForBalance']>(async () => {
      throw new Error('grace timeout');
    });
    const deps = makeDeps({ waitForBalance });
    const { result } = renderHook(() => useOnrampFunding(deps));

    act(() => result.current.start({ ...SESSION }));
    await waitFor(() => expect(result.current.phase).toBe('widget'));
    act(() => result.current.onCancel());
    // grace + background reconcile both reject → clean idle, no error surfaced.
    await waitFor(() => expect(result.current.phase).toBe('idle'));
    expect(result.current.error).toBeNull();
    expect(deps.deposit).not.toHaveBeenCalled();
  });

  it('onCancel → funds land within the grace window → deposit fires (funds win over cancel)', async () => {
    let resolveGrace!: () => void;
    const waitForBalance = vi.fn<OnrampFundingDeps['waitForBalance']>(
      () => new Promise<void>((resolve) => { resolveGrace = () => resolve(); }),
    );
    const deposit = vi.fn(async () => {});
    const deps = makeDeps({ waitForBalance, deposit });
    const { result } = renderHook(() => useOnrampFunding(deps));

    act(() => result.current.start({ ...SESSION }));
    await waitFor(() => expect(result.current.phase).toBe('widget'));
    act(() => result.current.onCancel());
    await waitFor(() => expect(result.current.phase).toBe('grace'));
    await act(async () => { resolveGrace(); await Promise.resolve(); });
    await waitFor(() => expect(deposit).toHaveBeenCalledTimes(1));
    expect(result.current.error).toBeNull();
  });

  it('#179: after the 8s grace times out, a SILENT background poll uses the AUTHORITATIVE remaining window (not 8s); late funds deposit', async () => {
    let resolveBackground!: () => void;
    const waitForBalance = vi
      .fn<OnrampFundingDeps['waitForBalance']>()
      // 1st = foreground grace: deadline is exactly GRACE, then times out.
      .mockImplementationOnce(async (_a, _t, _b, _s, d) => {
        expect(d).toBe(GRACE);
        throw new Error('grace timeout');
      })
      // 2nd = background reconcile: deadline must be > GRACE and <= AUTHORITATIVE.
      .mockImplementationOnce(
        (_a, _t, _b, _s, d) =>
          new Promise<void>((resolve) => {
            expect(d).toBeGreaterThan(GRACE);
            expect(d).toBeLessThanOrEqual(AUTHORITATIVE);
            resolveBackground = () => resolve();
          }),
      );
    const deposit = vi.fn(async () => {});
    const deps = makeDeps({ waitForBalance, deposit });
    const { result } = renderHook(() => useOnrampFunding(deps));

    act(() => result.current.start({ ...SESSION }));
    await waitFor(() => expect(result.current.phase).toBe('widget'));
    act(() => result.current.onCancel());

    // After the grace times out the UI is RELEASED to idle while the background poll
    // is still pending (no freeze, no error).
    await waitFor(() => expect(waitForBalance).toHaveBeenCalledTimes(2));
    expect(result.current.phase).toBe('idle');
    expect(result.current.error).toBeNull();
    expect(deposit).not.toHaveBeenCalled();

    // Late card delivery lands on the background poll → deposit fires.
    await act(async () => { resolveBackground(); await Promise.resolve(); });
    await waitFor(() => expect(deposit).toHaveBeenCalledTimes(1));
  });

  it('close() while polling does NOT abort the in-flight settlement (funds not dropped)', async () => {
    let resolvePoll!: () => void;
    const waitForBalance = vi.fn<OnrampFundingDeps['waitForBalance']>(
      () => new Promise<void>((resolve) => { resolvePoll = () => resolve(); }),
    );
    const deposit = vi.fn(async () => {});
    const deps = makeDeps({ waitForBalance, deposit });
    const { result } = renderHook(() => useOnrampFunding(deps));

    act(() => result.current.start({ ...SESSION }));
    await waitFor(() => expect(result.current.phase).toBe('widget'));
    act(() => result.current.onSettled()); // → polling
    act(() => result.current.close()); // modal dismissed mid-poll — must not abort
    await act(async () => { resolvePoll(); await Promise.resolve(); });
    await waitFor(() => expect(deposit).toHaveBeenCalledTimes(1));
  });

  it('close() while widget → grace path; funds landing → deposit (funds win over close)', async () => {
    let resolveGrace!: () => void;
    const waitForBalance = vi.fn<OnrampFundingDeps['waitForBalance']>(
      () => new Promise<void>((resolve) => { resolveGrace = () => resolve(); }),
    );
    const deposit = vi.fn(async () => {});
    const deps = makeDeps({ waitForBalance, deposit });
    const { result } = renderHook(() => useOnrampFunding(deps));

    act(() => result.current.start({ ...SESSION }));
    await waitFor(() => expect(result.current.phase).toBe('widget'));
    act(() => result.current.close()); // close while widget → runGrace
    await waitFor(() => expect(result.current.phase).toBe('grace'));
    await act(async () => { resolveGrace(); await Promise.resolve(); });
    await waitFor(() => expect(deposit).toHaveBeenCalledTimes(1));
  });

  it('frozen source chain: deposit receives the chain captured at start, not a later value', async () => {
    const deposit = vi.fn(async () => {});
    const deps = makeDeps({ deposit });
    const { result } = renderHook(() => useOnrampFunding(deps));

    act(() => result.current.start({ snAddress: '0xSN', targetWei: 5n, amount: '5', sourceChainId: 80002 }));
    await waitFor(() => expect(result.current.phase).toBe('widget'));
    act(() => result.current.onSettled());
    await waitFor(() => expect(deposit).toHaveBeenCalledTimes(1));
    expect(deposit).toHaveBeenCalledWith(
      expect.objectContaining({ amount: '5', sourceChainId: 80002 }),
    );
  });

  it('supersession: a NEW start() invalidates a pending background poll (no second deposit)', async () => {
    let resolveStaleBackground!: () => void;
    const waitForBalance = vi
      .fn<OnrampFundingDeps['waitForBalance']>()
      // A foreground grace: times out.
      .mockImplementationOnce(async () => { throw new Error('grace timeout'); })
      // A background poll: resolves LATE (after session B starts).
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => { resolveStaleBackground = () => resolve(); }),
      )
      // B poll: immediate resolve.
      .mockImplementation(async () => {});
    const deposit = vi.fn(async () => {});
    const deps = makeDeps({ waitForBalance, deposit });
    const { result } = renderHook(() => useOnrampFunding(deps));

    // Session A: cancel via widget → grace fails → background poll pending.
    act(() => result.current.start({ ...SESSION }));
    await waitFor(() => expect(result.current.phase).toBe('widget'));
    act(() => result.current.onCancel());
    await waitFor(() => expect(waitForBalance).toHaveBeenCalledTimes(2));
    expect(result.current.phase).toBe('idle'); // released

    // Session B: fresh start supersedes A.
    act(() => result.current.start({ ...SESSION }));
    await waitFor(() => expect(result.current.phase).toBe('widget'));
    act(() => result.current.onSettled());
    await waitFor(() => expect(deposit).toHaveBeenCalledTimes(1)); // deposit B

    // Stale A background poll resolves late → no-op (its token is superseded).
    await act(async () => {
      resolveStaleBackground();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(deposit).toHaveBeenCalledTimes(1);
  });
});
