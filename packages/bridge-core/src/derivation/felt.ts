// Shared STARK-felt Poseidon helpers for this package's H-scheme derivations
// (claim-commitment.ts, inbound-commitment.ts). Centralized so the STARK prime
// and the canonical-range check can't drift between call sites (issues #41/#42).

import { hash } from 'starknet';

// STARK field prime P (felt252 modulus). Any value ≥ P is non-canonical and
// reduces silently inside Poseidon, causing distinct inputs to collide.
export const STARK_P =
  3618502788666131213697322783095070105623107215331596699973092056135872020481n;

export function poseidon(elements: bigint[]): bigint {
  return BigInt(hash.computePoseidonHashOnElements(elements));
}

// Reject a non-canonical felt: negative, or >= P (which reduces silently mod P
// inside Poseidon and collides with its canonical twin).
export function assertCanonicalFelt(name: string, v: bigint): void {
  if (v < 0n) throw new Error(`${name} must be non-negative`);
  if (v >= STARK_P) throw new Error(`${name} out of felt range [0, P)`);
}
