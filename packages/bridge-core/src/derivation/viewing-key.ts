import { ec, hash } from 'starknet';
import { VIEWING_KEY_LABEL } from './messages.js';

// The pool enforces `1 <= k < ORDER/2` (canonical viewing key). MAX_VIEWING_KEY
// equals the SDK's constant of the same name (CURVE.n / 2n); kept local so this
// package depends only on `starknet`.
export const MAX_VIEWING_KEY = ec.starkCurve.CURVE.n / 2n;

// Fold a reduced seed value (in [0, ORDER)) into the canonical viewing-key range
// [1, MAX_VIEWING_KEY). Exported for boundary testing (issue #40).
//
// The Stark curve order is odd (order = 2 * MAX + 1), so the two boundary seeds
//   reduced === MAX     → order - MAX = MAX + 1  (would escape the range)
//   reduced === MAX + 1 → order - (MAX+1) = MAX  (equals MAX, still out of exclusive range)
// are clamped to MAX - 1 (the largest valid canonical key). The probability of
// hitting either boundary through the normal signature-hash path is ~2⁻²⁵¹.
export function foldToCanonical(reduced: bigint, order: bigint): bigint {
  const max = order / 2n; // MAX_VIEWING_KEY, re-derived to avoid circular import
  let canonical = reduced < max ? reduced : order - reduced;
  // Clamp the two boundary seeds that escape [1, MAX):
  //   reduced = MAX   → fold = MAX + 1 (too high) → clamp to MAX - 1
  //   reduced = MAX+1 → fold = MAX     (= upper bound, exclusive) → clamp to MAX - 1
  if (canonical >= max) canonical = max - 1n;
  // Bump the vanishingly unlikely zero (reduced === 0) to 1.
  return canonical === 0n ? 1n : canonical;
}

// Derive the privacy-pool viewing key from an EVM wallet signature.
//
// Mirrors `starknet-privacy/demo/src/session.ts:deriveViewingKey`, but seeds
// from the EVM signature + label instead of a stark-curve ECDSA signature.
//
// `starknetKeccak` returns ≤250 bits, so a single hash could only ever land in
// `[0, 2^250)` — the upper half of the canonical range was unreachable and the
// fold-down branch was dead code. We instead build a >256-bit seed from two
// domain-separated keccak limbs (`:0` / `:1`), reduce mod ORDER, then fold the
// upper half down (`ORDER - reduced`). This genuinely exercises the full
// `[1, MAX_VIEWING_KEY)` range and matches the Cairo `is_canonical_key` helper;
// 0 is bumped to 1 for the vanishingly unlikely case. Deterministic in the
// signature (same signature → same key).
export function deriveViewingKey(evmSignature: string): bigint {
  const base = `${evmSignature}:${VIEWING_KEY_LABEL}`;
  const lo = BigInt(hash.starknetKeccak(`${base}:0`));
  const hi = BigInt(hash.starknetKeccak(`${base}:1`));
  // Two ≤250-bit limbs → a ≤500-bit seed, comfortably wider than ORDER so the
  // reduced value spans [0, ORDER) and the fold branch is reachable.
  const seed = (hi << 250n) | lo;
  const order = ec.starkCurve.CURVE.n;
  const reduced = seed % order;
  return foldToCanonical(reduced, order);
}
