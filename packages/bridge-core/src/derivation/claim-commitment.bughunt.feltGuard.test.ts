// Bug-hunt B1: deriveAccountNonce / deriveClaimSecret pass their bigint args
// straight into Poseidon with NO felt-range check (upper bound < STARK_P).
// Poseidon silently reduces mod P inside the hash, so a non-canonical bigint
// (e.g. `viewingKey + P`) collides with its canonical twin (`viewingKey`),
// producing the same account_nonce / claim_secret.
//
// #41 (bridge-hunt) added the equivalent guard to `computeClaimH` — the
// same defensive pattern must also apply to the recovery-recipe helpers
// otherwise a bug or fuzz input upstream can silently
// map two distinct intended VKs / nonces to the same secret.
//
// RED on current main (no upper-bound guard); would go GREEN after adding
// symmetric felt-range guards to both helpers.

import { describe, expect, it } from 'vitest';
import { deriveAccountNonce, deriveClaimSecret } from './claim-commitment.js';

// STARK field prime P — same constant `computeClaimH` uses internally
// (see claim-commitment.ts). Anything ≥ P is non-canonical and reduces
// silently mod P inside Poseidon.
const STARK_P =
  3618502788666131213697322783095070105623107215331596699973092056135872020481n;

describe('deriveAccountNonce felt-range upper-bound guard (bug-hunt B1)', () => {
  it('rejects a non-canonical viewingKey (>= P) OR does not collide with its canonical twin', () => {
    const vk = 5n;
    const nonCanonicalVk = vk + STARK_P; // reduces to `vk` inside Poseidon

    // Either the guard throws on the out-of-range input, OR the outputs
    // must differ. Current main: neither — the values silently collide.
    let threw = false;
    let collidingValue: bigint | null = null;
    try {
      collidingValue = deriveAccountNonce(nonCanonicalVk, 0);
    } catch {
      threw = true;
    }
    const canonicalValue = deriveAccountNonce(vk, 0);

    if (threw) return; // guarded — good.
    expect(collidingValue).not.toBe(canonicalValue);
  });

  it('rejects a non-canonical tradeCounter (>= P as bigint) OR does not collide with its canonical twin', () => {
    const vk = 12345n;
    const ctr = 1n;
    const nonCanonicalCtr = STARK_P + ctr; // reduces to `ctr` inside Poseidon

    let threw = false;
    let collidingValue: bigint | null = null;
    try {
      collidingValue = deriveAccountNonce(vk, nonCanonicalCtr);
    } catch {
      threw = true;
    }
    const canonicalValue = deriveAccountNonce(vk, ctr);

    if (threw) return;
    expect(collidingValue).not.toBe(canonicalValue);
  });
});

describe('deriveClaimSecret felt-range upper-bound guard (bug-hunt B1)', () => {
  it('rejects a non-canonical viewingKey (>= P) OR does not collide with its canonical twin', () => {
    const vk = 7n;
    const accountNonce = 42n;
    const nonCanonicalVk = vk + STARK_P;

    let threw = false;
    let collidingValue: bigint | null = null;
    try {
      collidingValue = deriveClaimSecret(nonCanonicalVk, accountNonce);
    } catch {
      threw = true;
    }
    const canonicalValue = deriveClaimSecret(vk, accountNonce);

    if (threw) return;
    expect(collidingValue).not.toBe(canonicalValue);
  });

  it('rejects a non-canonical accountNonce (>= P) OR does not collide with its canonical twin', () => {
    const vk = 12345n;
    const accountNonce = 999n;
    const nonCanonicalNonce = STARK_P + accountNonce;

    let threw = false;
    let collidingValue: bigint | null = null;
    try {
      collidingValue = deriveClaimSecret(vk, nonCanonicalNonce);
    } catch {
      threw = true;
    }
    const canonicalValue = deriveClaimSecret(vk, accountNonce);

    if (threw) return;
    expect(collidingValue).not.toBe(canonicalValue);
  });
});
