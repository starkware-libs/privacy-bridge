// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { describe, expect, it } from 'vitest';
import { ec, hash } from 'starknet';
import { hexToBytes } from '@noble/curves/abstract/utils';
import { deriveStarknetAccount, deriveStarknetPrivateKey } from './starknet-key.js';

// Regression: deriveStarknetPrivateKey must return a CANONICAL 32-byte
// (64-nibble) lowercase 0x-hex string. `grindKey` strips leading zeros and
// returns a variable/odd-width body (often 63 nibbles); without padding, noble's
// hexToBytes throws "hex string expected, got unpadded hex" on an odd body and
// Buffer.from(body,'hex') silently truncates to 31 bytes. The sibling
// derivePolygonEoa already pads with `.padStart(64, '0')`. These were RED before
// the padding fix and are GREEN after; they also re-assert that padding leading
// zeros does NOT change the derived account address.

// ── Reproducible randomness (mirrors derivation.fuzz.test.ts verbatim) ──────
const FUZZ_SEED = 0x9e3779b9;
const N = 500;

function makeRng(seed: number) {
  let x = (seed ^ 0x12345678) >>> 0;
  let y = (seed ^ 0x9abcdef0) >>> 0 || 1;
  let z = (seed ^ 0xfedcba98) >>> 0 || 2;
  let w = (seed ^ 0x13579bdf) >>> 0 || 3;
  return function next(): number {
    const t = (x ^ (x << 11)) >>> 0;
    x = y;
    y = z;
    z = w;
    w = (w ^ (w >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    return w;
  };
}

const HEX_CHARS = '0123456789abcdef';

function randomSignature(rng: () => number): string {
  const roll = rng() % 10;
  let nibbles: number;
  if (roll < 7) nibbles = 130;
  else if (roll === 7) nibbles = 2 + (rng() % 200);
  else nibbles = 130 + (rng() % 130);
  let s = '0x';
  for (let i = 0; i < nibbles; i++) {
    let c = HEX_CHARS[rng() % 16];
    if (rng() % 2 === 0) c = c.toUpperCase();
    s += c;
  }
  return s;
}

const rng = makeRng(FUZZ_SEED);
const SIGNATURES: string[] = Array.from({ length: N }, () => randomSignature(rng));

const CANONICAL_RE = /^0x[0-9a-f]{64}$/;
const CLASS_HASH = '0x5b4b537eaa2399e3aa99c4e2e0208ebd6c71bc1467938cd52c798c601e43564';

describe(`deriveStarknetPrivateKey canonical 32-byte hex (N=${N}, seed=0x${FUZZ_SEED.toString(16)})`, () => {
  it('always returns 0x + exactly 64 lowercase hex nibbles', () => {
    for (const sig of SIGNATURES) {
      expect(deriveStarknetPrivateKey(sig)).toMatch(CANONICAL_RE);
    }
  });

  it('the body parses as a non-throwing, exactly 32-byte buffer (noble + Buffer)', () => {
    for (const sig of SIGNATURES) {
      const body = deriveStarknetPrivateKey(sig).slice(2);
      // noble hexToBytes throws on unpadded/odd-width hex — must not throw.
      expect(() => hexToBytes(body)).not.toThrow();
      expect(hexToBytes(body).length).toBe(32);
      // Buffer.from(body,'hex') silently truncated to 31 bytes on odd width.
      expect(Buffer.from(body, 'hex').length).toBe(32);
    }
  });

  it('padding leaves the public key and account address unchanged (scalar invariant)', () => {
    for (const sig of SIGNATURES) {
      const padded = deriveStarknetPrivateKey(sig);
      // The unpadded form is the same scalar with leading zeros stripped; both
      // must yield the identical stark public key and the identical address.
      const unpadded = `0x${BigInt(padded).toString(16)}`;
      const pubPadded = ec.starkCurve.getStarkKey(padded);
      const pubUnpadded = ec.starkCurve.getStarkKey(unpadded);
      expect(pubPadded).toBe(pubUnpadded);

      const acct = deriveStarknetAccount(padded, CLASS_HASH);
      const expectedAddr = hash.calculateContractAddressFromHash(
        pubUnpadded,
        CLASS_HASH,
        [pubUnpadded],
        0,
      );
      expect(acct.address).toBe(expectedAddr);
    }
  });
});
