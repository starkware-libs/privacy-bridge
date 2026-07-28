// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Offline unit tests for the CCTP V2 Forwarding-Service fee computation
// (cctpFees.ts). No network is touched: the Iris fee endpoint is mocked via an
// injected fetchImpl. The live values can only be verified against
// iris-api-sandbox (.claude/rules/verification.md) — here we pin the math:
// maxFee = forwardFee.med (the chosen tier) + protocolFee (bps of amount), and
// the configurable-floor guard (assertAboveForwardFloor).

import { describe, expect, it, vi } from 'vitest';

import {
  fetchForwardMaxFee,
  assertAboveForwardFloor,
  formatPusdHint,
  resolveFinalityThreshold,
} from './cctpFees.js';
import { initTestConfig } from '../../vitest.setup';

// Iris GET /v2/burn/USDC/fees/{src}/{dst}?forward=true shape: one row per finality
// threshold. minimumFee is the protocol fee in BASIS POINTS (14 = 0.14% for Fast;
// 0 for Standard); forwardFee.* are absolute USDC base units (6 dp).
const FEE_ROWS = [
  { finalityThreshold: 1000, minimumFee: 14, forwardFee: { low: 9000, med: 10000, high: 12000 } },
  { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 8000, med: 9000, high: 11000 } },
];

/** A fetch impl that returns the Iris fee rows as JSON (no network). */
function feeFetch(rows: unknown = FEE_ROWS, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => rows,
  })) as unknown as typeof fetch;
}

describe('fetchForwardMaxFee — maxFee = forwardFee.med + protocolFee', () => {
  it('Fast (1000): protocolFee = minimumFee bps of amount, plus the med forward fee', async () => {
    const amount = 10_000_000n; // 10 USDC (6 dp)
    const quote = await fetchForwardMaxFee(amount, { fast: true, fetchImpl: feeFetch() });

    // protocolFee = amount * round(14 * 100) / 1e6 = 10_000_000 * 1400 / 1e6 = 14_000.
    const expectedProtocol = (amount * 1400n) / 1_000_000n;
    expect(quote.finalityThreshold).toBe(1000);
    expect(quote.forwardFee).toBe(10_000n); // forwardFee.med for the 1000 row
    expect(quote.protocolFee).toBe(expectedProtocol);
    expect(quote.maxFee).toBe(10_000n + expectedProtocol);
  });

  it('Standard (2000): minimumFee = 0 → protocolFee = 0, maxFee = forwardFee.med only', async () => {
    const amount = 10_000_000n;
    const quote = await fetchForwardMaxFee(amount, { fast: false, fetchImpl: feeFetch() });

    expect(quote.finalityThreshold).toBe(2000);
    expect(quote.forwardFee).toBe(9_000n); // forwardFee.med for the 2000 row
    expect(quote.protocolFee).toBe(0n);
    expect(quote.maxFee).toBe(9_000n);
  });

  it('honors the tier selector (high) for the forward-fee component', async () => {
    const quote = await fetchForwardMaxFee(1_000_000n, {
      fast: true,
      tier: 'high',
      fetchImpl: feeFetch(),
    });
    expect(quote.forwardFee).toBe(12_000n); // forwardFee.high for the 1000 row
  });

  it('throws when the desired tier is absent — no silent fallback to the wrong row (#finding-2)', async () => {
    // Only Standard (2000) is in the response; caller requests Fast (1000).
    // Pre-fix: ?? rows[0] silently returns the Standard quote with finalityThreshold=2000
    // while callers use the configured threshold=1000 → fee/threshold mismatch. FAILS.
    // Post-fix: explicit throw when row for wantThreshold is absent. PASSES.
    const standardOnly = [
      { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 8000, med: 9000, high: 11000 } },
    ];
    await expect(
      fetchForwardMaxFee(1_000_000n, { fast: true, fetchImpl: feeFetch(standardOnly) }),
    ).rejects.toThrow(/fee not available for finality threshold 1000/i);
  });

  it('throws a clear error when the route is not forward-enabled (no forwardFee)', async () => {
    const noForward = [{ finalityThreshold: 1000, minimumFee: 14 }];
    await expect(
      fetchForwardMaxFee(1_000_000n, { fast: true, fetchImpl: feeFetch(noForward) }),
    ).rejects.toThrow(/fee not available for finality threshold 1000/i);
  });

  it('throws when an individual tier value is null (avoids BigInt(0) bypassing the fee floor)', async () => {
    // Iris returning { forwardFee: { med: null } } would silently produce maxFee = 0n
    // (Math.ceil(null) = 0), bypassing assertAboveForwardFloor and burning with no
    // fee cap. The per-tier guard must catch this before BigInt(Math.ceil(...)).
    const nullTier = [
      {
        finalityThreshold: 1000,
        minimumFee: 14,
        forwardFee: { low: 9000, med: null, high: 12000 },
      },
    ];
    await expect(
      fetchForwardMaxFee(1_000_000n, { fast: true, tier: 'med', fetchImpl: feeFetch(nullTier) }),
    ).rejects.toThrow(/fee for tier "med" is invalid/i);
  });

  it('throws when an individual tier value is NaN', async () => {
    const nanTier = [
      { finalityThreshold: 1000, minimumFee: 14, forwardFee: { low: 9000, med: NaN, high: 12000 } },
    ];
    await expect(
      fetchForwardMaxFee(1_000_000n, { fast: true, tier: 'med', fetchImpl: feeFetch(nanTier) }),
    ).rejects.toThrow(/fee for tier "med" is invalid/i);
  });

  it('throws on a non-OK fee response', async () => {
    await expect(
      fetchForwardMaxFee(1_000_000n, { fast: true, fetchImpl: feeFetch(FEE_ROWS, 500) }),
    ).rejects.toThrow(/HTTP 500/);
  });

  // C1 BUG PROBE: if Iris returns a non-array (plain object {}), rows.find is not
  // a function → TypeError. A well-behaved implementation should throw a domain
  // error (not a TypeError) so callers can classify it correctly.
  it('C1: throws a domain error (not TypeError) when the Iris fee endpoint returns a non-array object', async () => {
    // feeFetch({}) → res.json() returns {} (not an array). The code does:
    //   const rows = (await res.json()) as IrisFeeRow[];
    //   rows.find(...)  ← throws TypeError on current code
    const err = await fetchForwardMaxFee(1_000_000n, { fast: true, fetchImpl: feeFetch({}) }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    // On current code this IS a TypeError → the test fails (proving the bug).
    expect(err).not.toBeInstanceOf(TypeError);
  });

  // VP2 BUG PROBE: minimumFee (the protocol-fee bps) is the uncovered sibling of
  // the per-tier forwardFee guard above. Pre-fix, `BigInt(Math.round(row.minimumFee
  // * 100))` validated nothing:
  //   - null → Math.round(0)=0 → protocolFee 0n (silently undercounts the fee);
  //   - NaN/undefined/Infinity → BigInt(NaN) throws a cryptic RangeError;
  //   - negative → negative protocolFee → maxFee below Circle's real fee → CCTP
  //     under-delivers (the recipient EOA receives less than expected).
  // All must be rejected with a clean, labelled domain error BEFORE the BigInt.
  it('VP2: throws a clean error when minimumFee is null (no silent 0-bps undercount)', async () => {
    const rows = [
      {
        finalityThreshold: 1000,
        minimumFee: null,
        forwardFee: { low: 9000, med: 10000, high: 12000 },
      },
    ];
    const err = await fetchForwardMaxFee(1_000_000n, {
      fast: true,
      fetchImpl: feeFetch(rows),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/minimumFee for finality threshold 1000 is invalid/i);
  });

  it('VP2: throws a clean error (not a RangeError) when minimumFee is NaN', async () => {
    const rows = [
      {
        finalityThreshold: 1000,
        minimumFee: NaN,
        forwardFee: { low: 9000, med: 10000, high: 12000 },
      },
    ];
    const err = await fetchForwardMaxFee(1_000_000n, {
      fast: true,
      fetchImpl: feeFetch(rows),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RangeError);
    expect((err as Error).message).toMatch(/minimumFee for finality threshold 1000 is invalid/i);
  });

  it('VP2: throws when minimumFee is negative (would make maxFee under-deliver)', async () => {
    const rows = [
      {
        finalityThreshold: 1000,
        minimumFee: -5,
        forwardFee: { low: 9000, med: 10000, high: 12000 },
      },
    ];
    await expect(
      fetchForwardMaxFee(1_000_000n, { fast: true, fetchImpl: feeFetch(rows) }),
    ).rejects.toThrow(/minimumFee for finality threshold 1000 is invalid/i);
  });
});

describe('fetchForwardMaxFee — sourceDomain/destDomain route override', () => {
  /** A fetch impl that records the requested URL, returning the standard fee rows. */
  function capturingFetch(urls: string[]): typeof fetch {
    return vi.fn(async (input: unknown) => {
      urls.push(String(input));
      return { ok: true, status: 200, json: async () => FEE_ROWS };
    }) as unknown as typeof fetch;
  }

  it('defaults to the Starknet(25)→Polygon(7) route (fund/return legs)', async () => {
    const urls: string[] = [];
    await fetchForwardMaxFee(1_000_000n, { fast: true, fetchImpl: capturingFetch(urls) });
    expect(urls[0]).toContain('/v2/burn/USDC/fees/25/7?forward=true');
  });

  it('overrides the route when sourceDomain/destDomain are given (deposit-in EVM→Starknet)', async () => {
    const urls: string[] = [];
    // Polygon Amoy (domain 7) → Starknet (domain 25): the deposit-in route, NOT the
    // default Starknet→Polygon. Starknet is NOT a forwarding DESTINATION, so this
    // route MUST query ?forward=false (issue #199) — ?forward=true 400s here.
    await fetchForwardMaxFee(1_000_000n, {
      fast: true,
      sourceDomain: 7,
      destDomain: 25,
      fetchImpl: capturingFetch(urls),
    });
    expect(urls[0]).toContain('/v2/burn/USDC/fees/7/25?forward=false');
    expect(urls[0]).not.toContain('/fees/25/7');
  });
});

describe('fetchForwardMaxFee — EVM→Starknet non-forwarded route (?forward=false, issue #199)', () => {
  // Circle's Forwarding Service does NOT support Starknet (domain 25) as a
  // DESTINATION (only as a source). `GET .../fees/{src}/25?forward=true` → HTTP 400
  // ("Destination domain not supported for forwarding"), which aborted the whole
  // deposit before any on-chain tx. The EVM→Starknet deposit-in leg submits the SN
  // mint ITSELF (receive_message), so there is NO Forwarding-Service fee — only the
  // CCTP protocol fee (bps). `?forward=false` rows carry no forwardFee.
  const NO_FORWARD_ROWS = [
    { finalityThreshold: 1000, minimumFee: 14 },
    { finalityThreshold: 2000, minimumFee: 0 },
  ];

  /** A fetch impl that records the requested URL, returning the forward=false rows. */
  function capturingForwardFalse(urls: string[]): typeof fetch {
    return vi.fn(async (input: unknown) => {
      urls.push(String(input));
      return { ok: true, status: 200, json: async () => NO_FORWARD_ROWS };
    }) as unknown as typeof fetch;
  }

  it('NEVER issues ?forward=true when the destination is Starknet (the fees/0/25 400 bug)', async () => {
    const urls: string[] = [];
    await fetchForwardMaxFee(5_000_000n, {
      fast: true,
      sourceDomain: 0, // Ethereum
      destDomain: 25, // Starknet — the route that 400s with forward=true
      fetchImpl: capturingForwardFalse(urls),
    });
    expect(urls[0]).toContain('/v2/burn/USDC/fees/0/25?forward=false');
    expect(urls[0]).not.toContain('forward=true');
  });

  it('Fast (1000): maxFee = protocolFee (bps of amount) only, forwardFee = 0', async () => {
    const amount = 10_000_000n; // 10 USDC (6 dp)
    const quote = await fetchForwardMaxFee(amount, {
      fast: true,
      sourceDomain: 7,
      destDomain: 25,
      fetchImpl: feeFetch(NO_FORWARD_ROWS),
    });
    // protocolFee = amount * round(14 * 100) / 1e6 = 10_000_000 * 1400 / 1e6 = 14_000.
    const expectedProtocol = (amount * 1400n) / 1_000_000n;
    expect(quote.finalityThreshold).toBe(1000);
    expect(quote.forwardFee).toBe(0n); // no Forwarding-Service fee on EVM→SN
    expect(quote.protocolFee).toBe(expectedProtocol);
    expect(quote.maxFee).toBe(expectedProtocol);
  });

  it('Standard (2000): minimumFee 0 → maxFee 0 (no protocol fee, no forward fee)', async () => {
    const quote = await fetchForwardMaxFee(10_000_000n, {
      fast: false,
      sourceDomain: 7,
      destDomain: 25,
      fetchImpl: feeFetch(NO_FORWARD_ROWS),
    });
    expect(quote.finalityThreshold).toBe(2000);
    expect(quote.forwardFee).toBe(0n);
    expect(quote.protocolFee).toBe(0n);
    expect(quote.maxFee).toBe(0n);
  });
});

describe('fetchForwardMaxFee — protocol fee ceils a fractional bps (live insufficient_fee bug)', () => {
  // Circle's minimum fast fee is an integer >= amount*bps/1e4. A floored quote for
  // a fractional bps (e.g. 1,055,131 @ 1 bps = 105.5131) is BELOW Circle's real
  // minimum: Iris attested with delayReason=insufficient_fee, feeExecuted=0,
  // silently downgrading Fast (finality 1000) to Standard (~13-19 min). Ceil fixes
  // it; exactly-divisible amounts must stay unchanged (no gratuitous +1).
  const ONE_BPS_ROWS = [
    { finalityThreshold: 1000, minimumFee: 1 },
    { finalityThreshold: 2000, minimumFee: 0 },
  ];

  it('ceils the bps protocol fee — 1,055,131 @ 1 bps quotes 106, not 105 (live delayReason=insufficient_fee)', async () => {
    const quote = await fetchForwardMaxFee(1_055_131n, {
      fast: true,
      sourceDomain: 0,
      destDomain: 25,
      fetchImpl: feeFetch(ONE_BPS_ROWS),
    });
    // 1,055,131 * 1bps / 1e4 = 105.5131 → ceil → 106. Non-forwarded route: maxFee
    // is the protocol fee alone (forwardFee 0n, as pinned by the sibling describe
    // block above for this route shape).
    expect(quote.protocolFee).toBe(106n);
    expect(quote.forwardFee).toBe(0n);
    expect(quote.maxFee).toBe(106n);
  });

  it('exactly-divisible amount gets no gratuitous +1 — 1,000,000 @ 1 bps stays 100', async () => {
    const quote = await fetchForwardMaxFee(1_000_000n, {
      fast: true,
      sourceDomain: 0,
      destDomain: 25,
      fetchImpl: feeFetch(ONE_BPS_ROWS),
    });
    expect(quote.protocolFee).toBe(100n);
    expect(quote.maxFee).toBe(100n);
  });

  it('forwarded route: maxFee = forwardFee + ceil(protocolFee) for a fractional bps', async () => {
    const rows = [
      { finalityThreshold: 1000, minimumFee: 1, forwardFee: { low: 9000, med: 10000, high: 12000 } },
      { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 8000, med: 9000, high: 11000 } },
    ];
    const quote = await fetchForwardMaxFee(1_055_131n, { fast: true, fetchImpl: feeFetch(rows) });
    expect(quote.protocolFee).toBe(106n);
    expect(quote.forwardFee).toBe(10_000n);
    expect(quote.maxFee).toBe(10_106n);
  });
});

describe('assertAboveForwardFloor — configurable forwarding-fee floor', () => {
  // maxFee = forwardFee.med (10000) + protocolFee (14000 for 10 USDC) = 24000 in the
  // Fast quote below; build a representative quote to gate against directly.
  const quote = {
    maxFee: 24_000n,
    forwardFee: 10_000n,
    protocolFee: 14_000n,
    finalityThreshold: 1000,
  };

  it('throws when the amount is below the fee floor (amount <= maxFee)', () => {
    expect(() => assertAboveForwardFloor(24_000n, quote)).toThrow(
      /below the CCTP forwarding-fee floor/i,
    );
    expect(() => assertAboveForwardFloor(10_000n, quote)).toThrow(/forwarding-fee floor/i);
  });

  it('passes when the amount strictly exceeds the fee floor', () => {
    expect(() => assertAboveForwardFloor(24_001n, quote)).not.toThrow();
    expect(() => assertAboveForwardFloor(10_000_000n, quote)).not.toThrow();
  });
});

describe('resolveFinalityThreshold — single source of truth for the CCTP finality tier', () => {
  // The tier→threshold map that BOTH the fee quote (fetchForwardMaxFee) and the burn
  // default (bridgeOut.defaultFinalityThreshold) now resolve through — so a fast quote
  // can never be paired with a Standard burn (the tier-mismatch stranding class).
  it('maps fast=true → 1000 (Fast) and fast=false → 2000 (Standard)', () => {
    expect(resolveFinalityThreshold(true)).toBe(1000);
    expect(resolveFinalityThreshold(false)).toBe(2000);
  });

  it('defaults to config.cctp.fast when no arg is given (follows the CCTP_FAST env)', () => {
    // vitest.setup injects CCTP_FAST=false, so the default is Standard (2000).
    expect(resolveFinalityThreshold()).toBe(2000);
    // Flip the injected flag: the default now follows config → Fast (1000).
    initTestConfig({ CCTP_FAST: 'true' });
    expect(resolveFinalityThreshold()).toBe(1000);
    // Restore (the setup beforeEach also re-injects the baseline for the next test).
    initTestConfig({ CCTP_FAST: 'false' });
    expect(resolveFinalityThreshold()).toBe(2000);
  });
});

describe('formatPusdHint', () => {
  it('formats small and large amounts for inline hints', () => {
    expect(formatPusdHint(0.888494)).toBe('0.8885');
    expect(formatPusdHint(1.5)).toBe('1.50');
  });
});
