/**
 * Shared resume/recovery detection for both bridge directions (Phase 2 of the
 * resume refactor). Reads the ONE in-flight transfer
 * for the derived identity via bridge-core's getBridgeTransferStatus and, for a
 * matching direction, drives it to completion through resumeBridgeTransfer.
 *
 * The bug this closes: pressing "Move Into Pool" with a stale pool-deposit cursor
 * silently deposited a tiny leftover with no burn. bridge-core now fails closed
 * (PENDING_POOL_DEPOSIT / a persisted cursor); this hook is the UX that DETECTS the
 * stuck transfer and CONTINUES it instead of showing the normal action.
 *
 * State-machine discipline (code-style.md):
 *   - `resuming` is an EXPLICIT boolean, never a sticky 'pending' status that can't
 *     flip back to idle.
 *   - A run-generation counter (runGenRef) is bumped on every identity/network change;
 *     EVERY shared-state write is gated on it, so a resume that resolves LATE — after
 *     the account switched — is a full no-op and can't repaint the new account's UI
 *     (the cross-account leak class from BUG-1).
 *   - A ran-for-this-cursor guard (ranForRef) makes auto-continue fire exactly ONCE
 *     per distinct detected cursor, so the auto-continue effect can't loop.
 *
 * Auto-continue is limited to the from-pool DEFERRED pair (cctp-mint-out / cash-out),
 * which the router DISMISSES as a fail-closed no-op. The into-pool WIRED phases
 * (cctp-mint-in / pool-deposit) and return-to-pool wait for an EXPLICIT Continue click
 * (see isAutoContinuablePhase). needsSignature===true (a future PRE-burn cursor) is also
 * left for a manual click. The raw signature is only fetched when a resume actually runs.
 *
 * Secret hygiene: the raw signature is fetched lazily and passed straight through to
 * bridge-core; it is never logged or persisted here.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getBridgeTransferStatusAsync,
  resumeBridgeTransfer,
  type BridgeDirection,
  type BridgePhase,
  type BridgeTransferStatus,
} from '@starkware-libs/starknet-privacy-bridge';
import type { EthereumProvider } from '@starkware-libs/starknet-privacy-bridge/react';

const USDC_DECIMALS = 6;

// Dev-only tracing (VITE_DEBUG) for diagnosing resume/Continue behavior. Logs the
// detected cursor + every resume() decision so a "Continue does nothing" report is
// grounded in the actual control flow (mirrored to the log sink). No secrets: only
// public cursor fields (phase, amount, addresses). Compiled out when VITE_DEBUG≠true.
const RESUME_DEBUG = import.meta.env.VITE_DEBUG === 'true';
const CURSOR_KEYS = [
  'pmp.inflightDeposit',
  'pmp.inflightPoolDeposit',
  'pmp.inflightReturn',
  'pmp.inflightBurn',
  'pmp.inflightCashOut',
] as const;
function rdbg(msg: string, extra?: Record<string, unknown>): void {
  if (!RESUME_DEBUG) return;
  let cursors: Record<string, unknown> | undefined;
  try {
    cursors = {};
    for (const k of CURSOR_KEYS) {
      const raw = localStorage.getItem(k);
      if (raw) cursors[k] = JSON.parse(raw);
    }
  } catch {
    /* ignore */
  }
  console.debug(`[resume] ${msg}`, { ...extra, cursors });
}

/** True iff `err` is bridge-core's typed NOT_YET_RESUMABLE (deferred from-pool phases). */
export function isNotYetResumable(err: unknown): err is Error & { code: 'NOT_YET_RESUMABLE'; phase: BridgePhase } {
  return (
    err instanceof Error && (err as { code?: string }).code === 'NOT_YET_RESUMABLE'
  );
}

/** True iff `err` is moveIntoPool's typed PENDING_POOL_DEPOSIT fail-closed. */
export function isPendingPoolDeposit(err: unknown): err is Error & { code: 'PENDING_POOL_DEPOSIT'; pendingNetWei: bigint } {
  return err instanceof Error && (err as { code?: string }).code === 'PENDING_POOL_DEPOSIT';
}

/**
 * Human-readable amount for a detected transfer (deposit-token base units → USDC),
 * rounded to the nearest cent (2 dp) for display. DISPLAY-ONLY — used solely in the
 * resume-banner copy; never fed back into value math.
 */
export function formatResumeAmount(amountWei: bigint): string {
  return (Number(amountWei) / 10 ** USDC_DECIMALS).toFixed(2);
}

/** Short label for the stuck phase, for the Continue affordance. */
export function phaseLabel(phase: BridgePhase): string {
  switch (phase) {
    case 'cctp-mint-in':
      return 'depositing (awaiting CCTP mint)';
    case 'pool-deposit':
      return 'depositing into the pool';
    case 'return-to-pool':
      return 'returning to the pool';
    case 'cctp-mint-out':
      return 'withdrawing (awaiting CCTP mint)';
    case 'cash-out':
      return 'cashing out';
    default:
      return phase;
  }
}

// Stable identity of a detected cursor — auto-continue fires once per distinct value.
function cursorKey(s: BridgeTransferStatus): string {
  return [s.direction, s.phase, s.amountWei.toString(), s.account.snAddress ?? '', s.account.evmAddress ?? ''].join('|');
}

// Which detected phases may AUTO-continue (fire without a user click), vs which require
// an EXPLICIT Continue click. A page refresh mounts BOTH panels, so any cursor left in
// localStorage — including a STALE one from a prior, unrelated session — is auto-detected
// on load; firing a resume for such a cursor without user intent is the class of bug we
// guard against (the reported spurious auto-withdrawal, tx 0x7ff3c324). We therefore
// auto-continue ONLY the from-pool DEFERRED pair, and require an explicit click otherwise:
//   - `cctp-mint-out` / `cash-out` (from-pool): bridge-core's router DEFERS these
//     (NOT_YET_RESUMABLE) and the hook DISMISSES them to the normal form — a fail-closed
//     no-op that moves NO value (the tested double-burn guard). Auto-firing them is safe
//     and merely returns the panel to its blank form, so they STAY auto-continuable.
//   - `cctp-mint-in` / `pool-deposit` (into-pool deposit WIRED phases): NOW require an
//     EXPLICIT Continue click. Continuing is still idempotent/safe — the sole irreversible
//     step (the user's own EVM burn) already committed, and the resume attests/mints/
//     deposits, NEVER re-burns — but we surface it as a "Continue deposit" button rather
//     than firing automatically, for parity with the web app's DepositModal (which waits
//     for a click) and to give the user explicit control over when the deposit resumes.
//   - `return-to-pool` (into-pool): its resume (recoverBridgeIn) submits a proven,
//     VALUE-MOVING pool claim, so it must never fire automatically off a stale/unrelated
//     cursor. Click-only, unchanged.
// This only changes WHEN the into-pool phases resume (on click vs automatically); it never
// lets a value-moving action fire off a stale cursor without intent — the double-burn /
// stale-cursor safety reasoning (the run-generation gate, the superseded-run abort, the
// fail-closed dismiss of deferred phases) is preserved in full.
function isAutoContinuablePhase(phase: BridgePhase): boolean {
  return phase === 'cctp-mint-out' || phase === 'cash-out';
}

export interface BridgeResumeConfig {
  /** Only surface a transfer whose direction matches this panel. */
  direction: BridgeDirection;
  /** Derived identity — the cursor keys. Recheck runs whenever these change. */
  snAddress?: string;
  evmAddress?: string;
  /** Network epoch; a testnet↔mainnet swap bumps it → rescan for the new network. */
  epoch: number;
  /** Lazy raw wallet signature (in-memory only). Called only when a resume runs. */
  getSignature: () => Promise<string>;
  /** EVM provider — the into-pool composite structurally needs it (no new signature). */
  getProvider?: () => EthereumProvider | undefined;
  /** Per-account index for a return-to-pool resume (re-derives the commitment). */
  accountIndex?: number;
  /** Progress callback for the resume legs. */
  onStep?: (step: string, status: string, detail?: string) => void;
}

export interface BridgeResume {
  /** The in-flight transfer for this direction, or null when nothing is stuck. */
  status: BridgeTransferStatus | null;
  /** True while a resume is actively running (explicit — never a sticky status). */
  resuming: boolean;
  /**
   * True once a resume reached WIRED completion (cursor cleared). Lets the panel show a
   * persistent "✓ completed" confirmation instead of silently reverting to the blank
   * form. Reset on identity/network change or a fresh resume. Never set for a DEFERRED
   * (from-pool) phase — those are DISMISSED (fail-closed, no auto-burn), not completed.
   */
  completed: boolean;
  /** Latest resume error, or null. A manual Continue can retry after an error. */
  error: string | null;
  /** Latest progress detail from the resume legs (presentation only). */
  step: string | null;
  /**
   * Trigger a resume of the detected transfer. Auto-continue calls this with no
   * argument (fires once per cursor); a manual Continue click passes `true` to force
   * a retry past the once-guard. Either way, an in-flight resume blocks a second run.
   */
  resume: (manual?: boolean) => void;
  /** Re-read the cursors — call after a fresh flow settles or fails closed. */
  recheck: () => void;
}

export function useBridgeResume(cfg: BridgeResumeConfig): BridgeResume {
  const { direction, snAddress, evmAddress, epoch } = cfg;

  const [status, setStatus] = useState<BridgeTransferStatus | null>(null);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  // A resume that reached WIRED completion (the cursor was cleared). Distinct from
  // "nothing pending": after a resume finishes, the detected status flips to null and
  // the panel would otherwise show the blank normal form — indistinguishable from
  // "never had anything to resume". This flag lets the UI show a persistent
  // "✓ completed" confirmation instead. Survives the completion recheck (only reset on
  // an identity/network change or a fresh resume), so it does NOT clear the instant the
  // cursor read returns null.
  const [completed, setCompleted] = useState(false);
  const [recheckToken, setRecheckToken] = useState(0);

  // Run-generation: bumped on every identity/network change AND recheck; a stale
  // resume closure gates every write on the generation it started under.
  const runGenRef = useRef(0);
  // The cursor key AUTO-continue has already fired for (prevents the detect→recheck
  // loop from re-triggering). NB: this guards ONLY auto-continue — a manual Continue
  // click bypasses it (see resume()), because a run that COMPLETES/DEFERS without
  // clearing its cursor leaves the same key detected forever, and an auto-only guard
  // would then brick the manual button (observed: "Continue does nothing").
  const ranForRef = useRef<string | null>(null);
  // True while a resume is actively in flight — the concurrency guard shared by BOTH
  // auto and manual triggers so a click during an in-flight resume can't double-run.
  // Released ONLY in the resume's `finally` (never by an effect): the detect effect must
  // not force it false mid-flight, or a manual Continue could start a 2nd resume on the
  // same cursor while the first is still executing (Bugbot HIGH double-run).
  const resumingRef = useRef(false);
  // Latest config + status, readable from the stable resume() closure.
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const statusRef = useRef<BridgeTransferStatus | null>(null);

  const recheck = useCallback(() => setRecheckToken((t) => t + 1), []);

  // Detect: re-read the cursors on identity/direction/network change + on recheck.
  // A change here is a NEW run generation — a late resume from the previous identity
  // must not write onto it.
  //
  // The in-flight/concurrency guard (resumingRef) is DELIBERATELY not reset here: forcing
  // it false while an earlier resumeBridgeTransfer is still awaiting would drop the guard
  // mid-flight and let a manual Continue start a SECOND resume on the same cursor (Bugbot
  // HIGH double-run). The guard is released SOLELY in the resume's own `finally`, so only
  // one resume is ever in flight per hook instance; a genuine identity switch is handled
  // by runGen gating (a stale run's writes AND its bridge-core value call become no-ops)
  // rather than by dropping the guard out from under an in-flight resume.
  useEffect(() => {
    runGenRef.current += 1;
    setResuming(false);
    setError(null);
    setStep(null);
    // Async: getBridgeTransferStatusAsync falls back to an on-chain balance read when NO
    // cursor is present (fresh browser / cleared storage), so an interrupted deposit whose
    // CCTP mint landed still surfaces. Gate the post-await writes on the run generation:
    // a late chain read for a since-switched identity/network is a full no-op (BUG-1).
    const myGen = runGenRef.current;
    void getBridgeTransferStatusAsync({ snAddress, evmAddress }).then((detected) => {
      if (runGenRef.current !== myGen) return;
      const mine = detected && detected.direction === direction ? detected : null;
      statusRef.current = mine;
      setStatus(mine);
      rdbg('detect', {
        panel: direction,
        snAddress,
        evmAddress,
        detectedPhase: detected?.phase,
        detectedDirection: detected?.direction,
        mine: mine ? { phase: mine.phase, amountWei: mine.amountWei.toString() } : null,
        gen: myGen,
      });
    });
  }, [direction, snAddress, evmAddress, epoch, recheckToken]);

  // Clear the "✓ completed" confirmation ONLY on an identity/network change — NOT on
  // recheckToken (the completion path rechecks itself, and that must not wipe the very
  // confirmation it just set). A fresh resume also clears it (in resume() below).
  useEffect(() => {
    setCompleted(false);
  }, [direction, snAddress, evmAddress, epoch]);

  const resume = useCallback((manual = false) => {
    const c = cfgRef.current;
    const st = statusRef.current;
    if (!st) {
      rdbg('resume() SKIP: no detected status');
      return;
    }
    const key = cursorKey(st);
    // Concurrency guard (BOTH triggers): never start a second resume while one is
    // in flight — a click during an in-flight resume must not double-run.
    if (resumingRef.current) {
      rdbg('resume() SKIP: already resuming', { phase: st.phase, manual });
      return;
    }
    // AUTO-continue fires at most once per cursor (stops the detect→recheck loop from
    // re-triggering). A MANUAL click is an explicit retry and ALWAYS proceeds: without
    // this, a run that completed/deferred WITHOUT clearing its cursor leaves the same
    // key detected forever, and the once-guard would brick the button ("Continue does
    // nothing"). A manual click also RESETS the guard so a later auto-detect can fire.
    if (!manual && ranForRef.current === key) {
      rdbg('resume() SKIP: once-guard (auto already ran for this cursor)', { phase: st.phase, key });
      return;
    }
    ranForRef.current = key;
    resumingRef.current = true;
    rdbg('resume() START', { phase: st.phase, direction: st.direction, key, manual });

    const myGen = runGenRef.current;
    // Gate EVERY shared-state write on the generation this run started under.
    const write = (fn: () => void): void => {
      if (runGenRef.current === myGen) fn();
    };

    write(() => {
      setResuming(true);
      setError(null);
      // A new attempt supersedes any prior "✓ completed" confirmation.
      setCompleted(false);
    });

    void (async () => {
      try {
        const sig = (await c.getSignature()) as `0x${string}`;
        // SUPERSEDED-run gate (BUG-1, extended to the VALUE call): if the identity/network
        // switched while we awaited the signature, this run is stale — abort as a FULL
        // no-op. `write` already gates shared STATE, but the in-flight resumeBridgeTransfer
        // reads the identity-scoped `c.getSignature` (whose closure re-signs against the
        // LIVE wallet once the account-change cache-wipe hits), so calling bridge-core now
        // would resume the PREVIOUS account's persisted cursor with the NEW wallet's
        // signature — a cross-account value-path action / unlinkability break. Capturing
        // `st`/`c`/`myGen` at resume start + this gate makes a superseded run touch NEITHER
        // shared state NOR bridge-core. `finally` still releases the concurrency guard.
        if (runGenRef.current !== myGen) {
          rdbg('resume() SUPERSEDED after getSignature → abort (no bridge-core call)', { phase: st.phase });
          return;
        }
        try {
          await resumeBridgeTransfer({
            status: st,
            signature: sig,
            accountIndex: c.accountIndex,
            provider: c.getProvider?.(),
            onStep: (s, ss, d) => {
              write(() => setStep(d ? `${s}: ${d}` : s));
              c.onStep?.(s, ss, d);
            },
          });
          // Completed — re-read the cursors (the resumed one should now be cleared).
          // GATED: a superseded run (account switched mid-resume) must not flip shared
          // state OR trigger a detect for the new generation (F-C / BUG-1).
          rdbg('resume() COMPLETE (wired) → recheck', { phase: st.phase });
          write(() => {
            setResuming(false);
            // Persistent confirmation — survives the recheck below (setCompleted is only
            // reset on identity/network change or a fresh resume, not on recheckToken).
            setCompleted(true);
            recheck();
          });
        } catch (err) {
          if (isNotYetResumable(err)) {
            rdbg('resume() DEFERRED (NOT_YET_RESUMABLE) → dismiss (fail-closed, no auto-burn)', {
              phase: st.phase,
            });
            // Deferred phase (from-pool): bridge-core's router can't drive it off its
            // minimal args. FAIL CLOSED — just DISMISS the detected status so the panel
            // falls back to its normal form; the user re-initiates with explicit intent.
            // We must NEVER auto-start a fresh burn here (Bugbot HIGH double-burn): the
            // from-pool flow (bridgeOutToWallet) persists no cursor to "complete", and
            // auto-submitting could start a SECOND pool burn while an earlier withdrawal
            // is still in flight. `write` gates on the run generation, so a superseded
            // run (account switched mid-resume) is a full no-op (F-C / F-E).
            write(() => {
              setResuming(false);
              statusRef.current = null;
              setStatus(null);
              recheck();
            });
            return;
          }
          throw err;
        }
      } catch (err) {
        // Allow a manual Continue retry: clear the ran-for guard so resume() re-runs —
        // but ONLY for the CURRENT run. A superseded run clearing ranForRef would defeat
        // the NEWER run's once-guard → a second concurrent resume (F-C / BUG-1).
        rdbg('resume() ERROR → cleared once-guard (retryable)', {
          message: err instanceof Error ? err.message : String(err),
        });
        write(() => {
          ranForRef.current = null;
          setResuming(false);
          setError(err instanceof Error ? err.message : 'Resume failed.');
        });
      } finally {
        // Release the concurrency guard on EVERY exit path (complete / defer / error /
        // superseded-gen early-return) so a later manual click or auto-detect can run.
        // This is the SOLE releaser — no effect resets it, so it can only ever clear the
        // one in-flight resume's own guard (no overlap ⇒ no cross-run ownership race).
        resumingRef.current = false;
      }
    })();
  }, [recheck]);

  // Auto-continue: a detected transfer that needs NO new signature AND whose phase is
  // safe to auto-continue (isAutoContinuablePhase — the from-pool DEFERRED pair only)
  // resumes itself once. The into-pool WIRED phases (cctp-mint-in / pool-deposit),
  // `return-to-pool`, and a future needsSignature===true pre-burn cursor all wait for an
  // EXPLICIT Continue click, so a stale/unrelated cursor detected on a refresh can never
  // resume without user intent (the spurious auto-resume bug).
  useEffect(() => {
    if (!status || status.needsSignature) return;
    if (!isAutoContinuablePhase(status.phase)) return;
    resume();
  }, [status, resume]);

  return { status, resuming, completed, error, step, resume, recheck };
}
