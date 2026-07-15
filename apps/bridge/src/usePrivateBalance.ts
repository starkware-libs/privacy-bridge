/**
 * Live private (in-pool) balance for the connected, derived session.
 *
 * Polls `discoverPrivateBalanceForAddress` (snAddress + viewing key — a read-only
 * lookup) on a short interval so the dashboard reflects deposits/withdrawals as
 * they settle. All the fund-safety / privacy guardrails live here:
 *   - overlap guard: never stack a new discovery on an in-flight one;
 *   - sticky value: a transient poll failure keeps the last good balance;
 *   - stale-result guard (#138): discard a result whose snAddress changed mid-flight;
 *   - visibility gating: pause when the tab is hidden, refetch on return;
 *   - full reset on account / network change (keyed on snAddress + viewingKey + epoch).
 *
 * The viewing key comes from IdentityContext (in-memory only) — this hook never
 * touches the raw signature.
 */

import { useEffect, useState } from 'react';
import { discoverPrivateBalanceForAddress } from '@polymarket-privacy/bridge-core';
import { useIdentity } from './IdentityContext';
import { useNetwork } from './NetworkContext';

// Poll cadence for the live private balance. Tunable — 1s keeps the display
// responsive to settling deposits/withdrawals without hammering the indexer
// (the overlap guard also prevents stacking if a tick runs long).
const PRIVATE_BALANCE_POLL_MS = 1000;

export type PrivateBalanceStatus = 'idle' | 'loading' | 'ready' | 'error';

export type PrivateBalanceState = {
  balance: bigint | null;
  status: PrivateBalanceStatus;
  error?: string;
  lastUpdated: number | null;
};

const IDLE: PrivateBalanceState = { balance: null, status: 'idle', lastUpdated: null };

export function usePrivateBalance(): PrivateBalanceState {
  const { snAddress, viewingKey, deriveStatus } = useIdentity();
  const { networkEpoch } = useNetwork();

  const [state, setState] = useState<PrivateBalanceState>(IDLE);

  const active = deriveStatus.status === 'ready' && !!snAddress && viewingKey != null;

  useEffect(() => {
    if (!active || snAddress == null || viewingKey == null) {
      setState(IDLE);
      return;
    }

    // Derived session: leave `idle` IMMEDIATELY so the UI never shows a "sign to
    // see your private balance" prompt for an already-signed user — even before
    // the first poll runs or while the tab is hidden (polling is paused). `idle`
    // must mean NOT-derived only, never "derived, not yet polled" (Bugbot MED #239).
    setState((s) => (s.status === 'idle' ? { ...s, status: 'loading' } : s));

    // Guard every setState against unmount / account switch (the effect re-runs
    // and cleanup flips this) so a late promise can't write into a dead render.
    let mounted = true;
    // Overlap guard: only one discovery in flight at a time.
    let inFlight = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async (): Promise<void> => {
      if (!mounted || inFlight) return;
      if (document.visibilityState === 'hidden') return;
      inFlight = true;
      // Capture the account this tick is FOR (#138 stale-result guard).
      const tickAddress = snAddress;
      setState((s) => (s.status === 'ready' ? s : { ...s, status: 'loading' }));
      try {
        const balance = await discoverPrivateBalanceForAddress({ snAddress, viewingKey });
        // Discard if unmounted or the account changed while we awaited.
        if (!mounted || tickAddress !== snAddress) return;
        setState({ balance, status: 'ready', lastUpdated: Date.now() });
      } catch (err) {
        if (!mounted || tickAddress !== snAddress) return;
        const message = err instanceof Error ? err.message : 'Failed to read private balance.';
        // Sticky: keep the last good balance; surface the error non-destructively.
        setState((s) => ({ ...s, status: 'error', error: message }));
      } finally {
        inFlight = false;
      }
    };

    const start = (): void => {
      if (timer != null) return;
      void tick(); // immediate first fetch — don't wait a full interval.
      timer = setInterval(() => void tick(), PRIVATE_BALANCE_POLL_MS);
    };
    const stop = (): void => {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        stop();
      } else {
        start();
        void tick(); // refetch immediately on return to foreground.
      }
    };

    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      mounted = false;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // Reset + restart on account, viewing-key, or network change.
  }, [active, snAddress, viewingKey, networkEpoch]);

  return state;
}
