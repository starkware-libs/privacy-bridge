// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Encodes an opaque CCTP byte blob (the Iris `message` / `attestation`, each a
// 0x-hex string) into Starknet calldata for MessageTransmitterV2.receive_message.
//
// The DEPLOYED Starknet MessageTransmitterV2 (mainnet 0x02EBB57…AEf183 and testnet
// 0x04db792…12Fe8 — identical Sierra class) declares:
//
//   receive_message(message: core::byte_array::ByteArray,
//                   attestation: core::byte_array::ByteArray) -> bool
//
// i.e. each blob is a Cairo `ByteArray`, whose calldata layout is:
//
//   [num_full_words, <full 31-byte words as felts>…, pending_word, pending_word_len]
//
// Full words pack 31 bytes BIG-ENDIAN; the final partial word goes in `pending_word`
// (right-aligned, value = the trailing bytes as a big-endian integer) with its length
// in `pending_word_len`. This is NOT the alexandria `Bytes` layout
// (`[size, data.len(), …16-byte words]`) — feeding that to the on-chain ByteArray
// param would mis-deserialise and revert the mint, stranding real USDC.
//
// We never decode these blobs — they are replayed opaquely so the transmitter can
// verify Circle's attestation — so the only requirement is a byte-exact ByteArray
// serialisation. We delegate that to starknet.js's own `CairoByteArray`, the
// authoritative serializer for this ABI type, feeding it the RAW bytes (NOT a
// UTF-8 string) so arbitrary attestation/message bytes round-trip exactly.
//
// NOTE (live-verification boundary): the cross-chain mint can only be confirmed
// against a live Starknet MessageTransmitterV2 (.claude/rules/verification.md);
// the unit tests pin the ByteArray packing, which is deterministic and chain-free.

import { CairoByteArray } from 'starknet';

// Parses a 0x-hex blob into its raw bytes. Throws on a malformed (odd-length or
// non-hex) input rather than silently truncating — these blobs come from Iris and
// a corrupted one must fail loudly, not mint against garbage calldata.
function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (body.length % 2 !== 0) {
    throw new Error('cctpBytes: hex blob has an odd number of nibbles');
  }
  if (body.length > 0 && !/^[0-9a-fA-F]+$/.test(body)) {
    throw new Error('cctpBytes: hex blob contains non-hex characters');
  }
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Serialises a CCTP blob into receive_message ByteArray calldata:
//   [num_full_words, word0, word1, …, pending_word, pending_word_len]
// (all hex felt strings, via starknet.js CairoByteArray.toApiRequest()).
// An empty blob → ['0x0', '0x0', '0x0'] (no full words, empty pending word).
// Exported for the orchestrator and pinned by cctpBytes.test.ts.
export function encodeCctpBytes(hex: string): string[] {
  const bytes = hexToBytes(hex);
  return new CairoByteArray(bytes).toApiRequest().map(String);
}
