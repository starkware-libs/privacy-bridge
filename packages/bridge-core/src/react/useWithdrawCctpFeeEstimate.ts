// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Debounced CCTP forward-fee estimate for the cash-out / withdraw leg (Starknet →
// EVM destination) — the sibling of useDepositCctpFeeEstimate. Display-only: the UI
// folds these into its net-of-fees breakdown so the user sees what actually lands
// BEFORE signing, but the authoritative fee is still computed by bridge-core's
// cashOut at submit. Fails open (all-zero) on any quote error so a flaky fee service
// never blocks the form.

import { useEffect, useState } from 'react';
import { fetchForwardMaxFee } from '../core/cctpFees.js';
import { config, getEvmCctpDestination } from '../core/config.js';

export type WithdrawCctpFeeEstimate =
  | { status: 'idle'; maxFeeRaw: 0n; forwardFeeRaw: 0n }
  | { status: 'loading'; maxFeeRaw: 0n; forwardFeeRaw: 0n }
  // maxFeeRaw = forwardFee + protocol fee (deducted from the burned amount → the
  // recipient receives amount − maxFeeRaw). forwardFeeRaw = the flat destination-gas
  // component alone, for the "network fee" breakdown line.
  | { status: 'ready'; maxFeeRaw: bigint; forwardFeeRaw: bigint };

const DEBOUNCE_MS = 400;
// Hard cap on the quote: a hung request (one that never resolves OR rejects) must not
// pin the hook on 'loading' forever — the withdraw submit is gated on !loading, so a
// stall would permanently disable the form. On timeout we abort the fetch and fail
// open (ready, maxFee 0n), same as any other quote error (display-only; the on-chain
// forward-floor is the authoritative backstop).
const TIMEOUT_MS = 12_000;

export function useWithdrawCctpFeeEstimate(
  amountRaw: bigint | null,
  destChainId: number,
  opts?: { enabled?: boolean; debounceMs?: number; timeoutMs?: number },
): WithdrawCctpFeeEstimate {
  const enabled = opts?.enabled ?? true;
  const debounceMs = opts?.debounceMs ?? DEBOUNCE_MS;
  const timeoutMs = opts?.timeoutMs ?? TIMEOUT_MS;
  const [estimate, setEstimate] = useState<WithdrawCctpFeeEstimate>({
    status: 'idle',
    maxFeeRaw: 0n,
    forwardFeeRaw: 0n,
  });

  useEffect(() => {
    if (!enabled || amountRaw === null || amountRaw <= 0n) {
      setEstimate({ status: 'idle', maxFeeRaw: 0n, forwardFeeRaw: 0n });
      return;
    }
    const dest = getEvmCctpDestination(destChainId);
    if (!dest) {
      setEstimate({ status: 'idle', maxFeeRaw: 0n, forwardFeeRaw: 0n });
      return;
    }

    setEstimate({ status: 'loading', maxFeeRaw: 0n, forwardFeeRaw: 0n });
    // `settled` guards against a double setState (timeout vs. late fetch resolve) and,
    // once cleanup sets it, against ANY late setState from a superseded run.
    let settled = false;
    const controller = new AbortController();
    const failOpen = (): void => {
      if (settled) return;
      settled = true;
      setEstimate({ status: 'ready', maxFeeRaw: 0n, forwardFeeRaw: 0n }); // display-only.
    };
    const timeoutTimer = setTimeout(() => {
      controller.abort(); // cancel a hung fetch so it can't leak
      failOpen();
    }, debounceMs + timeoutMs);
    const debounceTimer = setTimeout(() => {
      void (async () => {
        try {
          // Starknet (source) → the chosen EVM destination is a FORWARDED route, so
          // fetchForwardMaxFee returns the flat Forwarding-Service fee + protocol bps.
          const quote = await fetchForwardMaxFee(amountRaw, {
            sourceDomain: config.cctp.starknetDomain,
            destDomain: dest.domain,
            fetchImpl: (input, init) => fetch(input, { ...init, signal: controller.signal }),
          });
          if (settled) return;
          settled = true;
          setEstimate({
            status: 'ready',
            maxFeeRaw: quote.maxFee,
            forwardFeeRaw: quote.forwardFee,
          });
        } catch {
          failOpen(); // fail open on error OR abort — display-only.
        }
      })();
    }, debounceMs);

    return () => {
      settled = true;
      controller.abort();
      clearTimeout(debounceTimer);
      clearTimeout(timeoutTimer);
    };
  }, [enabled, amountRaw, destChainId, debounceMs, timeoutMs]);

  return estimate;
}
