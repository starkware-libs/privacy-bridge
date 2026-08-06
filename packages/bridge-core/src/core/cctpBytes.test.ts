// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Pins the CCTP `ByteArray` calldata encoder (Starknet receive_message). Pure math,
// no chain — see cctpBytes.ts for the core::byte_array::ByteArray layout this targets
// (matched to the on-chain receive_message ABI) and the live-verification boundary
// for the actual mint.
//
// The deployed MessageTransmitterV2 takes `message`/`attestation` as Cairo ByteArray:
//   [num_full_words, <full 31-byte words>…, pending_word, pending_word_len]
// NOT the alexandria Bytes `[size, data.len(), …16-byte words]` layout. Feeding the
// latter would mis-deserialise and revert the mint, stranding real USDC. These tests
// pin the ByteArray layout, cross-checked against starknet.js's OWN CairoByteArray
// serializer so the expected vectors are authoritative, not self-referential.

import { describe, expect, it } from 'vitest';
import { CairoByteArray } from 'starknet';
import { encodeCctpBytes } from './cctpBytes';

const BYTES_PER_WORD = 31;

function hexBytes(hex: string): Uint8Array {
  const body = hex.replace(/^0x/i, '');
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// AUTHORITATIVE reference: starknet.js's own ByteArray serializer for the same raw
// bytes. The encoder MUST agree with this (that's the whole point — let the SDK own
// the layout). Returns hex felt strings, the receive_message calldata form.
function referenceByteArray(bytes: Uint8Array): string[] {
  return new CairoByteArray(bytes).toApiRequest().map(String);
}

// Independent reference DECODER: reverse the ByteArray calldata
// [num_full_words, …31B words…, pending_word, pending_word_len] back to the original
// bytes, so a round-trip proves the packing is loss-free without trusting the encoder.
function decode(calldata: string[]): Uint8Array {
  const numWords = Number(BigInt(calldata[0]));
  const pendingLen = Number(BigInt(calldata[calldata.length - 1]));
  const pendingWord = BigInt(calldata[calldata.length - 2]);
  const words = calldata.slice(1, 1 + numWords);
  const out: number[] = [];
  for (const w of words) {
    let value = BigInt(w);
    const chunk = new Array<number>(BYTES_PER_WORD);
    for (let i = BYTES_PER_WORD - 1; i >= 0; i--) {
      chunk[i] = Number(value & 0xffn);
      value >>= 8n;
    }
    out.push(...chunk);
  }
  // pending_word is right-aligned: its `pendingLen` low bytes are the trailing data.
  let pv = pendingWord;
  const pend = new Array<number>(pendingLen);
  for (let i = pendingLen - 1; i >= 0; i--) {
    pend[i] = Number(pv & 0xffn);
    pv >>= 8n;
  }
  out.push(...pend);
  return Uint8Array.from(out);
}

describe('encodeCctpBytes — ByteArray structure (matches the on-chain ABI)', () => {
  it('encodes the empty blob as num_full_words 0, empty pending word', () => {
    // [num_full_words=0, pending_word=0, pending_word_len=0].
    expect(encodeCctpBytes('0x')).toEqual(['0x0', '0x0', '0x0']);
    expect(encodeCctpBytes('')).toEqual(['0x0', '0x0', '0x0']);
  });

  it('encodes a single zero byte as a 1-byte pending word', () => {
    // No full word; pending_word=0x00, pending_word_len=1.
    expect(encodeCctpBytes('0x00')).toEqual(['0x0', '0x0', '0x1']);
  });

  it('packs an exact multiple of 31 bytes (62B all 0xff → two full words, empty pending)', () => {
    const word = `0x${'ff'.repeat(31)}`;
    expect(encodeCctpBytes('0x' + 'ff'.repeat(62))).toEqual(['0x2', word, word, '0x0', '0x0']);
  });

  it('packs a non-multiple blob (40B → 1 full 31B word + 9-byte pending word)', () => {
    // 0x00..0x27. First 31 bytes → one full word (big-endian); trailing 9 bytes
    // (0x1f..0x27) → pending_word, pending_word_len=9.
    const out = encodeCctpBytes(
      '0x' + Array.from({ length: 40 }, (_, i) => i.toString(16).padStart(2, '0')).join(''),
    );
    expect(out).toEqual([
      '0x1',
      '0x102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e',
      '0x1f2021222324252627',
      '0x9',
    ]);
  });
});

describe('encodeCctpBytes — agrees with starknet.js CairoByteArray (authoritative)', () => {
  it.each([
    '0x',
    '0x00',
    '0x0102',
    '0x' + 'ab'.repeat(30), // 30B → all in pending word
    '0x' + 'ab'.repeat(31), // exactly one full word
    '0x' + 'cd'.repeat(62), // two full words
    '0x' + 'ef'.repeat(65), // 2 full words + 3-byte pending (a CCTP attestation size)
    // A realistic ~CCTP-message-sized blob (280 bytes, varied bytes): 9 full words + 1 pending.
    '0x' + Array.from({ length: 280 }, (_, i) => (i % 256).toString(16).padStart(2, '0')).join(''),
  ])('matches CairoByteArray.toApiRequest for %s', (hex) => {
    expect(encodeCctpBytes(hex)).toEqual(referenceByteArray(hexBytes(hex)));
  });
});

describe('encodeCctpBytes — round-trip (loss-free packing)', () => {
  it.each([
    '0x',
    '0x00',
    '0x0102',
    '0x' + 'ab'.repeat(31),
    '0x' + 'cd'.repeat(32),
    '0x' + 'ef'.repeat(65),
    '0x' + Array.from({ length: 196 }, (_, i) => (i % 256).toString(16).padStart(2, '0')).join(''),
  ])('reconstructs the exact input bytes for %s', (hex) => {
    expect(decode(encodeCctpBytes(hex))).toEqual(hexBytes(hex));
  });

  it('is case-insensitive and prefix-agnostic', () => {
    expect(encodeCctpBytes('0xABcd')).toEqual(encodeCctpBytes('abCD'));
  });
});

describe('encodeCctpBytes — adversarial input', () => {
  it('throws on an odd number of nibbles', () => {
    expect(() => encodeCctpBytes('0xabc')).toThrow(/odd number of nibbles/i);
  });

  it('throws on non-hex characters', () => {
    expect(() => encodeCctpBytes('0xzz')).toThrow(/non-hex/i);
  });
});
