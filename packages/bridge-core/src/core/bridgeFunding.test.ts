import { describe, expect, it, vi } from 'vitest';

const mockFetchForwardMaxFee = vi.fn();

vi.mock('./cctpFees.js', () => ({
  fetchForwardMaxFee: (...args: unknown[]) => mockFetchForwardMaxFee(...args),
  formatPusdHint: (n: number) => String(Number(n.toFixed(4))),
}));

vi.mock('./config.js', () => ({
  config: { cctp: { fast: false } },
}));

import {
  BRIDGE_FEE_CUSHION_MICRO,
  applySwapSlippageFloor,
  bridgeReserveMicro,
  buildBridgeFundingPlan,
  depositNetMicro,
  fetchBridgeFundingPlan,
  projectedOrderMicro,
  swapSlippageReserveMicro,
  totalBridgeFundMicro,
} from './bridgeFunding.js';

describe('depositNetMicro', () => {
  it('subtracts pool fee + deploy fee + CCTP max fee', () => {
    expect(depositNetMicro(100n, { poolFee: 5n, deployFee: 3n, cctpMaxFee: 2n })).toBe(90n);
  });

  it('floors at 0 when fees exceed the typed amount', () => {
    expect(depositNetMicro(5n, { poolFee: 3n, deployFee: 3n, cctpMaxFee: 3n })).toBe(0n);
  });

  it('cctpMaxFee = 0n (treasury mode) matches the pre-fee formula', () => {
    expect(
      depositNetMicro(42_000_000n, { poolFee: 500_000n, deployFee: 0n, cctpMaxFee: 0n }),
    ).toBe(41_500_000n);
  });

  it('an exact-fee typed amount lands at exactly 0 (boundary, not negative)', () => {
    expect(depositNetMicro(10n, { poolFee: 4n, deployFee: 3n, cctpMaxFee: 3n })).toBe(0n);
  });
});

describe('bridgeFunding', () => {
  const quote = {
    maxFee: 246_346n,
    forwardFee: 200_000n,
    protocolFee: 46_346n,
    finalityThreshold: 2000,
  };

  it('swapSlippageReserveMicro covers the 0.5% Uniswap floor with integer rounding', () => {
    const bet = 1_000_000n;
    const reserve = swapSlippageReserveMicro(bet);
    expect(reserve).toBe(5_026n);
    expect(applySwapSlippageFloor(bet + reserve)).toBeGreaterThanOrEqual(bet);
  });

  // Simplification (dedupe sweep): swapSlippageReserveMicro used to bump `landed` up
  // in a defensive `while` loop after the ceiling-division formula — provably
  // unreachable, since exact integer ceiling division already guarantees
  // floor(landed*retainNumer/10000) >= betMicro on entry for every input. These
  // hand-computed values plus the invariant check (the property the loop was
  // defensively re-verifying) are the proof the simplified formula is unchanged
  // behavior, across both the default and a non-default slippageBps.
  describe('swapSlippageReserveMicro (post-simplification correctness)', () => {
    const RETAIN_DENOM = 10_000n;

    it.each([
      // [betMicro, slippageBps, expectedReserve]
      [1n, undefined, 1n],
      [7n, undefined, 1n],
      [100n, undefined, 1n],
      [997n, undefined, 6n], // prime
      [1_000_000n, undefined, 5_026n],
      [1_000_000n, 100n, 10_102n], // non-default 1% slippage
      [3n, 100n, 1n],
    ] as const)(
      'betMicro=%s slippageBps=%s → reserve=%s (hand-computed)',
      (betMicro, slippageBps, expected) => {
        const reserve =
          slippageBps === undefined
            ? swapSlippageReserveMicro(betMicro)
            : swapSlippageReserveMicro(betMicro, slippageBps);
        expect(reserve).toBe(expected);
      },
    );

    it('invariant: floor((betMicro + reserve) * retainNumer / 10000) >= betMicro for every sample', () => {
      const samples: Array<{ betMicro: bigint; slippageBps?: bigint }> = [
        { betMicro: 1n },
        { betMicro: 7n },
        { betMicro: 100n },
        { betMicro: 997n },
        { betMicro: 1_000_000n },
        { betMicro: 1_000_000n, slippageBps: 100n },
        { betMicro: 3n, slippageBps: 100n },
        { betMicro: 123_456_789n, slippageBps: 25n },
      ];
      for (const { betMicro, slippageBps } of samples) {
        const reserve =
          slippageBps === undefined
            ? swapSlippageReserveMicro(betMicro)
            : swapSlippageReserveMicro(betMicro, slippageBps);
        const retainNumer = RETAIN_DENOM - (slippageBps ?? 50n);
        const landedFloor = ((betMicro + reserve) * retainNumer) / RETAIN_DENOM;
        expect(landedFloor).toBeGreaterThanOrEqual(betMicro);
      }
    });
  });

  it('reserve is max_fee + swap slippage + $0.05; projected order is capped at bet', () => {
    const bet = 1_000_000n;
    const swapReserve = swapSlippageReserveMicro(bet);
    expect(bridgeReserveMicro(bet, quote.maxFee)).toBe(
      quote.maxFee + BRIDGE_FEE_CUSHION_MICRO + swapReserve,
    );
    expect(totalBridgeFundMicro(bet, quote.maxFee)).toBe(
      bet + quote.maxFee + BRIDGE_FEE_CUSHION_MICRO + swapReserve,
    );
    expect(projectedOrderMicro(bet, quote.maxFee)).toBe(bet);
  });

  it('buildBridgeFundingPlan packages bet, fund, and projected order', () => {
    const plan = buildBridgeFundingPlan(1_000_000n, quote);
    expect(plan.fundMicro).toBe(1_301_372n);
    expect(plan.swapSlippageReserveMicro).toBe(5_026n);
    expect(plan.projectedOrderMicro).toBe(1_000_000n);
    expect(plan.belowFloor).toBe(false);
  });

  // #90: belowFloor compared fundMicro (bet + reserve, and reserve already >= maxFee)
  // against maxFee — structurally always false, since fundMicro >= betMicro + maxFee
  // >= maxFee. The correct comparison is the BET itself against the fee floor.
  it('#90: flags a sub-floor bet as belowFloor=true (bet <= maxFee)', () => {
    const bigFeeQuote = { ...quote, maxFee: 1_000_000n };
    const plan = buildBridgeFundingPlan(1n, bigFeeQuote);
    expect(plan.belowFloor).toBe(true);
  });

  it('#90: a bet comfortably above the fee is NOT belowFloor', () => {
    const plan = buildBridgeFundingPlan(10_000_000n, quote);
    expect(plan.belowFloor).toBe(false);
  });

  // #198 (Bugbot MEDIUM): the deposit-in picker chooses an EVM source chain, so the
  // fee must be quoted for THAT EVM→Starknet route — not the default
  // (SN→Polygon fund-account) route. RED before the sourceDomain/destDomain passthrough (opts were dropped);
  // GREEN after.
  it('forwards the source/dest fee route to fetchForwardMaxFee when given', async () => {
    mockFetchForwardMaxFee.mockReset();
    mockFetchForwardMaxFee.mockResolvedValue(quote);
    await fetchBridgeFundingPlan(1_000_000n, { sourceDomain: 6, destDomain: 12 });
    const opts = mockFetchForwardMaxFee.mock.calls[0][1] as {
      sourceDomain?: number;
      destDomain?: number;
    };
    expect(opts.sourceDomain).toBe(6);
    expect(opts.destDomain).toBe(12);
  });

  it('leaves the fee route to cctpFees defaults when source/dest are omitted', async () => {
    mockFetchForwardMaxFee.mockReset();
    mockFetchForwardMaxFee.mockResolvedValue(quote);
    await fetchBridgeFundingPlan(1_000_000n);
    const opts = mockFetchForwardMaxFee.mock.calls[0][1] as {
      sourceDomain?: number;
      destDomain?: number;
    };
    expect(opts.sourceDomain).toBeUndefined();
    expect(opts.destDomain).toBeUndefined();
  });

  it('fetchBridgeFundingPlan re-quotes until the fund total stabilizes', async () => {
    mockFetchForwardMaxFee.mockReset();
    mockFetchForwardMaxFee
      .mockResolvedValueOnce({ ...quote, maxFee: 240_000n })
      .mockResolvedValueOnce({ ...quote, maxFee: 246_346n })
      .mockResolvedValueOnce({ ...quote, maxFee: 246_346n });

    const plan = await fetchBridgeFundingPlan(1_000_000n);
    expect(plan.fundMicro).toBe(1_000_000n + quote.maxFee + BRIDGE_FEE_CUSHION_MICRO + 5_026n);
    expect(mockFetchForwardMaxFee.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  // Generic extra reserve (apps/web uses it for the Polymarket taker fee). It must
  // grow reserve + fund by EXACTLY the extra amount, leave the projected order = bet,
  // and default to 0n so existing (apps/bridge) callers are unchanged.
  describe('extraReserveMicro', () => {
    const bet = 1_000_000n;
    const extra = 3_500_000n;

    it('bridgeReserveMicro / totalBridgeFundMicro grow by exactly extraReserveMicro', () => {
      expect(bridgeReserveMicro(bet, quote.maxFee, extra)).toBe(
        bridgeReserveMicro(bet, quote.maxFee) + extra,
      );
      expect(totalBridgeFundMicro(bet, quote.maxFee, extra)).toBe(
        totalBridgeFundMicro(bet, quote.maxFee) + extra,
      );
    });

    it('projectedOrderMicro stays = bet (the extra is wallet cushion, not posted)', () => {
      expect(projectedOrderMicro(bet, quote.maxFee, extra)).toBe(bet);
    });

    it('buildBridgeFundingPlan folds it into reserveMicro + fundMicro and records the field', () => {
      const base = buildBridgeFundingPlan(bet, quote);
      const withExtra = buildBridgeFundingPlan(bet, quote, extra);
      expect(base.extraReserveMicro).toBe(0n); // default path unchanged (regression)
      expect(withExtra.extraReserveMicro).toBe(extra);
      expect(withExtra.reserveMicro).toBe(base.reserveMicro + extra);
      expect(withExtra.fundMicro).toBe(base.fundMicro + extra);
      expect(withExtra.projectedOrderMicro).toBe(bet);
    });

    it('fetchBridgeFundingPlan includes extraReserveMicro in the burned fund total', async () => {
      mockFetchForwardMaxFee.mockReset();
      mockFetchForwardMaxFee.mockResolvedValue(quote);
      const plan = await fetchBridgeFundingPlan(bet, { extraReserveMicro: extra });
      expect(plan.extraReserveMicro).toBe(extra);
      expect(plan.fundMicro).toBe(
        bet + quote.maxFee + BRIDGE_FEE_CUSHION_MICRO + 5_026n + extra,
      );
      // Re-quote loop must quote on the FULL fund (bet + reserve incl. extra), not the bet.
      const quotedAmount = mockFetchForwardMaxFee.mock.calls.at(-1)?.[0] as bigint;
      expect(quotedAmount).toBe(plan.fundMicro);
    });

    it('default (no extraReserveMicro) leaves the plan identical to the pre-feature path', async () => {
      mockFetchForwardMaxFee.mockReset();
      mockFetchForwardMaxFee.mockResolvedValue(quote);
      const plan = await fetchBridgeFundingPlan(bet);
      expect(plan.extraReserveMicro).toBe(0n);
      expect(plan.fundMicro).toBe(bet + quote.maxFee + BRIDGE_FEE_CUSHION_MICRO + 5_026n);
    });
  });
});
