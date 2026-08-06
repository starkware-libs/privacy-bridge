// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// derivePolygonEoa must reject an accountIndex outside the safe-integer range.
// Any index ≥ 2^53 has already lost precision as an IEEE-754 double, so two
// distinct intended indices can map to the SAME double and derive the SAME EOA
// (a silent collision → two "distinct" trading accounts sharing one Polygon key).
// Its sibling deriveAccountNonce (claim-commitment.ts) guards this the same way (#42).

import { describe, expect, it } from 'vitest';
import { derivePolygonEoa } from './polygon-key.js';
import { deriveAccountNonce } from './claim-commitment.js';

const SIG = `0x${'ab'.repeat(65)}`;
const UNSAFE = Number.MAX_SAFE_INTEGER + 1; // 2^53 — first index that loses precision

describe('derivePolygonEoa — safe-integer guard (#42)', () => {
  it('rejects an accountIndex beyond the safe-integer range', () => {
    // 2^53 passes Number.isInteger but is not a safe integer: it shares the same
    // double as 2^53 + 1, so without this guard both derive the same EOA.
    expect(() => derivePolygonEoa(SIG, UNSAFE)).toThrow(/safe integer/i);
  });

  it('matches deriveAccountNonce, which rejects the same unsafe index', () => {
    expect(() => deriveAccountNonce(123n, UNSAFE)).toThrow(/safe integer/i);
  });

  it('still accepts a valid non-negative safe index and rejects a negative one', () => {
    expect(() => derivePolygonEoa(SIG, 0)).not.toThrow();
    expect(() => derivePolygonEoa(SIG, 7)).not.toThrow();
    expect(() => derivePolygonEoa(SIG, -1)).toThrow();
  });
});
