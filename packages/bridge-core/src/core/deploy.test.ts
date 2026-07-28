// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { describe, expect, it } from 'vitest';
import { deployFunding, DEPLOY_FUND_FLOOR_WEI, buildDeploymentData } from './deploy';
import { config } from './config';

// Unit tests for the PURE deploy-funding helper that drives ensureAccountDeployed.
//
// CORRECTED MODEL: the account DEPLOY is the ONLY tx in this lifecycle that pays a
// real fee (a server-side v3 tx). The downstream proven legs (register/deposit/
// withdraw) are submitted to a transaction prover with skip_fee_charge = true and
// all-zero max_price_per_unit / tip, so their implied max fee is 0 and __validate__
// can NEVER reject them with code 55 — i.e. they need NO funding. So:
//   - an ALREADY-deployed account needs NO funding (no top-up, no balance read);
//     there is no longer a "proven-leg reserve" to maintain — only the boundary
//     math of deployFunding below is load-bearing, and the caller's already-deployed
//     branch simply returns without a transfer.
//   - a FRESH account is funded deployFunding(estimate) — the deploy fee × 3,
//     floored — and nothing more.
// Pinning deployFunding at its boundaries is more robust than mocking the full
// deploy/transfer plumbing and catches a revert of the fix (e.g. dropping the floor).

const STRK = 10n ** 18n;

describe('DEPLOY_FUND_FLOOR_WEI', () => {
  it('is the 1 STRK safety floor', () => {
    expect(DEPLOY_FUND_FLOOR_WEI).toBe(1n * STRK);
  });
});

describe('deployFunding', () => {
  // (a) a zero estimate (estimate returned 0 / failed → caller floors anyway) lands
  // exactly on the floor, so a server-side deploy is still funded.
  it('(a) deployFunding(0n) === DEPLOY_FUND_FLOOR_WEI', () => {
    expect(deployFunding(0n)).toBe(DEPLOY_FUND_FLOOR_WEI);
  });

  // (b) a tiny estimate (×3 still below the floor) is lifted to the floor.
  it('(b) a tiny estimate floors to DEPLOY_FUND_FLOOR_WEI', () => {
    // 0.1 STRK × 3 = 0.3 STRK < 1 STRK floor.
    expect(deployFunding(STRK / 10n)).toBe(DEPLOY_FUND_FLOOR_WEI);
    // boundary just below where 3× clears the floor: (floor/3 - 1) × 3 < floor.
    expect(deployFunding(DEPLOY_FUND_FLOOR_WEI / 3n - 1n)).toBe(DEPLOY_FUND_FLOOR_WEI);
  });

  // (c) a large estimate returns 3× it (above the floor) — the margin over a
  // possibly-stale estimate.
  it('(c) a large estimate (2 STRK) returns 3× it, above the floor', () => {
    const estimate = 2n * STRK;
    expect(deployFunding(estimate)).toBe(6n * STRK);
    expect(deployFunding(estimate)).toBeGreaterThan(DEPLOY_FUND_FLOOR_WEI);
  });

  // (d) monotonic: a higher estimate never lowers the funded amount.
  it('(d) is monotonic in the estimate', () => {
    expect(deployFunding(2n * STRK)).toBeGreaterThan(deployFunding(STRK));
    expect(deployFunding(STRK)).toBeGreaterThanOrEqual(deployFunding(0n));
  });

  // MUTATION: dropping the floor (returning a bare estimate × 3) would make (a) and
  // (b) fail — a 0 / tiny estimate would under-fund the server-side deploy. Pin the
  // floored result so that regression is caught.
  it('MUTATION: without the floor, (a)/(b) would under-fund the deploy', () => {
    const unflooredZero = 0n * 3n; // the buggy "estimate × 3, no floor" for estimate 0
    expect(unflooredZero).toBeLessThan(DEPLOY_FUND_FLOOR_WEI);
    expect(deployFunding(0n)).toBeGreaterThan(unflooredZero); // the floor saves it
    const unflooredTiny = (STRK / 10n) * 3n;
    expect(unflooredTiny).toBeLessThan(DEPLOY_FUND_FLOOR_WEI);
    expect(deployFunding(STRK / 10n)).toBeGreaterThan(unflooredTiny);
  });
});

// SNIP-29 deployment data for the paymaster-sponsored deploy. This MUST mirror the
// admin path's deployPayload (classHash + [publicKey] calldata + publicKey salt),
// or the paymaster deploys a different address than the one the user derived.
describe('buildDeploymentData', () => {
  it('mirrors the OZ deploy payload (class hash from config, [pubkey] calldata, pubkey salt)', () => {
    const d = buildDeploymentData('0xabc', '0xpub');
    expect(d).toEqual({
      address: '0xabc',
      class_hash: config.ozClassHash,
      salt: '0xpub',
      calldata: ['0xpub'],
      // SNIP-29 requires the numeric literal 1 (not '0x1') — pinned so a regression
      // to the wrong version literal is caught at the type + value level.
      version: 1,
    });
  });
});
