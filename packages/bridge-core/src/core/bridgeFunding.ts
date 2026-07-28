// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Bridge funding plan: the user types a **bet** (what they want on the CLOB); the
// pool burn funds `bet + reserve` where `reserve = quoted CCTP max_fee + swap
// slippage reserve + $0.05 cushion + an optional caller-supplied `extraReserveMicro`.
// The cushion + extra reserve cover fees but are NOT spent on the CLOB order — only
// the typed bet is posted. `extraReserveMicro` is GENERIC (a bigint of extra USDC
// micro-units to hold in the wallet); this package stays app-agnostic — the caller
// (e.g. apps/web, for the Polymarket taker fee) decides what it represents and labels it.

import { config } from './config';
import {
  fetchForwardMaxFee,
  formatPusdHint,
  type ForwardFeeQuote,
} from './cctpFees';
/** Max slippage floor (bps) on exactInputSingle amountOutMinimum (Uniswap v3 USDC→USDC.e swap). */
const SWAP_SLIPPAGE_BPS = 50n;

/** Small cushion after CCTP + swap (USDC micro, 6 dp). */
export const BRIDGE_FEE_CUSHION_MICRO = 50_000n;

export interface BridgeFundingPlan {
  betMicro: bigint;
  fundMicro: bigint;
  reserveMicro: bigint;
  swapSlippageReserveMicro: bigint;
  /** Extra caller-supplied reserve folded into `reserveMicro` (e.g. an order fee). 0n by default. */
  extraReserveMicro: bigint;
  quote: ForwardFeeQuote;
  /** Worst-case pUSD available for the CLOB order (= min(bet, post-fee wallet)). */
  projectedOrderMicro: bigint;
  belowFloor: boolean;
}

export function microToHuman(micro: bigint, decimals: number): number {
  return Number(micro) / 10 ** decimals;
}

/**
 * Net-of-fees deposit-in amount: what actually lands in the pool once the pool
 * fee, the (optional) one-time deploy fee, and the CCTP forward fee are
 * deducted from the typed gross amount. Floored at 0 (fees can exceed a small
 * typed amount). Pure math — the caller decides which fees are non-zero for
 * the current mode (e.g. `cctpMaxFee` is 0n outside metamask funding).
 */
export function depositNetMicro(
  typedMicro: bigint,
  fees: { poolFee: bigint; deployFee: bigint; cctpMaxFee: bigint },
): bigint {
  const totalFees = fees.poolFee + fees.deployFee + fees.cctpMaxFee;
  return typedMicro > totalFees ? typedMicro - totalFees : 0n;
}

// Extra native USDC to burn so floor(postCctp × (1 − slippage)) ≥ betMicro. `landed`
// is computed via exact integer ceiling division, so floor(landed*retainNumer/10000)
// >= betMicro already holds on entry for every input — no defensive bump-up loop
// needed (see bridgeFunding.test.ts's invariant check across sampled inputs).
export function swapSlippageReserveMicro(
  betMicro: bigint,
  slippageBps: bigint = SWAP_SLIPPAGE_BPS,
): bigint {
  if (betMicro <= 0n) return 0n;
  const retainNumer = 10_000n - slippageBps;
  const landed = (betMicro * 10_000n + retainNumer - 1n) / retainNumer;
  return landed - betMicro;
}

export function applySwapSlippageFloor(
  landedMicro: bigint,
  slippageBps: bigint = SWAP_SLIPPAGE_BPS,
): bigint {
  if (landedMicro <= 0n) return 0n;
  const retainNumer = 10_000n - slippageBps;
  return (landedMicro * retainNumer) / 10_000n;
}

export function bridgeReserveMicro(
  betMicro: bigint,
  maxFee: bigint,
  extraReserveMicro: bigint = 0n,
): bigint {
  return (
    maxFee + BRIDGE_FEE_CUSHION_MICRO + swapSlippageReserveMicro(betMicro) + extraReserveMicro
  );
}

export function totalBridgeFundMicro(
  betMicro: bigint,
  maxFee: bigint,
  extraReserveMicro: bigint = 0n,
): bigint {
  return betMicro + bridgeReserveMicro(betMicro, maxFee, extraReserveMicro);
}

export function projectedOrderMicro(
  betMicro: bigint,
  maxFee: bigint,
  extraReserveMicro: bigint = 0n,
): bigint {
  const fund = totalBridgeFundMicro(betMicro, maxFee, extraReserveMicro);
  const landed = fund > maxFee ? fund - maxFee : 0n;
  const walletMicro = applySwapSlippageFloor(landed);
  // The extra reserve only RAISES fund/wallet; the order still posts just the bet
  // (the extra is cushion the exchange consumes as the fee), so this stays = bet.
  return walletMicro < betMicro ? walletMicro : betMicro;
}

export function buildBridgeFundingPlan(
  betMicro: bigint,
  quote: ForwardFeeQuote,
  extraReserveMicro: bigint = 0n,
): BridgeFundingPlan {
  const swapSlippageReserve = swapSlippageReserveMicro(betMicro);
  const reserveMicro = bridgeReserveMicro(betMicro, quote.maxFee, extraReserveMicro);
  const fundMicro = betMicro + reserveMicro;
  return {
    betMicro,
    fundMicro,
    reserveMicro,
    swapSlippageReserveMicro: swapSlippageReserve,
    extraReserveMicro,
    quote,
    projectedOrderMicro: projectedOrderMicro(betMicro, quote.maxFee, extraReserveMicro),
    // #90: reserveMicro already includes >= maxFee (see bridgeReserveMicro), so
    // fundMicro = betMicro + reserveMicro is structurally always > maxFee — comparing
    // fundMicro here can never be true. The floor check is about whether the BET
    // itself is too small relative to the fee, not the total funded amount.
    belowFloor: betMicro <= quote.maxFee,
  };
}

// Quote max_fee iteratively on the burn total (fee has a bps component of amount).
export async function fetchBridgeFundingPlan(
  betMicro: bigint,
  opts?: {
    fast?: boolean;
    tier?: 'low' | 'med' | 'high';
    fetchImpl?: typeof fetch;
    // Fee ROUTE override. Omitted → cctpFees defaults (the Starknet→Polygon
    // fund-account route). The MetaMask deposit-in leg is EVM→Starknet, so its caller passes
    // the picked source chain's domain + the Starknet dest domain — otherwise the
    // quoted "Bridge reserve" is sized for the WRONG route and the minted net can
    // fall short of the amount the user entered (#198 / Bugbot).
    sourceDomain?: number;
    destDomain?: number;
    // Generic extra reserve (USDC micro) to hold in the wallet on top of the CCTP
    // fee/swap/cushion — e.g. a downstream order fee. Included in the re-quote loop's
    // fund total so the CCTP max_fee (which has a bps-of-amount component) is sized
    // for the FULL burn, not just the bet.
    extraReserveMicro?: bigint;
  },
): Promise<BridgeFundingPlan> {
  if (betMicro <= 0n) {
    throw new Error('Bet amount must be greater than zero.');
  }
  const fast = opts?.fast ?? config.cctp.fast;
  const tier = opts?.tier ?? 'med';
  const fetchImpl = opts?.fetchImpl;
  const { sourceDomain, destDomain } = opts ?? {};
  const extraReserveMicro = opts?.extraReserveMicro ?? 0n;

  let fundMicro = betMicro;
  let quote = await fetchForwardMaxFee(fundMicro, { fast, tier, fetchImpl, sourceDomain, destDomain });
  for (let i = 0; i < 4; i++) {
    const nextFund = totalBridgeFundMicro(betMicro, quote.maxFee, extraReserveMicro);
    if (nextFund === fundMicro) break;
    fundMicro = nextFund;
    quote = await fetchForwardMaxFee(fundMicro, { fast, tier, fetchImpl, sourceDomain, destDomain });
  }
  return buildBridgeFundingPlan(betMicro, quote, extraReserveMicro);
}

export function bridgeFundingHint(
  plan: BridgeFundingPlan,
  decimals: number,
  symbol: string,
  // Label for the optional extra reserve segment (shown only when > 0). Generic
  // default keeps this package app-agnostic; apps/web passes e.g. 'Polymarket fee'.
  extraReserveLabel = 'order fee',
): string {
  const bet = formatPusdHint(microToHuman(plan.betMicro, decimals));
  const fund = formatPusdHint(microToHuman(plan.fundMicro, decimals));
  const fee = formatPusdHint(microToHuman(plan.quote.maxFee, decimals));
  const swap = formatPusdHint(microToHuman(plan.swapSlippageReserveMicro, decimals));
  const cushion = formatPusdHint(microToHuman(BRIDGE_FEE_CUSHION_MICRO, decimals));
  const order = formatPusdHint(microToHuman(plan.projectedOrderMicro, decimals));
  const extraSegment =
    plan.extraReserveMicro > 0n
      ? ` + ~$${formatPusdHint(microToHuman(plan.extraReserveMicro, decimals))} ${extraReserveLabel}`
      : '';
  return (
    `Funds $${fund} ${symbol} from pool ($${bet} bet + ~$${fee} CCTP fee + ~$${swap} swap slippage + $${cushion} cushion${extraSegment}). ` +
    `Order: $${order} bet (cushion stays in wallet).`
  );
}
