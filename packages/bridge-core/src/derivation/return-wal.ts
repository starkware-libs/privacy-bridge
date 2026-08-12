// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { RETURN_WAL_LABEL } from './messages.js';

export interface ReturnWalKeys {
  id: string; // 64 lowercase hex, unprefixed — the opaque backend key; LEAVES the browser
  encKey: Uint8Array; // 32 bytes, AES-GCM; NEVER leaves the browser, never logged/persisted
}

// Canonicalize a Starknet address to lowercase 64-nibble hex so `0x01ab…` and
// `0x1ab…` — the same address rendered two ways — cannot yield two keyspaces.
function canonicalSnAddress(starknetAddress: string): string {
  if (typeof starknetAddress !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(starknetAddress)) {
    throw new Error('starknetAddress must be 0x-prefixed hex of at most 64 nibbles');
  }
  return '0x' + starknetAddress.slice(2).toLowerCase().padStart(64, '0');
}

// Derive the return-WAL keys from the EVM identity signature — no second wallet
// prompt. Two domain-separated keccak limbs (`:id:` / `:enc:`) over the same
// preimage base: neither limb is derivable from the other, and neither is
// computable from public data (the signature is the sole secret input; the
// Starknet address only scopes the keyspace per identity).
//
// The label IS the WAL keyspace — changing it orphans every open entry.
export function deriveReturnWalKeys(evmSignature: string, starknetAddress: string): ReturnWalKeys {
  if (typeof evmSignature !== 'string' || evmSignature.length === 0) {
    throw new Error('evmSignature must be a non-empty string');
  }
  const base = `${evmSignature}:${RETURN_WAL_LABEL}`;
  const scope = canonicalSnAddress(starknetAddress);
  return {
    id: bytesToHex(keccak_256(utf8ToBytes(`${base}:id:${scope}`))),
    encKey: keccak_256(utf8ToBytes(`${base}:enc:${scope}`)),
  };
}
