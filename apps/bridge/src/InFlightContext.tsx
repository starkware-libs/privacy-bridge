// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

/**
 * In-flight flow aggregation for apps/bridge.
 *
 * FUND-SAFETY: a network switch must be BLOCKED while any value-moving flow is
 * live — a mid-CCTP-burn/mint switch would strand funds (CCTP burn-and-mint
 * requires source+dest on the SAME network).
 * Each flow (MoveIntoPool / MoveFromPool) registers itself here while it is
 * running (signing / running phases) and also while it holds a persisted,
 * unresolved/resumable transfer. NetworkContext.setNetwork consults `anyInFlight`
 * and no-ops when true; the NavBar toggle is disabled with a tooltip.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type InFlightContextValue = {
  /** True while ANY registered flow reports itself in-flight. */
  anyInFlight: boolean;
  /**
   * Report a flow's in-flight state under a stable `id`. Idempotent: calling with
   * the same id + value is a no-op. A flow calls this true while signing/running
   * (or holding a resumable transfer) and false when it settles.
   */
  setFlowInFlight: (id: string, inFlight: boolean) => void;
};

const InFlightContext = createContext<InFlightContextValue | null>(null);

export function InFlightProvider({ children }: { children: ReactNode }) {
  // Set of flow ids currently in-flight. A ref holds the authoritative set; a
  // counter in state drives re-renders (avoids leaking a mutable Set into render).
  const idsRef = useRef<Set<string>>(new Set());
  const [count, setCount] = useState(0);

  const setFlowInFlight = useCallback((id: string, inFlight: boolean) => {
    const ids = idsRef.current;
    const had = ids.has(id);
    if (inFlight && !had) {
      ids.add(id);
      setCount(ids.size);
    } else if (!inFlight && had) {
      ids.delete(id);
      setCount(ids.size);
    }
  }, []);

  const value = useMemo<InFlightContextValue>(
    () => ({ anyInFlight: count > 0, setFlowInFlight }),
    [count, setFlowInFlight],
  );

  return <InFlightContext.Provider value={value}>{children}</InFlightContext.Provider>;
}

export function useInFlight(): InFlightContextValue {
  const ctx = useContext(InFlightContext);
  if (!ctx) throw new Error('useInFlight must be used within InFlightProvider');
  return ctx;
}
