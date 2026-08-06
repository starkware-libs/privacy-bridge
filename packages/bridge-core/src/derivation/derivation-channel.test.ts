// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Backward-compat + separation guarantees for the account-CHANNEL derivation.
//
// The channel param on derivePolygonEoa / deriveAccountNonce MUST reproduce the
// exact pre-channel output when `channel` is undefined (or every existing user's
// wallet + pool commitment becomes unrecoverable). We prove that against a VERBATIM
// copy of the pre-change implementations (the `legacy*` oracles below) over many
// inputs — not a handful of golden vectors — and separately prove that any named
// channel yields a distinct wallet + nonce.
import { describe, expect, it } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { secp256k1 } from '@noble/curves/secp256k1';
import { POLYGON_EOA_LABEL } from './messages.js';
import { derivePolygonEoa } from './polygon-key.js';
import { ACCOUNT_NONCE_TAG, deriveAccountNonce } from './claim-commitment.js';
import { assertCanonicalFelt, poseidon } from './felt.js';

const N = secp256k1.CURVE.n;

// ── verbatim copies of the pre-channel implementations (oracles) ──
function toChecksumAddress(lowerHex40: string): string {
  const hashHex = bytesToHex(keccak_256(utf8ToBytes(lowerHex40)));
  let out = '0x';
  for (let i = 0; i < lowerHex40.length; i++) {
    const c = lowerHex40[i];
    out += parseInt(hashHex[i], 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

function legacyDerivePolygonEoa(evmSignature: string, accountIndex: number): { privateKey: string; address: string } {
  const seed = keccak_256(utf8ToBytes(`${evmSignature}:${POLYGON_EOA_LABEL}:${accountIndex}`));
  const reduced = BigInt('0x' + bytesToHex(seed)) % N;
  const scalar = reduced === 0n ? 1n : reduced;
  const privateKey = '0x' + scalar.toString(16).padStart(64, '0');
  const pub = secp256k1.getPublicKey(scalar, false);
  const digest = keccak_256(pub.subarray(1));
  const address = toChecksumAddress(bytesToHex(digest.subarray(-20)));
  return { privateKey, address };
}

function legacyDeriveAccountNonce(viewingKey: bigint, tradeCounter: number | bigint): bigint {
  const counter = BigInt(tradeCounter);
  assertCanonicalFelt('tradeCounter', counter);
  assertCanonicalFelt('viewingKey', viewingKey);
  return poseidon([ACCOUNT_NONCE_TAG, viewingKey, counter]);
}

const SIGS = [
  `0x${'ab'.repeat(32)}`,
  `0x${'12'.repeat(65)}`, // a longer, distinct signature
];
const VK = 0x1234_5678_9abc_def0_1234_5678_9abc_def0n;
const CHANNEL = 'fast-session';

describe('account-channel derivation — backward compat (oracle) + separation', () => {
  it('default (no channel) derivePolygonEoa is byte-identical to the legacy impl', () => {
    for (const sig of SIGS) {
      for (let i = 0; i <= 40; i++) {
        const now = derivePolygonEoa(sig, i);
        const old = legacyDerivePolygonEoa(sig, i);
        expect(now.privateKey).toBe(old.privateKey);
        expect(now.address).toBe(old.address);
      }
    }
  });

  it('default (no channel) deriveAccountNonce is byte-identical to the legacy impl', () => {
    for (let i = 0; i <= 40; i++) {
      expect(deriveAccountNonce(VK, i)).toBe(legacyDeriveAccountNonce(VK, i));
    }
  });

  it('a named channel yields a DIFFERENT EOA + nonce than the default at the same index', () => {
    for (let i = 0; i <= 5; i++) {
      expect(derivePolygonEoa(SIGS[0], i, CHANNEL).address).not.toBe(derivePolygonEoa(SIGS[0], i).address);
      expect(deriveAccountNonce(VK, i, CHANNEL)).not.toBe(deriveAccountNonce(VK, i));
    }
  });

  it('different channels are mutually distinct at the same index', () => {
    expect(derivePolygonEoa(SIGS[0], 0, 'a').address).not.toBe(derivePolygonEoa(SIGS[0], 0, 'b').address);
    expect(deriveAccountNonce(VK, 0, 'a')).not.toBe(deriveAccountNonce(VK, 0, 'b'));
  });

  it('is deterministic for the same (sig/vk, index, channel)', () => {
    expect(derivePolygonEoa(SIGS[0], 3, CHANNEL)).toEqual(derivePolygonEoa(SIGS[0], 3, CHANNEL));
    expect(deriveAccountNonce(VK, 3, CHANNEL)).toBe(deriveAccountNonce(VK, 3, CHANNEL));
  });
});

describe('account-channel validation — symmetric across both derivation roots', () => {
  // Both roots must accept/reject the SAME channels, or a channel could derive a
  // Polygon EOA but throw when deriving the recoverable commitment (fund-but-can't-recover).
  const INVALID = ['', 'a'.repeat(32), 'has space', 'has:colon', 'café'];

  it('both roots reject the same invalid channels', () => {
    for (const ch of INVALID) {
      expect(() => derivePolygonEoa(SIGS[0], 0, ch), ch).toThrow();
      expect(() => deriveAccountNonce(VK, 0, ch), ch).toThrow();
    }
  });

  it('both roots accept a valid slug channel', () => {
    expect(() => derivePolygonEoa(SIGS[0], 0, 'fast-session')).not.toThrow();
    expect(() => deriveAccountNonce(VK, 0, 'fast-session')).not.toThrow();
  });

  it('a digit-string channel cannot alias a default index (no cross-keyspace collision)', () => {
    // channel '5' at index 0 must NOT equal the default channel's index-5 wallet —
    // the ':'-delimited preimage keeps them disjoint.
    expect(derivePolygonEoa(SIGS[0], 0, '5').address).not.toBe(derivePolygonEoa(SIGS[0], 5).address);
  });
});
