// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { secp256k1 } from '@noble/curves/secp256k1';
import { POLYGON_EOA_LABEL, assertValidChannel } from './messages.js';

const N = secp256k1.CURVE.n; // secp256k1 group order

// EIP-55: checksum the lowercase 40-hex address using keccak256 of its ASCII.
function toChecksumAddress(lowerHex40: string): string {
  const hashHex = bytesToHex(keccak_256(utf8ToBytes(lowerHex40)));
  let out = '0x';
  for (let i = 0; i < lowerHex40.length; i++) {
    const c = lowerHex40[i];
    // Uppercase a hex letter when the corresponding hash nibble is >= 8.
    out += parseInt(hashHex[i], 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

export interface PolygonEoa {
  privateKey: string; // 0x-prefixed 32-byte hex, secp256k1 scalar in [1, n)
  address: string; // EIP-55 checksummed 0x EVM address
}

// Deterministically derive a fresh Polygon (EVM) trading EOA from an EVM wallet
// signature + a per-account index. The signature is the only secret input; the
// label scopes this seed to the Polygon-EOA domain (distinct from the Starknet
// account-key and viewing-key domains), and `accountIndex` makes every account
// yield a new, mutually-unlinkable address. Same (signature, index) => identical
// EOA, so the address recovers from the signature + the non-secret saved index.
//
// In-memory only — never log or persist the returned private key.
export function derivePolygonEoa(
  evmSignature: string,
  accountIndex: number,
  channel?: string,
): PolygonEoa {
  // Guard: reject unsafe JS numbers before they reach the seed string. IEEE-754
  // rounding means any number > 2^53 may have already lost precision, so two
  // distinct intended indices could interpolate into the SAME seed and derive the
  // same EOA (silent collision) — mirrors deriveAccountNonce's guard (#42).
  if (!Number.isSafeInteger(accountIndex))
    throw new Error('accountIndex exceeds safe integer range; pass a safe integer');
  if (accountIndex < 0) throw new Error('accountIndex must be non-negative');

  // seed = keccak256(`${signature}:${label}[:${channel}]:${index}`), reduced into [1, n).
  // `channel` (undefined = the legacy/default account channel) scopes the seed to a
  // separate keyspace, so `(channel, index)` pairs from different channels never
  // collide even at the same small index. undefined reproduces the EXACT legacy
  // preimage, so existing accounts derive byte-identically (derivation-channel.test.ts).
  if (channel !== undefined) assertValidChannel(channel);
  const preimage =
    channel === undefined
      ? `${evmSignature}:${POLYGON_EOA_LABEL}:${accountIndex}`
      : `${evmSignature}:${POLYGON_EOA_LABEL}:${channel}:${accountIndex}`;
  const seed = keccak_256(utf8ToBytes(preimage));
  const reduced = BigInt('0x' + bytesToHex(seed)) % N;
  // 0 is invalid as a secp256k1 scalar; bump to 1 for the vanishingly unlikely
  // case so the key always lands in [1, n).
  const scalar = reduced === 0n ? 1n : reduced;
  const privateKey = '0x' + scalar.toString(16).padStart(64, '0');

  // Uncompressed public key is 65 bytes: 0x04 prefix + X[32] + Y[32].
  // The address is the last 20 bytes of keccak256(X || Y).
  const pub = secp256k1.getPublicKey(scalar, false);
  const digest = keccak_256(pub.subarray(1));
  const address = toChecksumAddress(bytesToHex(digest.subarray(-20)));

  return { privateKey, address };
}
