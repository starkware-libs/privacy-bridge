import { describe, expect, it } from 'vitest';
import { deriveAccountNonce, deriveClaimSecret } from './claim-commitment.js';

// Regression test for issue #42:
// deriveAccountNonce/deriveClaimSecret lose precision for tradeCounter passed as a
// JS number > 2^53 (Number.MAX_SAFE_INTEGER).
//
// IEEE-754 rounding: 2**53 + 1 cannot be represented exactly as a double and
// rounds to 2**53, so BigInt(2**53 + 1) === BigInt(2**53). Two distinct
// intended counters collapse to the same value → same nonce → same
// claim_secret → colliding/linkable accounts.
//
// RED before fix (no isSafeInteger guard — unsafe numbers pass silently).
// GREEN after fix (throws when typeof number && !Number.isSafeInteger).

const VIEWING_KEY = 0xdeadbeefn;

describe('deriveAccountNonce unsafe-number guard (issue #42)', () => {
  it('throws when tradeCounter is a number > Number.MAX_SAFE_INTEGER', () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1; // = 2^53; rounds from 2^53+1
    // The intent was 2^53+1 but float rounding already collapsed it to 2^53.
    expect(() => deriveAccountNonce(VIEWING_KEY, unsafe)).toThrow(
      /safe integer/i,
    );
  });

  it('throws for 2**53 + 1 (the first integer that collides as a double — aliases to 2**53)', () => {
    // 2**53+1 is not representable as a float and rounds to 2**53; both intend
    // different counters but produce the same double. The guard fires on both.
    expect(() => deriveAccountNonce(VIEWING_KEY, 2 ** 53 + 1)).toThrow();
  });

  it('does not throw for a bigint counter above MAX_SAFE_INTEGER (no precision loss)', () => {
    const safeBigInt = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    expect(() => deriveAccountNonce(VIEWING_KEY, safeBigInt)).not.toThrow();
  });

  it('does not throw for safe number counters', () => {
    expect(() => deriveAccountNonce(VIEWING_KEY, 0)).not.toThrow();
    expect(() => deriveAccountNonce(VIEWING_KEY, Number.MAX_SAFE_INTEGER)).not.toThrow();
  });

  it('two unsafe numbers that are actually the same double still both throw rather than silently collide', () => {
    // 2**53 + 1 and 2**53 are both the same double (9007199254740992).
    // After fix, both throw when passed as number — no silent collision possible.
    expect(() => deriveAccountNonce(VIEWING_KEY, 2 ** 53 + 1)).toThrow();
    // 2**53 itself is == MAX_SAFE_INTEGER + 1, which is NOT safe.
    expect(() => deriveAccountNonce(VIEWING_KEY, 2 ** 53)).toThrow();
  });

  it('deriveClaimSecret (which takes bigint) is unaffected — no guard needed there', () => {
    // deriveClaimSecret accepts only bigint for accountNonce — no number path.
    const nonce = deriveAccountNonce(VIEWING_KEY, 5n);
    expect(() => deriveClaimSecret(VIEWING_KEY, nonce)).not.toThrow();
  });
});
