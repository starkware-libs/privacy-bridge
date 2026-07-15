// Debounced bridge-funding quote for the order ticket. The user types a **bet**;
// we compute how much to burn (bet + CCTP fee + swap slippage + cushion + an optional
// generic `extraReserveMicro`, e.g. a downstream order fee) and what lands.

import { useEffect, useState } from 'react';
import {
  bridgeFundingHint,
  fetchBridgeFundingPlan,
  microToHuman,
  type BridgeFundingPlan,
} from '../core/bridgeFunding';
import { config, getEvmCctpSource, getEvmCctpDestination } from '../core/config';

export type BridgeFundingEstimate =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      plan: BridgeFundingPlan;
      betHuman: number;
      fundHuman: number;
      reserveHuman: number;
      /** The caller-supplied extra reserve (e.g. an order fee) in human units. 0 when none. */
      extraReserveHuman: number;
      feeHuman: number;
      projectedOrderHuman: number;
      belowFloor: boolean;
      /** True when the total bridge (bet + reserve) exceeds the caller's `cap` (if given). */
      exceedsCap: boolean;
      /** User-facing message when `exceedsCap`; null otherwise or when no `cap` was given. */
      capError: string | null;
    };

const DEBOUNCE_MS = 400;

/** Optional per-caller cap on the total bridge (`plan.fundMicro`), e.g. a per-order limit. */
export interface BridgeFundingCap {
  amountMicro: bigint;
  symbol: string;
}

export function useBridgeFundingEstimate(
  betWei: bigint | null,
  decimals: number,
  // Optional EVM source chain id (the deposit-in source-chain picker). When set
  // and known, the fee is quoted for the EVM→Starknet route of THAT chain rather
  // than the default (Starknet→Polygon fund-account) route — so the "Bridge reserve"
  // the UI shows and the gross the caller burns match the fee fundFromMetaMask
  // actually deducts (#198). Omitted → default route (apps/web's order ticket, unchanged).
  sourceChainId?: number,
  // Optional cap check on the total funded amount (`plan.fundMicro`) — replaces a
  // caller re-deriving its own cap comparison from the plan (kills the ad-hoc
  // OrderTicket.fundCapError re-derivation).
  //
  // `destChainId` is the OUT-direction counterpart of `sourceChainId`: for a bridge-OUT
  // (pool → EVM), the fee route is Starknet→THAT chain, so the displayed CCTP fee and
  // the gross/burn amount reflect the SELECTED destination (Finding 2). It also makes
  // this the single source of truth the caller can pass as CCTP `max_fee`
  // (`plan.quote.maxFee`) so display and burn agree (Finding 1). sourceChainId and
  // destChainId are mutually-exclusive directions — pass at most one.
  // `extraReserveMicro` is a GENERIC extra USDC reserve (micro) to hold in the wallet
  // on top of the CCTP fee/swap/cushion — e.g. apps/web's Polymarket taker fee.
  // `extraReserveLabel` names it in the funding hint. bridge-core stays app-agnostic.
  opts?: {
    cap?: BridgeFundingCap;
    destChainId?: number;
    extraReserveMicro?: bigint;
    extraReserveLabel?: string;
  },
): BridgeFundingEstimate {
  const [estimate, setEstimate] = useState<BridgeFundingEstimate>({ status: 'idle' });
  const cap = opts?.cap;
  const destChainId = opts?.destChainId;
  const extraReserveMicro = opts?.extraReserveMicro ?? 0n;

  useEffect(() => {
    if (betWei === null || betWei <= 0n) {
      setEstimate({ status: 'idle' });
      return;
    }

    // Resolve the fee route. Two mutually-exclusive directions:
    //   - deposit-in (sourceChainId set): burn EVM→Starknet, so sourceDomain = the
    //     picked chain, destDomain = Starknet;
    //   - bridge-out (destChainId set): burn Starknet→EVM, so destDomain = the picked
    //     chain, sourceDomain defaults (Starknet) inside fetchForwardMaxFee.
    // An unknown chain id → no override → default route (never quote a bogus route).
    const sourceDomain =
      sourceChainId !== undefined ? getEvmCctpSource(sourceChainId)?.domain : undefined;
    const outDestDomain =
      destChainId !== undefined ? getEvmCctpDestination(destChainId)?.domain : undefined;
    const destDomain =
      sourceDomain !== undefined ? config.cctp.starknetDomain : outDestDomain;

    // Invalidate any prior estimate IMMEDIATELY (synchronously) on ANY input change —
    // amount OR source-chain route. Otherwise a stale `ready` (quoted for the PREVIOUS
    // route) lingers through the debounce window and the caller's submit stays enabled,
    // pairing the new sourceChainId with a fundMicro sized for the old route (#198
    // Bugbot: "stale reserve after chain change"). Flipping to `loading` here gates
    // submit until the new quote lands.
    setEstimate({ status: 'loading' });

    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const plan = await fetchBridgeFundingPlan(betWei, {
            sourceDomain,
            destDomain,
            extraReserveMicro,
          });
          if (cancelled) return;
          const exceedsCap = cap !== undefined && plan.fundMicro > cap.amountMicro;
          const capError = exceedsCap
            ? `Total bridge ($${microToHuman(plan.fundMicro, decimals).toFixed(2)} ${cap.symbol}, bet + reserve) exceeds the ${microToHuman(cap.amountMicro, decimals)} ${cap.symbol} cap.`
            : null;
          setEstimate({
            status: 'ready',
            plan,
            betHuman: microToHuman(plan.betMicro, decimals),
            fundHuman: microToHuman(plan.fundMicro, decimals),
            reserveHuman: microToHuman(plan.reserveMicro, decimals),
            extraReserveHuman: microToHuman(plan.extraReserveMicro, decimals),
            feeHuman: microToHuman(plan.quote.maxFee, decimals),
            projectedOrderHuman: microToHuman(plan.projectedOrderMicro, decimals),
            belowFloor: plan.belowFloor,
            exceedsCap,
            capError,
          });
        } catch (err) {
          if (cancelled) return;
          const message = err instanceof Error ? err.message : String(err);
          setEstimate({ status: 'error', message });
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    betWei,
    decimals,
    sourceChainId,
    destChainId,
    cap?.amountMicro,
    cap?.symbol,
    extraReserveMicro,
  ]);

  return estimate;
}

/** User-facing hint for the order ticket. */
export function bridgeFundingEstimateHint(
  estimate: BridgeFundingEstimate,
  decimals: number,
  symbol: string,
  // Forwarded to bridgeFundingHint to label the optional extra-reserve segment.
  extraReserveLabel?: string,
): string | null {
  if (estimate.status === 'loading') return 'Estimating bridge reserve…';
  if (estimate.status !== 'ready') return null;
  if (estimate.belowFloor) {
    return `Bridge reserve is too small for the quoted fee (~${estimate.feeHuman} ${symbol}) — raise the bet.`;
  }
  return bridgeFundingHint(estimate.plan, decimals, symbol, extraReserveLabel);
}
