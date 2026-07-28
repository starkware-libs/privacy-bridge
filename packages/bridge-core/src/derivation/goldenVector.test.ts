// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { describe, expect, it } from 'vitest';
import { deriveViewingKey } from './viewing-key.js';
import { derivePolygonEoa } from './polygon-key.js';
import { deriveAccountNonce, deriveClaimSecret, computeClaimH } from './claim-commitment.js';

// Derivation golden-vector (bridge-sdk-refactor.md Slice R proof gate): pins the
// FULL derivation pipeline (viewing key -> account nonce -> claim_secret -> H,
// and the derived Polygon EOA) end-to-end for fixed inputs, captured GREEN
// against the code as it existed immediately before the Slice R vocabulary
// rename (see git history for the prior identifier names). The MATH — the
// poseidon tag strings and the keccak EOA-label string that feed it — must not
// move under a pure rename, so re-running this same computation through the
// renamed API must reproduce these exact literals byte-for-byte.
//
// Fixed fixtures only — no real keys.
const SIGNATURE =
  '0x' +
  'deadbeefcafef00d1234567890abcdef' +
  'fedcba0987654321deadbeefcafef00d' +
  '00112233445566778899aabbccddeeff' +
  'ffeeddccbbaa99887766554433221100' +
  '1b';
const ACCOUNT_INDEX = 3;
const AMOUNT = 1_000_000n; // 1 USDC @ 6dp
const SN_DOMAIN = 25n;

// Hard-coded outputs captured GREEN against the pre-rename code — see the
// derivation notes above. Do not hand-derive these; they are the oracle.
const EXPECTED_VIEWING_KEY = 293795725303939143558204794657378291263721883715457771908567994777523468793n;
const EXPECTED_ACCOUNT_NONCE = 1380718854364062545943568486906930365887958515835158177421754483215565265750n;
const EXPECTED_CLAIM_SECRET = 2713193343511557676620881039868051523056592783511288842404822415949057802576n;
const EXPECTED_H = 462245782476701494736746814423597339500358180684653597968646775773768927370n;
const EXPECTED_EOA_PRIVATE_KEY = '0xe8e1c985a161628a8695b6f6d393ff5580921cb3e654b7e6f9a9d50cc48bc023';
const EXPECTED_EOA_ADDRESS = '0x44783c0865C31aCc66C9C2Fb03238190A4541E73';

describe('derivation golden vector (pre/post Slice R rename must be byte-identical)', () => {
  it('reproduces the pinned viewing key for the fixed signature', () => {
    expect(deriveViewingKey(SIGNATURE)).toBe(EXPECTED_VIEWING_KEY);
  });

  it('reproduces the pinned account nonce, claim_secret, and H', () => {
    const viewingKey = deriveViewingKey(SIGNATURE);
    const accountNonce = deriveAccountNonce(viewingKey, ACCOUNT_INDEX);
    expect(accountNonce).toBe(EXPECTED_ACCOUNT_NONCE);

    const claimSecret = deriveClaimSecret(viewingKey, accountNonce);
    expect(claimSecret).toBe(EXPECTED_CLAIM_SECRET);

    const H = computeClaimH({ claimSecret, amount: AMOUNT, snDomain: SN_DOMAIN });
    expect(H).toBe(EXPECTED_H);
  });

  it('reproduces the pinned derived Polygon EOA (private key + address)', () => {
    const eoa = derivePolygonEoa(SIGNATURE, ACCOUNT_INDEX);
    expect(eoa.privateKey).toBe(EXPECTED_EOA_PRIVATE_KEY);
    expect(eoa.address).toBe(EXPECTED_EOA_ADDRESS);
  });
});
