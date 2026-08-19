// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Debounced CCTP forward-fee estimate for the deposit-in leg (EVM source →
// Starknet), moved out of DepositModal — Slice C. Display/guard-only: the
// caller folds `maxFeeRaw` into its own net-of-fees math (e.g. `depositNetMicro`)
// but the actual `moveIntoPool`/`makePrivate(amount)` call is unaffected. Fails
// open (`maxFeeRaw: 0n`) on any quote error so a flaky fee service never blocks
// the UI — mirrors useBridgeFundingEstimate's cancel-on-dep-change guard.

import { useEffect, useState } from 'react';
import { fetchForwardMaxFee } from '../core/cctpFees.js';
import { config, getEvmCctpSource } from '../core/config.js';

export type DepositCctpFeeEstimate =
  | { status: 'idle'; maxFeeRaw: 0n }
  | { status: 'loading'; maxFeeRaw: 0n }
  | { status: 'ready'; maxFeeRaw: bigint };

const DEBOUNCE_MS = 400;

export function useDepositCctpFeeEstimate(
  amountWei: bigint | null,
  sourceChainId: number,
  opts?: {
    // Caller-side gate (e.g. `depositFundingMode === 'metamask'` — treasury
    // deposits never burn/mint so the fee is always 0). Defaults to enabled.
    enabled?: boolean;
    debounceMs?: number;
  },
): DepositCctpFeeEstimate {
  const enabled = opts?.enabled ?? true;
  const debounceMs = opts?.debounceMs ?? DEBOUNCE_MS;
  const [estimate, setEstimate] = useState<DepositCctpFeeEstimate>({
    status: 'idle',
    maxFeeRaw: 0n,
  });

  useEffect(() => {
    if (!enabled || amountWei === null || amountWei <= 0n) {
      setEstimate({ status: 'idle', maxFeeRaw: 0n });
      return;
    }
    const src = getEvmCctpSource(sourceChainId);
    if (!src) {
      setEstimate({ status: 'idle', maxFeeRaw: 0n });
      return;
    }

    // Reset to the fail-open value (0n) at the START of a new quote so a stale
    // amount/chain's fee never lingers into the new one's pending window.
    setEstimate({ status: 'loading', maxFeeRaw: 0n });
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const quote = await fetchForwardMaxFee(amountWei, {
            fast: true,
            sourceDomain: src.domain,
            destDomain: config.cctp.starknetDomain,
          });
          if (cancelled) return;
          setEstimate({ status: 'ready', maxFeeRaw: quote.maxFee });
        } catch {
          if (cancelled) return;
          setEstimate({ status: 'ready', maxFeeRaw: 0n }); // fail open — display/guard-only.
        }
      })();
    }, debounceMs);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, amountWei, sourceChainId, debounceMs]);

  return estimate;
}
