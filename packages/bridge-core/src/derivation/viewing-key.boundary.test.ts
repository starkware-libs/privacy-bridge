/**
 * Boundary tests for the deriveViewingKey fold.
 *
 * The fold formula is:
 *   canonical = reduced < MAX_VIEWING_KEY ? reduced : order - reduced
 *
 * The Stark curve order is odd: order = 2 * MAX + 1.
 * At the two boundary seeds:
 *   reduced = MAX     → order - MAX = MAX + 1  (>= MAX_VIEWING_KEY, out of range)
 *   reduced = MAX + 1 → order - (MAX+1) = MAX  (>= MAX_VIEWING_KEY, out of range)
 *
 * These are tested via the exported `foldToCanonical` helper which isolates
 * the fold + clamp logic so the boundary can be exercised directly without
 * inverting keccak.
 *
 * Tracks: https://github.com/starkware-libs/polymarket-privacy/issues/40
 */
import { describe, expect, it } from 'vitest';
import { ec } from 'starknet';
import { MAX_VIEWING_KEY, foldToCanonical } from './viewing-key.js';

const ORDER = ec.starkCurve.CURVE.n;

describe('foldToCanonical boundary (issue #40)', () => {
  it('fold(MAX_VIEWING_KEY) stays strictly inside [1, MAX_VIEWING_KEY)', () => {
    // reduced === MAX → buggy fold returns MAX + 1, which is >= MAX_VIEWING_KEY
    const result = foldToCanonical(MAX_VIEWING_KEY, ORDER);
    expect(result).toBeGreaterThan(0n);
    expect(result).toBeLessThan(MAX_VIEWING_KEY);
  });

  it('fold(MAX_VIEWING_KEY + 1n) stays strictly inside [1, MAX_VIEWING_KEY)', () => {
    // reduced === MAX + 1 → buggy fold returns MAX, which equals MAX_VIEWING_KEY (out of exclusive range)
    const result = foldToCanonical(MAX_VIEWING_KEY + 1n, ORDER);
    expect(result).toBeGreaterThan(0n);
    expect(result).toBeLessThan(MAX_VIEWING_KEY);
  });

  it('fold(0n) returns 1n (zero bump)', () => {
    expect(foldToCanonical(0n, ORDER)).toBe(1n);
  });

  it('fold leaves non-boundary values in the lower half unchanged', () => {
    // Values well within [1, MAX) should pass through unchanged
    expect(foldToCanonical(1n, ORDER)).toBe(1n);
    expect(foldToCanonical(MAX_VIEWING_KEY - 1n, ORDER)).toBe(MAX_VIEWING_KEY - 1n);
    expect(foldToCanonical(1000n, ORDER)).toBe(1000n);
  });

  it('fold maps the upper half (not boundary) down into [1, MAX)', () => {
    // A value well in the upper half, away from the boundary
    // reduced = order - 2n → fold = 2n (in range)
    expect(foldToCanonical(ORDER - 2n, ORDER)).toBe(2n);
    // reduced = order - 1n → fold = 1n (in range)
    expect(foldToCanonical(ORDER - 1n, ORDER)).toBe(1n);
  });
});
