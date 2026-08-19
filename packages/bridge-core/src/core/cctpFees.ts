// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// CCTP V2 max_fee computation, DIRECTION-AWARE (issue #199).
//
// Two distinct destinations, two fee shapes:
//   - FORWARDED (→Polygon): Circle's Forwarding Service submits the destination
//     mint for us (no relayer key of ours) and deducts its fee IN USDC from the
//     burned amount — the recipient EOA receives `amount - maxFee`. So `max_fee`
//     must cover BOTH the CCTP protocol fee (bps of amount; 0 for Standard
//     finality) AND the flat Forwarding-Service fee (destination gas, in USDC).
//   - NON-FORWARDED (EVM→Starknet, deposit-in): Starknet is NOT a forwarding
//     destination (Circle 400s on ?forward=true into domain 25). WE submit the SN
//     mint ourselves (receive_message), so there is NO Forwarding fee — `max_fee`
//     is the CCTP protocol fee (bps) alone. The forwarding dimension is derived
//     from the route (dst === polygonDomain) so callers never 400.
//
// Fee source: GET {iris}/v2/burn/USDC/fees/{src}/{dst}?forward={true|false}
// returns one row per finality threshold:
//   [{ finalityThreshold: 1000, minimumFee: 14, forwardFee: {low,med,high} },
//    { finalityThreshold: 2000, minimumFee: 0,  forwardFee: {low,med,high} }]
// `minimumFee` is the protocol fee in BASIS POINTS; `forwardFee.*` are ABSOLUTE
// USDC base units (6 dp). Mirrors Circle's how-to math (docs: Forwarding Service).
//
// NOTE (live boundary): values verified live against iris-api-sandbox for
// Starknet(25)->Polygon(7); the actual forwarded mint is only observable on a
// live run (.claude/rules/verification.md).

import { config, getDefaultEvmCctpDestination } from './config.js';

// CCTP finality thresholds: 1000 = Fast (soft finality, ~seconds, + bps fee),
// 2000 = Standard (hard finality, minutes, 0 bps). Forwarding works with both.
export const FAST_FINALITY_THRESHOLD = 1000;
export const STANDARD_FINALITY_THRESHOLD = 2000;

// SINGLE SOURCE OF TRUTH mapping the CCTP fast/standard tier to its finality
// threshold felt. BOTH the fee QUOTE (fetchForwardMaxFee below, via `wantThreshold`)
// AND the burn's DECLARED min_finality_threshold default (bridgeOut.ts's
// defaultFinalityThreshold) resolve the tier through THIS function, so the fee and
// the burn are computed identically and can never structurally diverge. A
// fast-quoted fee (1000, 14 bps) paired with a Standard-declared burn (2000) burns
// slow (~13-19 min) AND mismatches the fee/finality tier — the exact stranding class
// this function exists to prevent. Defaults to config.cctp.fast (the CCTP_FAST env).
export function resolveFinalityThreshold(fast: boolean = config.cctp.fast): number {
  return fast ? FAST_FINALITY_THRESHOLD : STANDARD_FINALITY_THRESHOLD;
}

// Shape of a single fee row from the Iris /v2/burn/USDC/fees endpoint.
interface IrisFeeRow {
  finalityThreshold: number;
  // Protocol fee in basis points (e.g. 14 = 0.14%; 0 for Standard).
  minimumFee: number;
  // Flat Forwarding-Service fee in USDC base units (only present with ?forward=true).
  forwardFee?: { low: number; med: number; high: number };
}

export interface ForwardFeeQuote {
  // The value to pass as CCTP `max_fee`: forwardFee + protocolFee (USDC base units).
  maxFee: bigint;
  // The flat Forwarding-Service fee component (USDC base units).
  forwardFee: bigint;
  // The CCTP protocol fee component (bps of amount; 0 for Standard).
  protocolFee: bigint;
  // The finality threshold this quote applies to (1000 fast / 2000 standard).
  finalityThreshold: number;
}

// Compute the CCTP `max_fee` for a burn of `amount` (USDC base units). `fast`
// selects the finality tier (defaults to config.cctp.fast); `tier` picks the
// forward-fee buffer (defaults 'med'); `fetchImpl` is injectable for tests.
//
// `sourceDomain`/`destDomain` override the fee ROUTE. They default to
// starknetDomain→polygonDomain, correct for the fund/return legs; the deposit-in
// leg burns EVM→Starknet and MUST pass its own route (sourceDomain = EVM source,
// destDomain = starknetDomain) or the fee is quoted for the wrong route.
//
// DIRECTION-AWARE forwarding (issue #199): the Forwarding Service is a per-
// DESTINATION capability. Circle auto-mints only on our forwarded route →Polygon
// (SN→Polygon: BUY + fund/return legs). Starknet is a supported CCTP SOURCE but
// NOT a forwarding DESTINATION — `?forward=true` into domain 25 returns HTTP 400
// ("Destination domain not supported for forwarding") and aborted the whole
// deposit before any on-chain tx. So the forwarding dimension is DERIVED from the
// route (dst === polygonDomain) and we NEVER forward into Starknet:
//   - forwarded routes (→Polygon): max_fee = flat forwardFee + protocol bps;
//   - non-forwarded routes (EVM→Starknet, where WE submit the SN mint via
//     receive_message): max_fee = protocol bps ONLY (no forwardFee, forwardFee 0).
export async function fetchForwardMaxFee(
  amount: bigint,
  opts?: {
    fast?: boolean;
    tier?: 'low' | 'med' | 'high';
    fetchImpl?: typeof fetch;
    sourceDomain?: number;
    destDomain?: number;
  },
): Promise<ForwardFeeQuote> {
  const { irisUrl, starknetDomain } = config.cctp;
  const fast = opts?.fast ?? config.cctp.fast;
  const tier = opts?.tier ?? 'med';
  const doFetch = opts?.fetchImpl ?? fetch;
  const src = opts?.sourceDomain ?? starknetDomain;
  // Default the destination to the default bridge-OUT chain's domain (Polygon) when
  // the caller doesn't specify a route — the fund/cash-out legs pass their chosen
  // dest explicitly; the deposit-in leg passes destDomain = starknetDomain.
  const dst = opts?.destDomain ?? getDefaultEvmCctpDestination().domain;

  // Forwarding is supported for every EVM CCTP destination (Circle's Forwarding
  // Service mints on Polygon/Base/Arbitrum/Ethereum/Optimism). Starknet (domain 25)
  // is a CCTP SOURCE but NOT a forwarding destination — ?forward=true into domain 25
  // returns HTTP 400, so a route INTO Starknet queries ?forward=false.
  const forwarding = dst !== starknetDomain;

  const base = irisUrl.replace(/\/+$/, '');
  const url = `${base}/v2/burn/USDC/fees/${src}/${dst}?forward=${forwarding}`;
  const res = await doFetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`CCTP fee query failed: HTTP ${res.status} (${url}).`);
  }

  const rows = (await res.json()) as IrisFeeRow[];
  if (!Array.isArray(rows)) {
    throw new Error(
      `CCTP fee response is not an array (got ${typeof rows}) — Iris API shape mismatch.`,
    );
  }
  const wantThreshold = resolveFinalityThreshold(fast);
  const row = rows.find((r) => r.finalityThreshold === wantThreshold);
  if (!row) {
    // The desired finality tier is absent. Throw explicitly — never fall back to a
    // different tier whose fee/threshold pairing would be silently mismatched with
    // the caller's configured threshold (#finding-2).
    throw new Error(
      `CCTP fee not available for finality threshold ${wantThreshold} (route ${src}→${dst}).`,
    );
  }

  // Flat Forwarding-Service fee — ONLY on forwarded routes. Non-forwarded routes
  // (EVM→Starknet) submit the destination mint themselves, so there is no
  // forwardFee (0n) and max_fee is the protocol fee alone.
  let forwardFee = 0n;
  if (forwarding) {
    if (row.forwardFee == null) {
      // forwardFee missing ⇒ Forwarding Service not available for this route/tier.
      throw new Error(
        `CCTP Forwarding Service fee not available for finality threshold ${wantThreshold} ` +
          `(route ${src}→${dst}).`,
      );
    }
    // forwardFee.* are absolute USDC base units; ceil to stay >= Circle's quote.
    const rawFee = row.forwardFee[tier];
    if (rawFee == null || !isFinite(rawFee) || rawFee < 0) {
      throw new Error(
        `CCTP Forwarding Service fee for tier "${tier}" is invalid (${rawFee}) — cannot compute max_fee safely.`,
      );
    }
    forwardFee = BigInt(Math.ceil(rawFee));
  }

  // Protocol fee (bps of amount) applies to BOTH forwarded and non-forwarded routes.
  // Validate minimumFee BEFORE the BigInt(Math.round(...)) — mirrors the per-tier
  // forwardFee guard above. minimumFee=null would coerce to 0n (silently undercount
  // the protocol fee), undefined/NaN/Infinity would throw a cryptic RangeError, and
  // a negative bps would make protocolFee negative → maxFee below Circle's real fee
  // → CCTP under-delivers. Reject all of these with a clean, labelled error.
  const rawMin = row.minimumFee;
  if (rawMin == null || !isFinite(rawMin) || rawMin < 0) {
    throw new Error(
      `CCTP Forwarding Service minimumFee for finality threshold ${wantThreshold} ` +
        `is invalid (${rawMin}) — cannot compute max_fee safely.`,
    );
  }
  // protocolFee = amount * minimumFee(bps). Circle's formula scales minimumFee
  // by 100 then divides by 1e6 (i.e. bps/10000). Circle's minimum fast fee is an
  // integer ≥ amount·bps/10⁴ — ceil-divide (a floored quote is below the floor →
  // Iris delays to Standard with delayReason=insufficient_fee).
  const bpsScaled = BigInt(Math.ceil(rawMin * 100));
  const protocolFee = (amount * bpsScaled + 999_999n) / 1_000_000n;
  const maxFee = forwardFee + protocolFee;
  return { maxFee, forwardFee, protocolFee, finalityThreshold: row.finalityThreshold };
}

// Format a USDC/pUSD human amount for inline hints (2 dp when ≥ $1, else up to 4).
export function formatPusdHint(human: number, decimals = 6): string {
  if (!Number.isFinite(human) || human <= 0) return '0';
  if (human >= 1) return human.toFixed(2);
  const s = human.toFixed(Math.min(decimals, 4));
  return s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

// Pre-flight guard for the configurable-floor decision: the burn must clear the
// forwarding fee or the Anonymizer's `assert(amount > max_fee)` reverts opaquely
// (and the recipient would get zero). Throw a clear, actionable error instead.
// `decimals`/`symbol` default to USDC for the human-readable floor in the message.
export function assertAboveForwardFloor(
  amount: bigint,
  quote: ForwardFeeQuote,
  opts?: { decimals?: number; symbol?: string },
): void {
  if (amount > quote.maxFee) return;
  const decimals = opts?.decimals ?? config.depositToken.decimals;
  const symbol = opts?.symbol ?? config.depositToken.symbol;
  const human = (v: bigint): string => (Number(v) / 10 ** decimals).toString();
  throw new Error(
    `Amount ${human(amount)} ${symbol} is below the CCTP forwarding-fee floor ` +
      `(~${human(quote.maxFee)} ${symbol}: ${human(quote.forwardFee)} forward + ` +
      `${human(quote.protocolFee)} protocol). Raise the amount (ACCOUNT_DENOMINATION).`,
  );
}
