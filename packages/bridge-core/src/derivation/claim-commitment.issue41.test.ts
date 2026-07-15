import { describe, expect, it } from 'vitest';
import { computeClaimH } from './claim-commitment.js';

// Regression test for issue #41:
// computeClaimH does not bound amount/claimSecret/snDomain to the felt range.
// Out-of-range felts collide mod P — e.g. passing amount = P+1n silently
// reduces to 1n, producing the same H as amount = 1n (silent commitment
// collision). Defense-in-depth: all three inputs must be in [0, P).
//
// RED before fix (computeClaimH only checked amount < 0n, no upper-bound check).
// GREEN after fix (upper-bound guards added for amount, claimSecret, snDomain).

// STARK field prime P (felt modulus).
const P =
  3618502788666131213697322783095070105623107215331596699973092056135872020481n;

describe('computeClaimH felt-range upper-bound guards (issue #41)', () => {
  it('throws when amount >= P (out-of-range felt aliases silently mod P)', () => {
    // P+1n reduces to 1n inside Poseidon → same H as amount=1n (silent collision)
    expect(() =>
      computeClaimH({ claimSecret: 12345n, amount: P, snDomain: 25n }),
    ).toThrow();
    expect(() =>
      computeClaimH({ claimSecret: 12345n, amount: P + 1n, snDomain: 25n }),
    ).toThrow();
  });

  it('throws when claimSecret >= P', () => {
    expect(() =>
      computeClaimH({ claimSecret: P, amount: 1_000_000n, snDomain: 25n }),
    ).toThrow();
    expect(() =>
      computeClaimH({ claimSecret: P + 999n, amount: 1_000_000n, snDomain: 25n }),
    ).toThrow();
  });

  it('throws when snDomain >= P', () => {
    expect(() =>
      computeClaimH({ claimSecret: 12345n, amount: 1_000_000n, snDomain: P }),
    ).toThrow();
  });

  it('does not throw for in-range felt values (P-1n is the largest valid felt)', () => {
    expect(() =>
      computeClaimH({ claimSecret: P - 1n, amount: P - 1n, snDomain: 25n }),
    ).not.toThrow();
  });

  it('a non-canonical amount (P+1n) and its canonical twin (1n) must NOT silently share the same H', () => {
    // Before fix: both calls succeed and return the same value (silent collision).
    // After fix: the out-of-range call throws, so equality can never happen.
    const canonicalH = computeClaimH({ claimSecret: 12345n, amount: 1n, snDomain: 25n });
    expect(() =>
      computeClaimH({ claimSecret: 12345n, amount: P + 1n, snDomain: 25n }),
    ).toThrow();
    // Confirm canonical call still works.
    expect(canonicalH).toBeTypeOf('bigint');
  });
});
