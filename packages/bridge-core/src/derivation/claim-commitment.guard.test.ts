// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { describe, expect, it } from 'vitest';
import { computeClaimH } from './claim-commitment.js';

// Regression: computeClaimH must reject a negative `amount`. Without the guard a
// negative amount silently reduces mod the STARK prime P, so -1n aliases to
// P-1n and collides on the SAME commitment H — exactly the gap deriveAccountNonce's
// `if (counter < 0n) throw` already closes for its counter. These were RED
// before the guard (today -1n did NOT throw) and are GREEN after.

// STARK field prime P (felt modulus).
const P =
  3618502788666131213697322783095070105623107215331596699973092056135872020481n;

describe('computeClaimH negative-amount guard', () => {
  it('throws on a negative amount (-1n)', () => {
    expect(() => computeClaimH({ claimSecret: 12345n, amount: -1n, snDomain: 25n })).toThrow();
  });

  it('does not throw on the in-range felt P-1n (so -1n can no longer alias into the field)', () => {
    expect(() =>
      computeClaimH({ claimSecret: 12345n, amount: P - 1n, snDomain: 25n }),
    ).not.toThrow();
  });
});
