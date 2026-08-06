// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { describe, expect, it } from 'vitest';
import { ec, hash } from 'starknet';
import { secp256k1 } from '@noble/curves/secp256k1';
import { deriveStarknetAccount, deriveStarknetPrivateKey } from './starknet-key.js';
import { MAX_VIEWING_KEY, deriveViewingKey } from './viewing-key.js';
import { derivePolygonEoa } from './polygon-key.js';
import {
  computeClaimH,
  deriveAccountNonce,
  deriveClaimSecret,
} from './claim-commitment.js';

// OFFLINE property/fuzz tests for the in-browser key-derivation surface.
//
// We feed the REAL exported functions MANY (N≥500) random EVM signatures and
// private keys and assert the structural invariants every derivation must hold
// — determinism, valid-range scalars, valid felts, domain separation, per-account
// distinctness, one-wayness. No network, no chain, no funds: pure functions over
// fixtures. A fixed-seed PRNG keeps every run identical so a failure is
// reproducible; the seed is logged for that reason.

// ── Reproducible randomness ────────────────────────────────────────────────
// xorshift128: a tiny, dependency-free, fully deterministic PRNG. Math.random /
// Date are NOT used (forbidden in some contexts and would make a failure
// un-reproducible). Reseed from FUZZ_SEED to replay any failing run verbatim.
const FUZZ_SEED = 0x9e3779b9; // golden-ratio constant, fixed forever
const N = 500; // iterations per invariant sweep

function makeRng(seed: number) {
  // Four 32-bit lanes derived from the seed (must be non-zero overall).
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
    return w; // 0 .. 2^32-1
  };
}

const HEX_CHARS = '0123456789abcdef';

// A pseudo-random EVM signature. MetaMask's personal_sign returns 65 bytes
// (r[32]+s[32]+v[1]) → `0x` + 130 hex chars. We mostly emit that canonical
// shape, but deliberately VARY the length and letter-case in a minority of
// cases: derivation hashes the signature as an opaque UTF-8 string, so it must
// stay total and deterministic for any string MetaMask-ish input.
function randomSignature(rng: () => number): string {
  const roll = rng() % 10;
  let nibbles: number;
  if (roll < 7) nibbles = 130; // canonical 65-byte sig
  else if (roll === 7) nibbles = 2 + (rng() % 200); // short/odd lengths
  else nibbles = 130 + (rng() % 130); // longer-than-canonical
  let s = '0x';
  for (let i = 0; i < nibbles; i++) {
    let c = HEX_CHARS[rng() % 16];
    // Vary case: ~half the alpha nibbles upper-cased.
    if (rng() % 2 === 0) c = c.toUpperCase();
    s += c;
  }
  return s;
}

// A pseudo-random 32-byte secp256k1 private key as 0x-hex (for sanity cross-
// checks of the secp256k1 math, independent of the signature path).
function randomSecp256k1Key(rng: () => number): bigint {
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 32n) | BigInt(rng());
  const reduced = v % secp256k1.CURVE.n;
  return reduced === 0n ? 1n : reduced;
}

const STARK_N = ec.starkCurve.CURVE.n;
const SECP_N = secp256k1.CURVE.n;
const FELT_PRIME = 2n ** 251n + 17n * 2n ** 192n + 1n; // stark field modulus
const LOWER_HEX_RE = /^0x[0-9a-f]+$/;
const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const CLASS_HASH = '0x5b4b537eaa2399e3aa99c4e2e0208ebd6c71bc1467938cd52c798c601e43564';

function isValidFelt(v: bigint): boolean {
  return v >= 0n && v < FELT_PRIME;
}

// Build the corpus once, deterministically, so every `it` shares the same
// signatures and a failure in any one points at the same input set.
const rng = makeRng(FUZZ_SEED);
const SIGNATURES: string[] = Array.from({ length: N }, () => randomSignature(rng));
const SECP_KEYS: bigint[] = Array.from({ length: N }, () => randomSecp256k1Key(rng));

describe(`derivation fuzz (N=${N}, seed=0x${FUZZ_SEED.toString(16)})`, () => {
  it('logs the seed so any failure is reproducible', () => {
    console.log(
      `[derivation.fuzz] PRNG seed = 0x${FUZZ_SEED.toString(16)} (N=${N}); ` +
        `re-run with this seed to reproduce.`,
    );
    expect(SIGNATURES).toHaveLength(N);
    expect(SECP_KEYS).toHaveLength(N);
  });

  // ── deriveStarknetPrivateKey / deriveStarknetAccount ─────────────────────
  describe('deriveStarknetPrivateKey + deriveStarknetAccount', () => {
    it('private key is deterministic, lowercase 0x-hex, and a valid stark scalar', () => {
      for (const sig of SIGNATURES) {
        const pk = deriveStarknetPrivateKey(sig);
        expect(pk).toBe(deriveStarknetPrivateKey(sig)); // deterministic
        expect(pk).toMatch(LOWER_HEX_RE);
        const v = BigInt(pk);
        expect(v).toBeGreaterThan(0n);
        expect(v).toBeLessThan(STARK_N); // valid (0, n) scalar
      }
    });

    it('account address is a valid felt and deterministic for the same signature', () => {
      for (const sig of SIGNATURES) {
        const pk = deriveStarknetPrivateKey(sig);
        const acct = deriveStarknetAccount(pk, CLASS_HASH);
        expect(deriveStarknetAccount(pk, CLASS_HASH)).toEqual(acct); // deterministic
        // public key tracks the curve and the address is the CREATE2-style felt.
        expect(acct.publicKey).toBe(ec.starkCurve.getStarkKey(pk));
        const expectedAddr = hash.calculateContractAddressFromHash(
          acct.publicKey,
          CLASS_HASH,
          [acct.publicKey],
          0,
        );
        expect(acct.address).toBe(expectedAddr);
        expect(isValidFelt(BigInt(acct.publicKey))).toBe(true);
        expect(isValidFelt(BigInt(acct.address))).toBe(true);
      }
    });

    it('distinct signatures overwhelmingly yield distinct private keys', () => {
      const keys = new Set(SIGNATURES.map((s) => deriveStarknetPrivateKey(s)));
      // The corpus may contain a few collisions only if randomSignature emitted
      // two identical strings; dedupe the inputs first so we compare like-for-like.
      const uniqueSigs = new Set(SIGNATURES).size;
      expect(keys.size).toBe(uniqueSigs);
    });
  });

  // ── deriveViewingKey ─────────────────────────────────────────────────────
  describe('deriveViewingKey', () => {
    it('is always canonical (0, MAX_VIEWING_KEY), non-zero, and deterministic', () => {
      for (const sig of SIGNATURES) {
        const vk = deriveViewingKey(sig);
        expect(vk).toBe(deriveViewingKey(sig)); // deterministic
        expect(vk).toBeGreaterThan(0n); // never zero
        expect(vk).toBeLessThan(MAX_VIEWING_KEY); // canonical upper bound
      }
    });

    it('exposes MAX_VIEWING_KEY as half the stark curve order', () => {
      expect(MAX_VIEWING_KEY).toBe(STARK_N / 2n);
    });
  });

  // ── derivePolygonEoa ─────────────────────────────────────────────────────
  describe('derivePolygonEoa', () => {
    it('is deterministic for the same (sig, i) and yields a valid checksummed address + secp256k1 scalar', () => {
      for (const sig of SIGNATURES) {
        const i = rng() % 32;
        const eoa = derivePolygonEoa(sig, i);
        expect(derivePolygonEoa(sig, i)).toEqual(eoa); // deterministic

        // private key: 0x + 64 hex, scalar in [1, n).
        expect(eoa.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
        const scalar = BigInt(eoa.privateKey);
        expect(scalar).toBeGreaterThan(0n);
        expect(scalar).toBeLessThan(SECP_N);

        // address: 20-byte EVM address that is a VALID EIP-55 checksum (re-checksum
        // the lowercased form and require an exact byte match).
        expect(eoa.address).toMatch(EVM_ADDR_RE);
        expect(eoa.address).toBe(toChecksum(eoa.address.toLowerCase()));

        // the address is the keccak of the uncompressed pubkey for THIS scalar.
        const pub = secp256k1.getPublicKey(scalar, false);
        const digest = bytesToHexLocal(keccakLocal(pub.subarray(1)));
        expect(eoa.address.toLowerCase()).toBe('0x' + digest.slice(-40));
      }
    });

    it('distinct indices produce distinct addresses for the same signature', () => {
      for (let k = 0; k < 64; k++) {
        const sig = SIGNATURES[rng() % SIGNATURES.length];
        const indices = [0, 1, 2, 3, 7, 11, 99, 1000];
        const addrs = indices.map((i) => derivePolygonEoa(sig, i).address);
        expect(new Set(addrs).size).toBe(indices.length); // all distinct
      }
    });

    it('rejects a negative or non-integer account index', () => {
      const sig = SIGNATURES[0];
      expect(() => derivePolygonEoa(sig, -1)).toThrow();
      expect(() => derivePolygonEoa(sig, 1.5)).toThrow();
    });
  });

  // ── deriveAccountNonce + deriveClaimSecret + computeClaimH ─────────────────────
  describe('deriveAccountNonce + deriveClaimSecret + computeClaimH', () => {
    // Anchor: the frozen test vector (the Cairo==TS
    // oracle) must still hold. Pinned here so a fuzz refactor can't drift the
    // canonical numbers.
    const FROZEN_VK = 123456789n;
    const FROZEN_NONCE = 42n;
    const FROZEN_AMOUNT = 1_000_000n;
    const FROZEN_SN_DOMAIN = 25n;
    const FROZEN_CLAIM_SECRET =
      2069452701457285857209401669498930313539255917194012082327558716626330726443n;
    const FROZEN_H =
      1184640639497699140437908751684073211882192473677451888065106092277727692916n;

    it('anchors the frozen §3 test vector (claim_secret + H)', () => {
      const claimSecret = deriveClaimSecret(FROZEN_VK, FROZEN_NONCE);
      expect(claimSecret).toBe(FROZEN_CLAIM_SECRET);
      expect(
        computeClaimH({ claimSecret, amount: FROZEN_AMOUNT, snDomain: FROZEN_SN_DOMAIN }),
      ).toBe(FROZEN_H);
    });

    it('is deterministic and produces valid felts across random viewing keys / indices', () => {
      for (const sig of SIGNATURES) {
        // Derive a real viewing key from the (fuzzed) signature, then sweep an index.
        const vk = deriveViewingKey(sig);
        const i = rng() % 256;

        const nonce = deriveAccountNonce(vk, i);
        expect(deriveAccountNonce(vk, i)).toBe(nonce); // deterministic
        expect(isValidFelt(nonce)).toBe(true);

        const claimSecret = deriveClaimSecret(vk, nonce);
        expect(deriveClaimSecret(vk, nonce)).toBe(claimSecret); // deterministic
        expect(isValidFelt(claimSecret)).toBe(true);

        const H = computeClaimH({ claimSecret, amount: FROZEN_AMOUNT, snDomain: FROZEN_SN_DOMAIN });
        expect(computeClaimH({ claimSecret, amount: FROZEN_AMOUNT, snDomain: FROZEN_SN_DOMAIN })).toBe(H);
        expect(isValidFelt(H)).toBe(true);
      }
    });

    it('computeClaimH is reproducible for fixed inputs and differs across the account index i', () => {
      for (let k = 0; k < 64; k++) {
        const sig = SIGNATURES[rng() % SIGNATURES.length];
        const vk = deriveViewingKey(sig);
        const indices = [0, 1, 2, 5, 13, 64, 257];
        const hs = indices.map((i) => {
          const claimSecret = deriveClaimSecret(vk, deriveAccountNonce(vk, i));
          return computeClaimH({ claimSecret, amount: FROZEN_AMOUNT, snDomain: FROZEN_SN_DOMAIN });
        });
        // Distinct i ⇒ distinct H (per-account unlinkability).
        expect(new Set(hs.map(String)).size).toBe(indices.length);
        // Reproducible: recomputing the i=0 leg gives the same H.
        const cs0 = deriveClaimSecret(vk, deriveAccountNonce(vk, 0));
        expect(computeClaimH({ claimSecret: cs0, amount: FROZEN_AMOUNT, snDomain: FROZEN_SN_DOMAIN })).toBe(
          hs[0],
        );
      }
    });

    it('claim_secret is a one-way child: different vk OR different nonce ⇒ different secret, and it never echoes a preimage', () => {
      for (const sig of SIGNATURES) {
        const vk = deriveViewingKey(sig);
        const nonce = deriveAccountNonce(vk, rng() % 64);
        const claimSecret = deriveClaimSecret(vk, nonce);

        // changing only the nonce changes the secret
        expect(deriveClaimSecret(vk, nonce + 1n)).not.toBe(claimSecret);
        // changing only the viewing key changes the secret
        expect(deriveClaimSecret(vk ^ 1n, nonce)).not.toBe(claimSecret);
        // the secret is not a trivial pass-through of either preimage limb
        expect(claimSecret).not.toBe(vk);
        expect(claimSecret).not.toBe(nonce);
        expect(claimSecret).not.toBe(vk + nonce);
      }
    });

    it('rejects a negative trade counter', () => {
      expect(() => deriveAccountNonce(123n, -1)).toThrow();
    });
  });
});

// ── Local crypto mirrors (independent re-derivation of the EVM address) ──────
// We deliberately re-implement keccak/checksum here so the test does NOT depend
// on polygon-key's private helpers; if polygon-key's address math drifts from
// the EIP-55 spec, the cross-check above fails.
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

function keccakLocal(bytes: Uint8Array): Uint8Array {
  return keccak_256(bytes);
}
function bytesToHexLocal(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}
function toChecksum(lowerHex: string): string {
  const body = lowerHex.replace(/^0x/, '');
  const hashHex = bytesToHex(keccak_256(utf8ToBytes(body)));
  let out = '0x';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    out += parseInt(hashHex[i], 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
}
