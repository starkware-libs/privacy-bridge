// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { describe, expect, it } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { deriveReturnWalKeys } from './return-wal.js';
import {
  RETURN_WAL_LABEL,
  STARKNET_KEY_LABEL,
  VIEWING_KEY_LABEL,
  POLYGON_EOA_LABEL,
} from './messages.js';

// Fixed throwaway fixtures — no real keys.
const SIGNATURE =
  '0x' +
  'deadbeefcafef00d1234567890abcdef' +
  'fedcba0987654321deadbeefcafef00d' +
  '00112233445566778899aabbccddeeff' +
  'ffeeddccbbaa99887766554433221100' +
  '1b';
const SN_ADDRESS = '0x04a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f';

// Frozen vector: the label + preimages ARE the WAL keyspace. Drift in `id`
// orphans every open entry; drift in `encKey` silently breaks decryption of
// every stored entry.
const EXPECTED_ID = '86021b138afd58cf999fff40d3b30ed1311a770af6e06e694b5884e90ce83dba';
const EXPECTED_ENC_KEY_HEX = '88ddb2ee36a484e2e08bd822139815a9b8bc5e60bdd8111983569df83d5abe28';

describe('RETURN_WAL_LABEL', () => {
  it('is pinned and distinct from every other derivation label', () => {
    expect(RETURN_WAL_LABEL).toBe('open-return-bound:v1');
    expect(RETURN_WAL_LABEL).not.toBe(STARKNET_KEY_LABEL);
    expect(RETURN_WAL_LABEL).not.toBe(VIEWING_KEY_LABEL);
    expect(RETURN_WAL_LABEL).not.toBe(POLYGON_EOA_LABEL);
  });
});

describe('deriveReturnWalKeys', () => {
  it('reproduces the frozen vector for the fixed fixtures', () => {
    const keys = deriveReturnWalKeys(SIGNATURE, SN_ADDRESS);
    expect(keys.id).toBe(EXPECTED_ID);
    expect(bytesToHex(keys.encKey)).toBe(EXPECTED_ENC_KEY_HEX);
  });

  it('is deterministic in (signature, address)', () => {
    const a = deriveReturnWalKeys(SIGNATURE, SN_ADDRESS);
    const b = deriveReturnWalKeys(SIGNATURE, SN_ADDRESS);
    expect(a.id).toBe(b.id);
    expect(bytesToHex(a.encKey)).toBe(bytesToHex(b.encKey));
  });

  it('returns a 64-lowercase-hex unprefixed id and a 32-byte enc key', () => {
    const keys = deriveReturnWalKeys(SIGNATURE, SN_ADDRESS);
    expect(keys.id).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.encKey).toBeInstanceOf(Uint8Array);
    expect(keys.encKey.length).toBe(32);
  });

  it('derives two independent limbs — the id is not the enc key', () => {
    const keys = deriveReturnWalKeys(SIGNATURE, SN_ADDRESS);
    expect(keys.id).not.toBe(bytesToHex(keys.encKey));
  });

  it('changes both limbs when a single signature character changes', () => {
    const base = deriveReturnWalKeys(SIGNATURE, SN_ADDRESS);
    const tweaked = deriveReturnWalKeys(SIGNATURE.slice(0, -1) + 'c', SN_ADDRESS);
    expect(tweaked.id).not.toBe(base.id);
    expect(bytesToHex(tweaked.encKey)).not.toBe(bytesToHex(base.encKey));
  });

  it('changes both limbs for a different Starknet address', () => {
    const base = deriveReturnWalKeys(SIGNATURE, SN_ADDRESS);
    const other = deriveReturnWalKeys(
      SIGNATURE,
      '0x0111111111111111111111111111111111111111111111111111111111111111',
    );
    expect(other.id).not.toBe(base.id);
    expect(bytesToHex(other.encKey)).not.toBe(bytesToHex(base.encKey));
  });

  it('scopes the keyspace to the label version', () => {
    const keys = deriveReturnWalKeys(SIGNATURE, SN_ADDRESS);
    const v2Id = bytesToHex(
      keccak_256(utf8ToBytes(`${SIGNATURE}:open-return-bound:v2:id:${SN_ADDRESS.toLowerCase()}`)),
    );
    const v2Enc = bytesToHex(
      keccak_256(utf8ToBytes(`${SIGNATURE}:open-return-bound:v2:enc:${SN_ADDRESS.toLowerCase()}`)),
    );
    expect(keys.id).not.toBe(v2Id);
    expect(bytesToHex(keys.encKey)).not.toBe(v2Enc);
  });

  it('canonicalizes address casing and zero-padding to ONE keyspace', () => {
    const base = deriveReturnWalKeys(SIGNATURE, SN_ADDRESS);
    const upper = deriveReturnWalKeys(SIGNATURE, SN_ADDRESS.toUpperCase().replace('0X', '0x'));
    const unpadded = deriveReturnWalKeys(SIGNATURE, '0x' + SN_ADDRESS.slice(2).replace(/^0+/, ''));
    expect(upper.id).toBe(base.id);
    expect(unpadded.id).toBe(base.id);
    expect(bytesToHex(unpadded.encKey)).toBe(bytesToHex(base.encKey));
  });

  it('rejects an empty signature rather than hashing garbage', () => {
    expect(() => deriveReturnWalKeys('', SN_ADDRESS)).toThrow(/signature/i);
  });

  it('rejects a malformed Starknet address', () => {
    expect(() => deriveReturnWalKeys(SIGNATURE, '')).toThrow(/address/i);
    expect(() => deriveReturnWalKeys(SIGNATURE, '0x')).toThrow(/address/i);
    expect(() => deriveReturnWalKeys(SIGNATURE, '04a1b2')).toThrow(/address/i);
    expect(() => deriveReturnWalKeys(SIGNATURE, '0xzz11')).toThrow(/address/i);
    expect(() => deriveReturnWalKeys(SIGNATURE, '0x' + 'a'.repeat(65))).toThrow(/address/i);
  });
});
