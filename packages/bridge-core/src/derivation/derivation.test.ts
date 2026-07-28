// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { describe, expect, it } from 'vitest';
import { ec, hash } from 'starknet';
import { STARKNET_KEY_LABEL, VIEWING_KEY_LABEL } from './messages.js';
import { deriveStarknetAccount, deriveStarknetPrivateKey } from './starknet-key.js';
import { MAX_VIEWING_KEY, deriveViewingKey } from './viewing-key.js';

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

// An OpenZeppelin-style account class hash; only its determinism matters here.
const CLASS_HASH = '0x61dac032f228abef9c6626f995015233097ae253a7f72d68552db02f2971b8f';

const HEX_RE = /^0x[0-9a-f]+$/;

describe('messages', () => {
  it('uses distinct, versioned domain-separation labels', () => {
    expect(STARKNET_KEY_LABEL).toBe('starknet-account:v1');
    expect(VIEWING_KEY_LABEL).toBe('viewing-key:v1');
    expect(STARKNET_KEY_LABEL).not.toBe(VIEWING_KEY_LABEL);
  });
});

describe('deriveStarknetPrivateKey', () => {
  it('is deterministic for the same signature', () => {
    for (const sig of SIGS) {
      expect(deriveStarknetPrivateKey(sig)).toBe(deriveStarknetPrivateKey(sig));
    }
  });

  it('returns a 0x-prefixed lowercase hex string', () => {
    for (const sig of SIGS) {
      const pk = deriveStarknetPrivateKey(sig);
      expect(pk).toMatch(HEX_RE);
    }
  });

  it('produces a value strictly inside (0, CURVE.n)', () => {
    for (const sig of SIGS) {
      const value = BigInt(deriveStarknetPrivateKey(sig));
      expect(value).toBeGreaterThan(0n);
      expect(value).toBeLessThan(ec.starkCurve.CURVE.n);
    }
  });

  it('yields different keys for different signatures', () => {
    const keys = SIGS.map(deriveStarknetPrivateKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('separates the key-domain from the viewing-key domain for the same signature', () => {
    // Both seeds start from the same signature; only the label differs.
    for (const sig of SIGS) {
      const keySeed = hash.starknetKeccak(`${sig}:${STARKNET_KEY_LABEL}`);
      const viewSeed = hash.starknetKeccak(`${sig}:${VIEWING_KEY_LABEL}`);
      expect(keySeed).not.toBe(viewSeed);

      // The downstream private key and viewing key must also be unrelated.
      const privKey = BigInt(deriveStarknetPrivateKey(sig));
      const viewKey = deriveViewingKey(sig);
      expect(privKey).not.toBe(viewKey);
    }
  });
});

describe('deriveStarknetAccount', () => {
  it('matches getStarkKey for the public key and is deterministic', () => {
    for (const sig of SIGS) {
      const privKey = deriveStarknetPrivateKey(sig);
      const account = deriveStarknetAccount(privKey, CLASS_HASH);
      const again = deriveStarknetAccount(privKey, CLASS_HASH);

      expect(account.publicKey).toBe(ec.starkCurve.getStarkKey(privKey));
      expect(account).toEqual(again);
    }
  });

  it('derives the address via calculateContractAddressFromHash(publicKey, classHash, [publicKey], 0)', () => {
    for (const sig of SIGS) {
      const privKey = deriveStarknetPrivateKey(sig);
      const account = deriveStarknetAccount(privKey, CLASS_HASH);
      const expected = hash.calculateContractAddressFromHash(
        account.publicKey,
        CLASS_HASH,
        [account.publicKey],
        0,
      );
      expect(account.address).toBe(expected);
      expect(account.address).toMatch(HEX_RE);
    }
  });
});

describe('deriveViewingKey', () => {
  it('is deterministic for the same signature', () => {
    for (const sig of SIGS) {
      expect(deriveViewingKey(sig)).toBe(deriveViewingKey(sig));
    }
  });

  it('stays canonical: strictly within (0, MAX_VIEWING_KEY) and never zero', () => {
    // Sweep a broad set of signatures (not just the 3 fixtures) so the
    // two-limb fold genuinely exercises the full canonical range, including
    // the upper half that the old single-keccak seed could never reach.
    const sweep = Array.from({ length: 256 }, (_, i) => `0x${i.toString(16).padStart(2, '0').repeat(65)}`);
    for (const sig of [...SIGS, ...sweep]) {
      const vk = deriveViewingKey(sig);
      expect(vk).toBeGreaterThan(0n);
      expect(vk).toBeLessThan(MAX_VIEWING_KEY);
    }
  });

  it('exposes MAX_VIEWING_KEY as half the curve order', () => {
    expect(MAX_VIEWING_KEY).toBe(ec.starkCurve.CURVE.n / 2n);
  });

  it('yields different viewing keys for different signatures', () => {
    const keys = SIGS.map(deriveViewingKey);
    expect(new Set(keys.map(String)).size).toBe(keys.length);
  });
});
