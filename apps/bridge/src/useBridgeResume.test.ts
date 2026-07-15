// Resume/recovery behavior for the bridge panels.
//
// Model (post into-pool click-to-continue change):
//   - The into-pool WIRED phases (cctp-mint-in / pool-deposit) and return-to-pool are
//     SURFACED as an interrupted-transfer banner but NEVER auto-fire — they resume only on
//     an explicit Continue click. Continuing an into-pool deposit is idempotent/safe (the
//     burn already committed), but we surface it as a button for parity with the web app's
//     DepositModal and to give the user explicit control.
//   - The from-pool DEFERRED pair (cctp-mint-out / cash-out) still auto-continues; the
//     router DISMISSES it (NOT_YET_RESUMABLE) back to the blank form — a fail-closed no-op
//     that moves NO value.
//
// A manual click (resume(true)) always bypasses the once-per-cursor guard (which only
// gates the automatic path), so a run that COMPLETES/DEFERS without clearing its cursor
// can still be retried — the "Continue does nothing" brick (2026-07-08) stays fixed.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const getBridgeTransferStatus = vi.fn();
const resumeBridgeTransfer = vi.fn();

vi.mock('@polymarket-privacy/bridge-core', () => ({
  getBridgeTransferStatus: (...a: unknown[]) => getBridgeTransferStatus(...a),
  // The hook now detects via the async chain-aware reader (#433). Delegate to the same
  // sync spy so every existing mockImplementation/mockReturnValue keeps driving detection.
  getBridgeTransferStatusAsync: (...a: unknown[]) => Promise.resolve(getBridgeTransferStatus(...a)),
  resumeBridgeTransfer: (...a: unknown[]) => resumeBridgeTransfer(...a),
}));

import { useBridgeResume, isNotYetResumable } from './useBridgeResume';

const SN = '0xsn';
const EVM = '0xevm';

// A detected into-pool cursor that the resume never clears (getBridgeTransferStatus
// keeps returning it) — the exact condition that once bricked the manual button.
function makeStatus() {
  return {
    direction: 'into-pool' as const,
    phase: 'cctp-mint-in' as const,
    needsSignature: false,
    amountWei: 1_000_000n,
    account: { snAddress: SN, evmAddress: EVM },
  };
}

function cfg() {
  return {
    direction: 'into-pool' as const,
    snAddress: SN,
    evmAddress: EVM,
    epoch: 0,
    getSignature: vi.fn(async () => `0x${'ab'.repeat(65)}`),
    getProvider: () => undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Fresh object each call so a recheck re-detects the SAME (never-cleared) cursor.
  getBridgeTransferStatus.mockImplementation(() => makeStatus());
  resumeBridgeTransfer.mockResolvedValue({ completed: true, amountWei: 1_000_000n });
});

describe('useBridgeResume — into-pool deposit resumes on an explicit click, not automatically', () => {
  it('surfaces an into-pool cursor WITHOUT auto-firing; a manual click drives it (and retries)', async () => {
    const { result } = renderHook((p) => useBridgeResume(p), { initialProps: cfg() });

    // The interrupted transfer is surfaced for an explicit Continue.
    await waitFor(() => expect(result.current.status?.phase).toBe('cctp-mint-in'));

    // Give auto-continue every chance to (wrongly) fire — it must NOT.
    await new Promise((r) => setTimeout(r, 20));
    expect(resumeBridgeTransfer).not.toHaveBeenCalled();

    // A user clicking "Continue deposit" is an explicit retry — it MUST run.
    await act(async () => {
      result.current.resume(true);
    });
    await waitFor(() => expect(resumeBridgeTransfer).toHaveBeenCalledTimes(1));

    // The cursor is never cleared, so it stays detected — a second manual click must
    // still retry (manual bypasses the once-guard; no "Continue does nothing" brick).
    await act(async () => {
      result.current.resume(true);
    });
    await waitFor(() => expect(resumeBridgeTransfer).toHaveBeenCalledTimes(2));
  });

  // The "✓ completed" confirmation: after a WIRED resume finishes, the cursor clears and
  // the detected status flips to null — but `completed` must stay true so the panel can
  // show a persistent confirmation instead of silently reverting to the blank form
  // (indistinguishable from "nothing was ever pending").
  it('exposes completed=true after a wired resume finishes, and it survives the recheck', async () => {
    // Stateful: the cursor is detected until the resume resolves, then gone. Robust to
    // multiple detect passes (unlike mockReturnValueOnce).
    let cleared = false;
    getBridgeTransferStatus.mockImplementation(() => (cleared ? null : makeStatus()));
    resumeBridgeTransfer.mockImplementation(async () => {
      cleared = true;
      return { completed: true, amountWei: 1_000_000n };
    });

    const { result } = renderHook((p) => useBridgeResume(p), { initialProps: cfg() });

    await waitFor(() => expect(result.current.status?.phase).toBe('cctp-mint-in'));
    await act(async () => {
      result.current.resume(true);
    });
    await waitFor(() => expect(resumeBridgeTransfer).toHaveBeenCalledTimes(1));
    // Confirmation is set AND persists even though the cursor read now returns null.
    await waitFor(() => expect(result.current.completed).toBe(true));
    expect(result.current.status).toBeNull();
    expect(result.current.resuming).toBe(false);
  });

  it('a manual click while a resume is already in flight does not double-run', async () => {
    let release!: () => void;
    resumeBridgeTransfer.mockImplementation(
      () => new Promise((res) => (release = () => res({ completed: true, amountWei: 1_000_000n }))),
    );
    const { result } = renderHook((p) => useBridgeResume(p), { initialProps: cfg() });

    await waitFor(() => expect(result.current.status?.phase).toBe('cctp-mint-in'));

    // Start a resume via an explicit click; it parks (promise not yet resolved).
    await act(async () => {
      result.current.resume(true);
    });
    await waitFor(() => expect(resumeBridgeTransfer).toHaveBeenCalledTimes(1));

    // Clicking again during the in-flight resume must be a no-op (in-flight guard).
    await act(async () => {
      result.current.resume(true);
    });
    expect(resumeBridgeTransfer).toHaveBeenCalledTimes(1);

    // Once it settles, the guard releases (a later click could run again).
    await act(async () => {
      release();
    });
    await waitFor(() => expect(resumeBridgeTransfer).toHaveBeenCalledTimes(1));
  });

  // FINDING 1 (Bugbot HIGH — double-run): the detect effect used to force resumingRef
  // false on EVERY dep change, INCLUDING a same-identity recheck. A recheck firing while
  // an earlier resume is still awaiting dropped the concurrency guard mid-flight, so a
  // manual Continue could start a SECOND resume on the SAME cursor. Fix: the guard is
  // released ONLY in the resume's finally; the detect effect no longer clears it.
  it('a recheck while a resume is in flight must NOT drop the concurrency guard (no double-run)', async () => {
    let release!: () => void;
    resumeBridgeTransfer.mockImplementation(
      () => new Promise((res) => (release = () => res({ completed: true, amountWei: 1_000_000n }))),
    );
    const { result } = renderHook((p) => useBridgeResume(p), { initialProps: cfg() });

    await waitFor(() => expect(result.current.status?.phase).toBe('cctp-mint-in'));

    // Start a resume via an explicit click; it parks (guard held).
    await act(async () => {
      result.current.resume(true);
    });
    await waitFor(() => expect(resumeBridgeTransfer).toHaveBeenCalledTimes(1));

    // An external recheck (same identity) fires the detect effect mid-flight. The
    // in-flight guard must survive it.
    await act(async () => {
      result.current.recheck();
    });
    expect(resumeBridgeTransfer).toHaveBeenCalledTimes(1);

    // A user clicks Continue during the STILL-in-flight resume: the concurrency guard must
    // block it (pre-fix, the recheck had dropped the guard → this started a 2nd resume).
    await act(async () => {
      result.current.resume(true);
    });
    expect(resumeBridgeTransfer).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
    });
  });

  // BUG 2 (unintended value movement): a page refresh mounts BOTH panels, so ANY cursor
  // in localStorage — including a STALE/unrelated one from a prior session — is
  // auto-detected on load. A VALUE-MOVING resume (return-to-pool → recoverBridgeIn, a
  // proven pool claim) must NEVER auto-execute; it stays resumable only via an explicit
  // Continue click. (The into-pool deposit phases are now click-only too — see above.)
  describe('BUG 2 — a stale value-moving return-to-pool cursor is not auto-executed', () => {
    function returnStatus() {
      return {
        direction: 'into-pool' as const,
        phase: 'return-to-pool' as const,
        needsSignature: false,
        amountWei: 1_000_000n,
        account: { snAddress: SN, evmAddress: EVM },
        accountIndex: 3,
      };
    }

    it('does NOT auto-execute a return-to-pool resume; a manual Continue still drives it', async () => {
      getBridgeTransferStatus.mockImplementation(() => returnStatus());
      const { result } = renderHook((p) => useBridgeResume(p), { initialProps: cfg() });

      // Give auto-continue every chance to (wrongly) fire — no bridge-core value call.
      await new Promise((r) => setTimeout(r, 30));
      expect(resumeBridgeTransfer).not.toHaveBeenCalled();
      // The interrupted transfer is still surfaced for an explicit Continue.
      expect(result.current.status?.phase).toBe('return-to-pool');

      // An explicit user Continue click DOES drive it (legitimate resume preserved).
      await act(async () => {
        result.current.resume(true);
      });
      await waitFor(() => expect(resumeBridgeTransfer).toHaveBeenCalledTimes(1));
      expect(resumeBridgeTransfer.mock.calls[0][0].status.phase).toBe('return-to-pool');
    });
  });

  // The from-pool DEFERRED pair is the ONLY auto-continuable case: it auto-fires, the
  // router throws NOT_YET_RESUMABLE, and the hook DISMISSES the status to null (fail-closed
  // no-op, no value moved). This is unchanged by the into-pool click-to-continue change.
  it('a from-pool cctp-mint-out cursor auto-continues then auto-dismisses (fail-closed)', async () => {
    const notYet = Object.assign(new Error('deferred'), {
      code: 'NOT_YET_RESUMABLE',
      phase: 'cctp-mint-out',
    });
    expect(isNotYetResumable(notYet)).toBe(true);
    resumeBridgeTransfer.mockRejectedValue(notYet);
    // Detected once at mount; after the deferred dismiss + recheck the cursor is gone
    // (the app has no cursor-resume for from-pool), so the panel returns to its form.
    getBridgeTransferStatus
      .mockReturnValueOnce({
        direction: 'from-pool' as const,
        phase: 'cctp-mint-out' as const,
        needsSignature: false,
        amountWei: 1_000_000n,
        account: { snAddress: SN, evmAddress: EVM },
      })
      .mockReturnValue(null);

    const { result } = renderHook((p) => useBridgeResume(p), {
      initialProps: { ...cfg(), direction: 'from-pool' as const },
    });

    // Auto-continue fires for the deferred phase...
    await waitFor(() => expect(resumeBridgeTransfer).toHaveBeenCalledTimes(1));
    // ...and the status is dismissed back to the blank form (no value moved, not completed).
    await waitFor(() => expect(result.current.status).toBeNull());
    expect(result.current.completed).toBe(false);
  });

  // #433: a fresh browser / cleared storage has no cursor, so the async detector falls
  // back to an on-chain residual read and surfaces a pool-deposit status. As an into-pool
  // WIRED phase it is now SURFACED but NOT auto-fired — it waits for a Continue click.
  it('chain-sourced pool-deposit (NO cursor) surfaces WITHOUT auto-firing', async () => {
    getBridgeTransferStatus.mockImplementation(() => ({
      direction: 'into-pool' as const,
      phase: 'pool-deposit' as const,
      needsSignature: false,
      amountWei: 1_000_000n,
      account: { snAddress: SN, evmAddress: EVM },
    }));
    const { result } = renderHook((p) => useBridgeResume(p), { initialProps: cfg() });

    await waitFor(() => expect(result.current.status?.phase).toBe('pool-deposit'));
    // No auto-fire — the deposit waits for an explicit Continue click.
    await new Promise((r) => setTimeout(r, 20));
    expect(resumeBridgeTransfer).not.toHaveBeenCalled();

    // An explicit click drives the (idempotent) deposit resume.
    await act(async () => {
      result.current.resume(true);
    });
    await waitFor(() => expect(resumeBridgeTransfer).toHaveBeenCalledTimes(1));
  });

  // FINDING 2 (Bugbot HIGH — stale cross-account resume): shared-state writes are gated on
  // runGenRef, but the in-flight resumeBridgeTransfer still ran with the LIVE identity's
  // signature against the PREVIOUS account's persisted cursor when the account switched
  // mid-flight — a cross-account value-path action / unlinkability break. Fix: after the
  // (captured) getSignature resolves, abort as a FULL no-op if the run generation changed.
  it('a superseded (account-switched mid-flight) resume neither writes shared state nor calls bridge-core', async () => {
    let releaseSig!: (s: string) => void;
    const sigGate = new Promise<string>((res) => (releaseSig = res));
    const getSignature = vi.fn(() => sigGate);
    const initial = { ...cfg(), getSignature };

    const { result, rerender } = renderHook((p) => useBridgeResume(p), { initialProps: initial });

    await waitFor(() => expect(result.current.status?.phase).toBe('cctp-mint-in'));

    // An explicit click starts the resume; it parks awaiting the signature — bridge-core
    // has NOT been called yet.
    await act(async () => {
      result.current.resume(true);
    });
    await waitFor(() => expect(getSignature).toHaveBeenCalledTimes(1));
    expect(resumeBridgeTransfer).not.toHaveBeenCalled();

    // Account switches mid-flight: a genuine identity change bumps the run generation.
    // The new identity has nothing pending.
    getBridgeTransferStatus.mockImplementation(() => null);
    rerender({ ...initial, snAddress: '0xsn2', evmAddress: '0xevm2' });

    // The PREVIOUS account's signature now resolves. The run is SUPERSEDED, so it must be
    // a FULL no-op: no bridge-core value call, no shared-state write onto the new identity.
    await act(async () => {
      releaseSig(`0x${'cd'.repeat(65)}`);
      await Promise.resolve();
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(resumeBridgeTransfer).not.toHaveBeenCalled();
    expect(result.current.completed).toBe(false);
    expect(result.current.status).toBeNull();
  });
});
