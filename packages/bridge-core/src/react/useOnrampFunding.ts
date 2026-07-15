// bridge-core/react — frozen card-on-ramp funding phase machine (Slice E2).
//
// Moves the DepositModal card-on-ramp session/token/isLive machine into a shared
// hook. This path broke THREE times (BUG-1/#193 stale-derive after network switch;
// the stale `eth_chainId` seed-race + `userPickedRef` reopen bug; #189 poll persisted
// across reopen). The invariant those fixes established is carried here VERBATIM:
//
//   • Every session captures a monotonic `token`; `sessionRef.current` holds the live
//     token. Every async continuation (derive, baseline read, poll, grace, deposit)
//     captures its token at start and is a NO-OP unless isLive(token) still holds.
//   • Reopen / cancel / network-switch clears sessionRef, invalidating all in-flight
//     tokens; a stale continuation MUST NOT apply its probe/settlement result.
//   • The on-chain balance DELTA (balance >= baseline + target) is the SOLE truth for
//     "funds landed" — a widget success/close is only a hint of WHEN to check.
//
// bridge-core stays app- and Polymarket-free: the app-specific legs (baseline read,
// the deposit itself, and the identity derive) are INJECTED. The authoritative
// settlement poll (waitForBalance) now DEFAULTS to bridge-core's own
// waitForDepositTokenBalance — the app defines no poll loop — and stays overridable
// only as a test seam. No window / localStorage / secrets here — the raw signature
// never reaches this hook (the injected `deposit` derives keys internally, as
// `moveIntoPool` does).

import { useCallback, useRef, useState } from 'react';
import {
  ONRAMP_CLOSE_GRACE_MS,
  ONRAMP_POLL_DEADLINE_MS,
  waitForDepositTokenBalance,
} from '../core/onrampPoll';

export type OnrampPhase =
  | 'idle'
  | 'baseline' // reading the pre-funding on-chain balance (derive folded in here)
  | 'widget' // funding widget mounted, awaiting the success hint
  | 'polling' // authoritative on-chain balance wait (post success hint)
  | 'grace' // close/cancel: bounded balance check before declaring dismissal
  | 'depositing'; // funds confirmed → deposit running

// Frozen at start(): the derived account (null ⇒ derive first), the target delta, the
// human amount deposited on settlement, and the source chain. The amount/chain are
// frozen so editing the field/picker mid-flow can't diverge the deposit from what was
// actually funded.
export interface OnrampSession {
  snAddress: string | null;
  targetWei: bigint;
  amount: string;
  sourceChainId?: number;
}

// Passed to the injected `deposit` once funds are confirmed on-chain.
export interface OnrampDepositArgs {
  snAddress: string;
  amount: string;
  sourceChainId?: number;
}

export interface OnrampFundingDeps {
  // Pre-funding on-chain deposit-token balance. FAIL CLOSED on throw — a 0n fallback
  // would defeat the delta (a pre-funded account would resolve the poll instantly).
  readBaseline: (snAddress: string) => Promise<bigint>;
  // Authoritative settlement wait: resolves when balance >= baseline + target (DELTA),
  // rejects on timeout. `deadlineMs` bounds it (the grace path passes a short window).
  // OPTIONAL — defaults to bridge-core's own waitForDepositTokenBalance; override only
  // as a test seam (the app passes nothing).
  waitForBalance?: (
    snAddress: string,
    targetWei: bigint,
    baselineWei: bigint,
    onStatus: (m: string) => void,
    deadlineMs?: number,
  ) => Promise<void>;
  // Funds confirmed → run the deposit (app injects makePrivate / moveIntoPool). Its
  // errors are surfaced by the app's own deposit tracker, not this hook.
  deposit: (args: OnrampDepositArgs) => Promise<void>;
  // Derive the identity when start() is called with a null snAddress. Resolves the
  // freshly-derived address (or null on failure — the caller's own status reports it).
  deriveIdentity?: () => Promise<string | null>;
  // Full authoritative poll window, and the short foreground close-grace window.
  // OPTIONAL — default to the SDK constants ONRAMP_POLL_DEADLINE_MS / ONRAMP_CLOSE_GRACE_MS.
  deadlineMs?: number;
  graceMs?: number;
  // Optional copy overrides (defaults below are generic funding messages).
  messages?: Partial<OnrampMessages>;
}

export interface OnrampMessages {
  deriving: string;
  reading: string;
  opening: string;
  grace: string;
  deriveFailed: string;
  baselineFailed: string;
  pollFailed: string;
}

const DEFAULT_MESSAGES: OnrampMessages = {
  deriving: 'Deriving your Starknet account…',
  reading: 'Reading your account balance…',
  opening: 'Opening the card-funding widget…',
  grace: 'Checking whether your card payment landed…',
  deriveFailed: 'Sign to derive your Starknet account, then add funds.',
  baselineFailed: 'Could not read your account balance — please try again.',
  pollFailed: 'Card funding did not complete.',
};

export interface UseOnrampFunding {
  phase: OnrampPhase;
  status: string | null;
  error: string | null;
  // Non-null ONLY in the 'widget' phase — the app mounts its funding widget for it,
  // keyed on `token` so a fresh start after a teardown remounts a clean widget.
  widget: { snAddress: string; token: number } | null;
  // Mint a session and begin (derive→)baseline→widget. Supersedes any prior session.
  start: (session: OnrampSession) => void;
  // Funding widget reported success (a HINT) → start the authoritative poll.
  onSettled: () => void;
  // Funding widget was closed/cancelled → bounded grace balance re-check.
  onCancel: () => void;
  // Funding widget errored → tear down with the message.
  onError: (message: string) => void;
  // Funding widget status passthrough (guarded on the live session).
  onStatus: (message: string) => void;
  // Modal dismissed: widget→grace (give a payment time to land); an in-flight
  // settlement (polling/grace/depositing) is LEFT running so funds are not dropped;
  // otherwise (idle/baseline) tear down silently.
  close: () => void;
  // Hard reset (reopen / network-switch / manual takeover): clears the session so
  // every in-flight token is invalidated and no stale continuation can apply.
  cancel: () => void;
}

interface LiveSession {
  token: number;
  snAddress: string; // resolved (post-derive)
  targetWei: bigint;
  baselineWei: bigint;
  amount: string;
  sourceChainId?: number;
}

export function useOnrampFunding(deps: OnrampFundingDeps): UseOnrampFunding {
  // Latest deps without re-creating the callbacks (mirrors SwapperWidget's ref trick),
  // so start/cancel/etc. keep stable identities and read current injected fns.
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const [phase, setPhaseState] = useState<OnrampPhase>('idle');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [widget, setWidget] = useState<{ snAddress: string; token: number } | null>(null);

  // Authoritative live-session handle (a ref so async continuations read the latest
  // value with no render lag). phaseRef mirrors `phase` synchronously so close() can
  // branch on the CURRENT phase from within an effect that saw a stale snapshot.
  const sessionRef = useRef<LiveSession | null>(null);
  const tokenSeqRef = useRef(0);
  const phaseRef = useRef<OnrampPhase>('idle');
  // TRUE only while the SILENT background reconcile of runGrace is in flight (after the
  // ~8s foreground grace released the UI to idle but KEPT the session live). This
  // disambiguates phase 'idle' — which then means BOTH "truly idle / no session" AND
  // "UI released, background reconcile still polling" — so close() can tell a live
  // background reconcile from a dead session and NOT abort a late card delivery (#179b
  // / #201). A ref (not state) so close()'s synchronous read sees the current value; it
  // must NOT feed the UI (phase/cardInFlight stay released during reconcile). Reset in
  // runGrace's finally, in teardown, in runDeposit, and on start() (a new session
  // supersedes any prior reconcile), so it can never outlive the poll or a supersession.
  const reconcilingRef = useRef(false);

  const setPhase = useCallback((p: OnrampPhase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);

  const msg = (k: keyof OnrampMessages): string =>
    depsRef.current.messages?.[k] ?? DEFAULT_MESSAGES[k];

  // token still owns the flow?
  const isLive = useCallback((token: number) => sessionRef.current?.token === token, []);

  // Tear down to idle. `error` shows a message; `status` leaves a non-error notice.
  const teardown = useCallback(
    (next: { error?: string; status?: string } = {}) => {
      sessionRef.current = null;
      // A teardown ends any background reconcile too: the poll's own isLive(token) check
      // makes it a no-op once sessionRef clears, and this keeps the flag from outliving
      // the session it belonged to.
      reconcilingRef.current = false;
      setWidget(null);
      setPhase('idle');
      setStatus(next.status ?? null);
      setError(next.error ?? null);
    },
    [setPhase],
  );

  // Funds confirmed on-chain → run the deposit. Guarded on token; a stale session is a
  // no-op. Releases the session up front (so cardInFlight frees and a reopen is clean);
  // the app's own deposit tracker takes over from here.
  const runDeposit = useCallback(
    async (session: LiveSession): Promise<void> => {
      if (!isLive(session.token)) return;
      setPhase('depositing');
      setStatus(null);
      sessionRef.current = null;
      // If this deposit was driven by the background reconcile leg, that leg is now done
      // — clear its flag here too (runGrace's finally is isLive-guarded and won't run for
      // this token anymore since sessionRef just cleared).
      reconcilingRef.current = false;
      setWidget(null);
      try {
        await depsRef.current.deposit({
          snAddress: session.snAddress,
          amount: session.amount,
          sourceChainId: session.sourceChainId,
        });
      } finally {
        // Hand back to idle; the app surfaces deposit progress/errors via its tracker.
        if (phaseRef.current === 'depositing') setPhase('idle');
      }
    },
    [isLive, setPhase],
  );

  // Authoritative settlement wait, then deposit. The balance DELTA is the sole truth;
  // the success hint only decides WHEN to start. Every branch re-checks isLive.
  const runPollThenDeposit = useCallback(
    async (session: LiveSession, deadlineMs?: number): Promise<void> => {
      try {
        await (depsRef.current.waitForBalance ?? waitForDepositTokenBalance)(
          session.snAddress,
          session.targetWei,
          session.baselineWei,
          (m) => {
            if (isLive(session.token)) setStatus(m);
          },
          deadlineMs,
        );
        await runDeposit(session);
      } catch (err) {
        if (!isLive(session.token)) return; // dismissed mid-poll — abandon quietly.
        teardown({ error: err instanceof Error ? err.message : msg('pollFailed') });
      }
    },
    [isLive, runDeposit, teardown],
  );

  // Close/cancel resolution (two phases, #179): a VISIBLE foreground grace catches a
  // payment that already settled; on its timeout we RELEASE the UI to idle but KEEP
  // the session live and keep polling SILENTLY for the remainder of the authoritative
  // window (a slow card can still land). Every branch is isLive(token)-guarded so a
  // supersession/reopen turns this into a no-op.
  const runGrace = useCallback(
    async (token: number): Promise<void> => {
      const session = sessionRef.current;
      if (!session || session.token !== token) return; // already settled elsewhere.
      const graceStart = Date.now();
      setPhase('grace');
      setStatus(msg('grace'));
      try {
        await (depsRef.current.waitForBalance ?? waitForDepositTokenBalance)(
          session.snAddress,
          session.targetWei,
          session.baselineWei,
          () => {},
          depsRef.current.graceMs ?? ONRAMP_CLOSE_GRACE_MS,
        );
        await runDeposit(session); // funds landed within grace → deposit.
        return;
      } catch {
        if (!isLive(token)) return; // superseded/reopened during the grace.
      }
      // Foreground grace elapsed with no delta — NOT a "cancelled" verdict. Release the
      // UI (idle, session stays live) and keep polling silently for the remainder. Mark
      // the reconcile in flight so a modal close during this leg is recognised as
      // "settlement in flight — do NOT abort" (phase is 'idle', so close()'s other
      // in-flight branch would miss it) — the #179b/#201 late-delivery gap.
      setPhase('idle');
      setStatus(null);
      reconcilingRef.current = true;
      try {
        const remaining = Math.max(
          0,
          (depsRef.current.deadlineMs ?? ONRAMP_POLL_DEADLINE_MS) - (Date.now() - graceStart),
        );
        await (depsRef.current.waitForBalance ?? waitForDepositTokenBalance)(
          session.snAddress,
          session.targetWei,
          session.baselineWei,
          () => {},
          remaining,
        );
        if (isLive(token)) await runDeposit(session); // late funds landed.
      } catch {
        if (isLive(token)) teardown(); // genuine dismissal → silent idle.
      } finally {
        // The background reconcile is over (funded, timed out, or superseded). Clear the
        // flag so a later close can't mistake a dead session for a live reconcile. Guard
        // on isLive: if a NEW session superseded this one mid-poll, its own start() owns
        // the flag — only the still-owning token resets it here.
        if (isLive(token)) reconcilingRef.current = false;
      }
    },
    [isLive, runDeposit, setPhase, teardown],
  );

  // Resolve the identity (if needed) and read the on-chain baseline, then open the
  // widget. Every await re-checks isLive so a cancel/reopen mid-flight is a no-op.
  const beginBaseline = useCallback(
    async (session: LiveSession, initialSnAddress: string | null): Promise<void> => {
      const { token } = session;
      setPhase('baseline');
      let sn = initialSnAddress;
      if (!sn) {
        setStatus(msg('deriving'));
        try {
          sn = depsRef.current.deriveIdentity ? await depsRef.current.deriveIdentity() : null;
        } catch {
          sn = null; // deriveIdentity reports its own status; treat as failure here.
        }
        if (!isLive(token)) return; // cancelled/reopened mid-derive → bail.
        if (!sn) {
          teardown({ error: msg('deriveFailed') });
          return;
        }
        session.snAddress = sn;
      }
      setStatus(msg('reading'));
      let baselineWei: bigint;
      try {
        baselineWei = await depsRef.current.readBaseline(sn);
      } catch {
        if (!isLive(token)) return;
        teardown({ error: msg('baselineFailed') }); // FAIL CLOSED — no 0n fallback.
        return;
      }
      if (!isLive(token)) return; // cancelled during the baseline read.
      session.baselineWei = baselineWei;
      setPhase('widget');
      setStatus(msg('opening'));
      setWidget({ snAddress: sn, token });
    },
    [isLive, setPhase, teardown],
  );

  const start = useCallback(
    (session: OnrampSession): void => {
      // Supersede any prior session (invalidates its in-flight tokens) and mint a new
      // one synchronously, before any await, so a concurrent start can't overlap.
      sessionRef.current = null;
      // A new session supersedes any prior background reconcile by definition — reset
      // the flag so a stale-true left by an overwritten (never-torn-down) reconcile
      // can't no-op a later close of THIS session mid-flight (#179b/#201 Case 3a).
      reconcilingRef.current = false;
      setError(null);
      setStatus(null);
      const token = ++tokenSeqRef.current;
      const live: LiveSession = {
        token,
        snAddress: session.snAddress ?? '',
        targetWei: session.targetWei,
        baselineWei: 0n,
        amount: session.amount,
        sourceChainId: session.sourceChainId,
      };
      sessionRef.current = live;
      void beginBaseline(live, session.snAddress);
    },
    [beginBaseline],
  );

  const onSettled = useCallback((): void => {
    const session = sessionRef.current;
    if (!session || !isLive(session.token)) return;
    setPhase('polling');
    void runPollThenDeposit(session);
  }, [isLive, runPollThenDeposit, setPhase]);

  const onCancel = useCallback((): void => {
    const session = sessionRef.current;
    if (!session || !isLive(session.token)) return;
    // A close AFTER a success hint (polling/grace) must not pre-empt the settlement.
    if (phaseRef.current === 'polling' || phaseRef.current === 'grace') return;
    void runGrace(session.token);
  }, [isLive, runGrace]);

  const onError = useCallback(
    (message: string): void => {
      const session = sessionRef.current;
      if (!session || !isLive(session.token)) return;
      teardown({ error: message });
    },
    [isLive, teardown],
  );

  const onStatus = useCallback(
    (message: string): void => {
      const session = sessionRef.current;
      if (session && isLive(session.token)) setStatus(message);
    },
    [isLive],
  );

  const close = useCallback((): void => {
    const live = sessionRef.current;
    if (live && phaseRef.current === 'widget') {
      // Closed while the widget was mounted but BEFORE a success hint — give the
      // payment a bounded grace to land rather than dropping it.
      void runGrace(live.token);
    } else if (
      live &&
      (phaseRef.current === 'polling' ||
        phaseRef.current === 'grace' ||
        phaseRef.current === 'depositing')
    ) {
      // An in-flight settlement — a modal close must NOT abort it (funds win).
    } else if (live && reconcilingRef.current) {
      // The foreground grace timed out and released the UI to idle, but a SILENT
      // background reconcile is still polling for a late card delivery (phase is 'idle'
      // here, so the branch above misses it). A modal close must NOT abort it: the
      // background poll owns the session and will fund on a delta or tear down on its
      // deadline. Tearing it down here would abandon a payment still in flight — the
      // exact #179/#201 failure class this two-phase reconcile closes.
    } else {
      teardown();
    }
  }, [runGrace, teardown]);

  const cancel = useCallback((): void => {
    teardown();
  }, [teardown]);

  return {
    phase,
    status,
    error,
    widget,
    start,
    onSettled,
    onCancel,
    onError,
    onStatus,
    close,
    cancel,
  };
}
