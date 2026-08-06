// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { describe, expect, it } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { POLYGON_EOA_LABEL } from './messages.js';
import { derivePolygonEoa } from './polygon-key.js';
import { deriveStarknetPrivateKey } from './starknet-key.js';
import { deriveViewingKey } from './viewing-key.js';

// Fixed 65-byte EVM signatures (0x + 130 hex chars) — the shape MetaMask's
// personal_sign returns (r[32] + s[32] + v[1]). Pure fixtures, no real keys.
const SIG_A = `0x${'11'.repeat(65)}`;
const SIG_B = `0x${'ab'.repeat(65)}`;
const SIG_C =
  '0x' +
  'deadbeefcafef00d1234567890abcdef' +
  'fedcba0987654321deadbeefcafef00d' +
  '00112233445566778899aabbccddeeff' +
  'ffeeddccbbaa99887766554433221100' +
  '1b';

const SIGS = [SIG_A, SIG_B, SIG_C];

const N = secp256k1.CURVE.n;
const PRIVKEY_RE = /^0x[0-9a-f]{64}$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

// Independent EIP-55 implementation (mirrors the reference algorithm) so the
// checksum assertion does not just re-run the code under test.
function eip55(addrNo0x: string): string {
  const lower = addrNo0x.toLowerCase();
  const enc = new TextEncoder().encode(lower);
  let h = '';
  for (const b of keccak_256(enc)) h += b.toString(16).padStart(2, '0');
  let out = '0x';
  for (let i = 0; i < lower.length; i++) {
    out += parseInt(h[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

describe('POLYGON_EOA_LABEL', () => {
  it('is a distinct, versioned domain-separation label', () => {
    expect(POLYGON_EOA_LABEL).toBe('polygon-eoa:v1');
  });
});

describe('derivePolygonEoa', () => {
  it('is deterministic: same (signature, index) => same address + key', () => {
    for (const sig of SIGS) {
      for (const idx of [0, 1, 7]) {
        expect(derivePolygonEoa(sig, idx)).toEqual(derivePolygonEoa(sig, idx));
      }
    }
  });

  it('returns a 0x-prefixed 32-byte (64-hex) lowercase private key', () => {
    for (const sig of SIGS) {
      expect(derivePolygonEoa(sig, 0).privateKey).toMatch(PRIVKEY_RE);
    }
  });

  it('keeps the private key strictly inside (0, secp256k1 n)', () => {
    // Sweep many (sig, index) pairs to exercise the scalar reduction broadly.
    for (const sig of SIGS) {
      for (let idx = 0; idx < 64; idx++) {
        const value = BigInt(derivePolygonEoa(sig, idx).privateKey);
        expect(value).toBeGreaterThan(0n);
        expect(value).toBeLessThan(N);
      }
    }
  });

  it('produces a valid 0x40-hex EVM address with a correct EIP-55 checksum', () => {
    for (const sig of SIGS) {
      const { address } = derivePolygonEoa(sig, 0);
      expect(address).toMatch(ADDR_RE);
      // Re-checksum the lowercased address independently and require equality.
      expect(address).toBe(eip55(address.slice(2)));
    }
  });

  it('derives the address from the secp256k1 pubkey (keccak of pub[1:65], last 20 bytes)', () => {
    // Recompute the whole pipeline independently from the returned private key.
    for (const sig of SIGS) {
      const { privateKey, address } = derivePolygonEoa(sig, 3);
      const scalar = BigInt(privateKey);
      const pub = secp256k1.getPublicKey(scalar, false);
      expect(pub.length).toBe(65);
      expect(pub[0]).toBe(0x04);
      const digest = keccak_256(pub.subarray(1));
      let lower = '';
      for (const b of digest.subarray(-20)) lower += b.toString(16).padStart(2, '0');
      expect(address).toBe(eip55(lower));
    }
  });

  it('yields distinct addresses for indices 0, 1, 2 under the same signature', () => {
    for (const sig of SIGS) {
      const addrs = [0, 1, 2].map((i) => derivePolygonEoa(sig, i).address);
      expect(new Set(addrs).size).toBe(3);
      // Keys differ too, not just the addresses.
      const keys = [0, 1, 2].map((i) => derivePolygonEoa(sig, i).privateKey);
      expect(new Set(keys).size).toBe(3);
    }
  });

  it('yields distinct addresses across signatures at a fixed index', () => {
    const addrs = SIGS.map((sig) => derivePolygonEoa(sig, 0).address);
    expect(new Set(addrs).size).toBe(SIGS.length);
  });

  it('domain-separates from the Starknet account key and viewing key (same signature)', () => {
    for (const sig of SIGS) {
      // Same secret input (the signature); only the label/path differ. The
      // Polygon scalar must be unrelated to the SN private key and viewing key.
      const polyKey = BigInt(derivePolygonEoa(sig, 0).privateKey);
      const snKey = BigInt(deriveStarknetPrivateKey(sig));
      const viewKey = deriveViewingKey(sig);
      expect(polyKey).not.toBe(snKey);
      expect(polyKey).not.toBe(viewKey);

      // And the underlying seed differs purely by label — swapping the label
      // (with the index suffix) changes the keccak seed.
      const polySeed = keccak_256(new TextEncoder().encode(`${sig}:${POLYGON_EOA_LABEL}:0`));
      const otherSeed = keccak_256(new TextEncoder().encode(`${sig}:starknet-account:v1:0`));
      expect(Buffer.from(polySeed).toString('hex')).not.toBe(
        Buffer.from(otherSeed).toString('hex'),
      );
    }
  });

  it('rejects an invalid accountIndex', () => {
    expect(() => derivePolygonEoa(SIG_A, -1)).toThrow();
    expect(() => derivePolygonEoa(SIG_A, 1.5)).toThrow();
  });
});
