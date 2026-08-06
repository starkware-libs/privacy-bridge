// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { describe, expect, it } from 'vitest';
import { hash } from 'starknet';
import {
  BIND_TAG,
  ACCOUNT_NONCE_TAG,
  CLAIM_TAG,
  H_TAG,
  computeClaimH,
  deriveAccountNonce,
  deriveClaimSecret,
} from './claim-commitment.js';

// The Cairo == TS oracle. These exact numbers are pinned in
// the frozen vector and MUST also be asserted by the snforge tester
// against the same fixed inputs, guaranteeing the Cairo Anonymizer and this
// package compute byte-identical claim_secret / note_binding / H values.

const poseidon = (xs: bigint[]) => BigInt(hash.computePoseidonHashOnElements(xs));

// Fixed test-vector inputs (pure fixtures — no real keys).
const VIEWING_KEY = 123456789n;
const ACCOUNT_NONCE = 42n;
const AMOUNT = 1_000_000n; // 1 USDC @ 6dp
const SN_DOMAIN = 25n;

// Expected outputs. Same fixed numbers the Cairo
// tester asserts → TS == Cairo. note_binding is bound to claim_secret (not a
// separate channel_key) so the on-chain claim — which carries only claim_secret
// — recomputes the SAME H bridgeOut records.
const EXPECTED_CLAIM_SECRET =
  2069452701457285857209401669498930313539255917194012082327558716626330726443n;
const EXPECTED_NOTE_BINDING =
  108693184174739947593777314068519123901268159825254012913521259920693296462n;
const EXPECTED_H =
  1184640639497699140437908751684073211882192473677451888065106092277727692916n;

describe('claim-commitment H scheme (frozen)', () => {
  it('pins the domain-separation felt tags', () => {
    expect(CLAIM_TAG).toBe(20827682326329802832626734641n);
    expect(BIND_TAG).toBe(80135280620601915687458353n);
    expect(H_TAG).toBe(5214979532862936625n);
  });

  describe('the Cairo == TS test vector (the oracle)', () => {
    it('deriveClaimSecret reproduces the frozen claim_secret', () => {
      expect(deriveClaimSecret(VIEWING_KEY, ACCOUNT_NONCE)).toBe(EXPECTED_CLAIM_SECRET);
    });

    it('computeClaimH reproduces the frozen H (and embeds the frozen note_binding)', () => {
      const claimSecret = deriveClaimSecret(VIEWING_KEY, ACCOUNT_NONCE);
      const H = computeClaimH({ claimSecret, amount: AMOUNT, snDomain: SN_DOMAIN });
      expect(H).toBe(EXPECTED_H);

      // note_binding is internal to computeClaimH; assert it equals the frozen
      // value via the raw recipe (bound to claim_secret) so any drift in the
      // BIND_TAG span is caught, and confirm computeClaimH would not match H if
      // note_binding differed.
      const noteBinding = poseidon([BIND_TAG, claimSecret]);
      expect(noteBinding).toBe(EXPECTED_NOTE_BINDING);
      expect(poseidon([H_TAG, claimSecret, AMOUNT, SN_DOMAIN, noteBinding])).toBe(EXPECTED_H);
    });

    it('matches the raw frozen Poseidon recipe end-to-end (input order is exact)', () => {
      // Independently recompute via the literal frozen spans so a
      // refactor of claim-commitment.ts that reorders/relabels a span is caught.
      const claimSecret = poseidon([CLAIM_TAG, VIEWING_KEY, ACCOUNT_NONCE]);
      const noteBinding = poseidon([BIND_TAG, claimSecret]);
      const H = poseidon([H_TAG, claimSecret, AMOUNT, SN_DOMAIN, noteBinding]);

      expect(claimSecret).toBe(deriveClaimSecret(VIEWING_KEY, ACCOUNT_NONCE));
      expect(H).toBe(computeClaimH({ claimSecret, amount: AMOUNT, snDomain: SN_DOMAIN }));
      expect(claimSecret).toBe(EXPECTED_CLAIM_SECRET);
      expect(noteBinding).toBe(EXPECTED_NOTE_BINDING);
      expect(H).toBe(EXPECTED_H);
    });
  });

  describe('determinism', () => {
    it('deriveClaimSecret is a pure function of (viewing_key, account_nonce)', () => {
      expect(deriveClaimSecret(VIEWING_KEY, ACCOUNT_NONCE)).toBe(
        deriveClaimSecret(VIEWING_KEY, ACCOUNT_NONCE),
      );
      // Sweep more inputs to be sure it never carries hidden state.
      for (let i = 1n; i <= 16n; i++) {
        const vk = VIEWING_KEY + i;
        const nonce = ACCOUNT_NONCE + i;
        expect(deriveClaimSecret(vk, nonce)).toBe(deriveClaimSecret(vk, nonce));
      }
    });

    it('computeClaimH is a pure function of its args', () => {
      const args = {
        claimSecret: EXPECTED_CLAIM_SECRET,
        amount: AMOUNT,
        snDomain: SN_DOMAIN,
      };
      expect(computeClaimH(args)).toBe(computeClaimH(args));
    });
  });

  describe('per-account-nonce distinctness (fixes P1 residual-commitment linkability)', () => {
    it('a different account_nonce yields a different claim_secret (same VK)', () => {
      expect(deriveClaimSecret(VIEWING_KEY, ACCOUNT_NONCE)).not.toBe(
        deriveClaimSecret(VIEWING_KEY, ACCOUNT_NONCE + 1n),
      );
    });

    it('every account (fresh nonce) produces a distinct claim_secret and a distinct H', () => {
      const nonces = Array.from({ length: 64 }, (_, i) => BigInt(i));
      const claimSecrets = nonces.map((n) => deriveClaimSecret(VIEWING_KEY, n));
      const hs = claimSecrets.map((claimSecret) =>
        computeClaimH({ claimSecret, amount: AMOUNT, snDomain: SN_DOMAIN }),
      );

      // No two accounts collide — H is unlinkable across accounts.
      expect(new Set(claimSecrets.map(String)).size).toBe(nonces.length);
      expect(new Set(hs.map(String)).size).toBe(nonces.length);
    });

    it('different viewing keys (same nonce) yield different claim_secrets', () => {
      expect(deriveClaimSecret(VIEWING_KEY, ACCOUNT_NONCE)).not.toBe(
        deriveClaimSecret(VIEWING_KEY + 1n, ACCOUNT_NONCE),
      );
    });
  });

  describe('deriveAccountNonce (recovery recipe)', () => {
    it('is poseidon([ACCOUNT_NONCE_TAG, viewing_key, trade_counter])', () => {
      expect(deriveAccountNonce(VIEWING_KEY, 0)).toBe(poseidon([ACCOUNT_NONCE_TAG, VIEWING_KEY, 0n]));
      expect(deriveAccountNonce(VIEWING_KEY, 7)).toBe(poseidon([ACCOUNT_NONCE_TAG, VIEWING_KEY, 7n]));
    });

    it('is deterministic in (viewing_key, trade_counter) so the account recovers from the signature + saved index', () => {
      expect(deriveAccountNonce(VIEWING_KEY, 5)).toBe(deriveAccountNonce(VIEWING_KEY, 5n));
    });

    it('yields a distinct nonce per index (every account unlinkable) and per viewing key', () => {
      const nonces = Array.from({ length: 64 }, (_, i) => deriveAccountNonce(VIEWING_KEY, i));
      expect(new Set(nonces.map(String)).size).toBe(nonces.length);
      expect(deriveAccountNonce(VIEWING_KEY, 3)).not.toBe(deriveAccountNonce(VIEWING_KEY + 1n, 3));
    });

    it('rejects a negative trade counter', () => {
      expect(() => deriveAccountNonce(VIEWING_KEY, -1)).toThrow();
    });

    it('feeds a distinct claim_secret per account index', () => {
      const cs0 = deriveClaimSecret(VIEWING_KEY, deriveAccountNonce(VIEWING_KEY, 0));
      const cs1 = deriveClaimSecret(VIEWING_KEY, deriveAccountNonce(VIEWING_KEY, 1));
      expect(cs0).not.toBe(cs1);
    });
  });

  describe('claim_secret is a one-way function of (viewing_key, account_nonce)', () => {
    // We cannot prove non-invertibility of Poseidon in a unit test, but we can
    // pin the observable consequences the threat model relies on:
    //  (1) it is exactly poseidon([CLAIM_TAG, VK, nonce]) — a hash, not the VK;
    //  (2) the output never equals/leaks either preimage limb;
    //  (3) the VK is mixed in (changing only the VK changes the output).
    it('equals the tagged Poseidon hash of (VK, nonce), not the raw preimage', () => {
      const claimSecret = deriveClaimSecret(VIEWING_KEY, ACCOUNT_NONCE);
      expect(claimSecret).toBe(poseidon([CLAIM_TAG, VIEWING_KEY, ACCOUNT_NONCE]));
    });

    it('never echoes the viewing key or the account_nonce in its output', () => {
      for (let i = 0n; i < 32n; i++) {
        const vk = VIEWING_KEY + i * 7n;
        const nonce = ACCOUNT_NONCE + i * 3n;
        const claimSecret = deriveClaimSecret(vk, nonce);
        expect(claimSecret).not.toBe(vk);
        expect(claimSecret).not.toBe(nonce);
        // The hash mangles the inputs — it is not a trivial sum/xor either.
        expect(claimSecret).not.toBe(vk + nonce);
      }
    });

    it('depends on the viewing key (the secret is genuinely mixed in)', () => {
      // Flipping a single low bit of the VK changes the whole output.
      expect(deriveClaimSecret(VIEWING_KEY, ACCOUNT_NONCE)).not.toBe(
        deriveClaimSecret(VIEWING_KEY ^ 1n, ACCOUNT_NONCE),
      );
    });
  });
});
