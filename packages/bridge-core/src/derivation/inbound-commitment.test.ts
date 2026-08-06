// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Parity + safety tests for the inbound-bind commitment derivation.
//
// The FROZEN cross-language vector below is asserted here (TS) AND in the Cairo
// suite (test_inbound_anonymizer.cairo :: privacy_compute_matches_frozen_ts_vector),
// proving TS `computeInboundCommitment` == Cairo `InboundAnonymizer::privacy_compute`
// (Poseidon parity, incl. the source_domain binding). End-to-end parity with the live
// pool's `compute_identity_key` is verified on testnet (live-gated).

import { describe, expect, it } from 'vitest';

import {
  IDENTITY_KEY_TAG,
  RETURN_DAPP_NAME,
  computeIdentityKey,
  computeInboundCommitment,
  deriveInboundCommitment,
  encodeCommitmentHookData,
} from './inbound-commitment';

// Fixed inputs for the frozen vector (shared with the Cairo test).
const USER_ADDR = 0x123n;
const USER_PK = 0x456n;
const INBOUND_ADDR = 0x789n;
const SOURCE_DOMAIN = 7; // CCTP source domain (Polygon) — matches the Cairo test's SOURCE_DOMAIN
const NONCE = 0x3n;

// Frozen expected felts (decimal) — pinned from this suite; mirrored in Cairo
// (test_inbound_anonymizer.cairo :: privacy_compute_matches_frozen_ts_vector).
const EXPECTED_IDENTITY_KEY =
  2963274373002919920585676405753763744919047250707156562953518365818429005436n;
const EXPECTED_COMMITMENT =
  3458963531638337582696264643503236639837327461545875365053976930150354299734n;

describe('inbound-commitment derivation', () => {
  it('matches the frozen cross-language vector (Cairo mirrors these felts)', () => {
    const identityKey = computeIdentityKey(USER_ADDR, USER_PK, INBOUND_ADDR);
    expect(identityKey).toBe(EXPECTED_IDENTITY_KEY);
    const commitment = computeInboundCommitment({
      identityKey,
      dappName: RETURN_DAPP_NAME,
      sourceDomain: SOURCE_DOMAIN,
      nonce: NONCE,
    });
    expect(commitment).toBe(EXPECTED_COMMITMENT);
  });

  it('deriveInboundCommitment == compute chain', () => {
    const chained = computeInboundCommitment({
      identityKey: computeIdentityKey(USER_ADDR, USER_PK, INBOUND_ADDR),
      sourceDomain: SOURCE_DOMAIN,
      nonce: NONCE,
    });
    expect(
      deriveInboundCommitment({
        userAddr: USER_ADDR,
        userPrivateKey: USER_PK,
        inboundAddr: INBOUND_ADDR,
        sourceDomain: SOURCE_DOMAIN,
        nonce: NONCE,
      }),
    ).toBe(chained);
  });

  it('defaults dappName to RETURN_DAPP_NAME', () => {
    const ik = computeIdentityKey(USER_ADDR, USER_PK, INBOUND_ADDR);
    expect(computeInboundCommitment({ identityKey: ik, sourceDomain: SOURCE_DOMAIN, nonce: NONCE })).toBe(
      computeInboundCommitment({ identityKey: ik, dappName: RETURN_DAPP_NAME, sourceDomain: SOURCE_DOMAIN, nonce: NONCE }),
    );
  });

  it('accepts sourceDomain as number or bigint (identical result)', () => {
    const ik = computeIdentityKey(USER_ADDR, USER_PK, INBOUND_ADDR);
    expect(computeInboundCommitment({ identityKey: ik, sourceDomain: 7, nonce: NONCE })).toBe(
      computeInboundCommitment({ identityKey: ik, sourceDomain: 7n, nonce: NONCE }),
    );
  });

  it('is deterministic and distinct per identity / nonce / source domain', () => {
    const base = { userAddr: USER_ADDR, userPrivateKey: USER_PK, inboundAddr: INBOUND_ADDR, sourceDomain: SOURCE_DOMAIN, nonce: NONCE };
    const a = deriveInboundCommitment(base);
    const again = deriveInboundCommitment(base);
    const otherKey = deriveInboundCommitment({ ...base, userPrivateKey: USER_PK + 1n });
    const otherNonce = deriveInboundCommitment({ ...base, nonce: NONCE + 1n });
    const otherDomain = deriveInboundCommitment({ ...base, sourceDomain: 6 }); // Base
    expect(again).toBe(a);
    expect(otherKey).not.toBe(a);
    expect(otherNonce).not.toBe(a);
    // A return burned from a DIFFERENT source domain cannot reach the same slot.
    expect(otherDomain).not.toBe(a);
  });

  it('tags are the frozen short-string felts', () => {
    // 'IDENTITY_KEY_TAG:V1' and 'pmp-return' as felts.
    expect(IDENTITY_KEY_TAG).toBe(BigInt('0x4944454e544954595f4b45595f5441473a5631'));
    expect(RETURN_DAPP_NAME).toBe(BigInt('0x706d702d72657475726e'));
  });

  it('rejects non-canonical / negative felts', () => {
    const P = 3618502788666131213697322783095070105623107215331596699973092056135872020481n;
    expect(() => computeIdentityKey(-1n, USER_PK, INBOUND_ADDR)).toThrow(/non-negative/);
    expect(() => computeIdentityKey(P, USER_PK, INBOUND_ADDR)).toThrow(/felt range/);
    expect(() => computeInboundCommitment({ identityKey: P, sourceDomain: SOURCE_DOMAIN, nonce: NONCE })).toThrow(/felt range/);
    expect(() => computeInboundCommitment({ identityKey: EXPECTED_IDENTITY_KEY, sourceDomain: -1, nonce: NONCE })).toThrow(/non-negative/);
  });

  it('encodes the commitment as 32-byte big-endian hookData', () => {
    const hook = encodeCommitmentHookData(EXPECTED_COMMITMENT);
    expect(hook).toMatch(/^0x[0-9a-f]{64}$/);
    expect(BigInt(hook)).toBe(EXPECTED_COMMITMENT);
  });
});
