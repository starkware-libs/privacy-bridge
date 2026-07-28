import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WALLET_SESSION_KEY,
  WALLET_SESSION_TTL_MS,
  addressesEqual,
  clearWalletSession,
  readWalletSession,
  writeWalletSession,
} from './session-store';

// `readWalletSession` is a PARSING BOUNDARY over attacker-writable storage: anything that
// gets past it decides whether the app re-enters a wallet session without a click. These
// cover the validation directly — the WalletProvider suite only exercises it end-to-end.

const ADDR = '0x1111111111111111111111111111111111111111';

function write(raw: unknown) {
  localStorage.setItem(WALLET_SESSION_KEY, typeof raw === 'string' ? raw : JSON.stringify(raw));
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('readWalletSession — shape validation', () => {
  it('reads back a well-formed record', () => {
    writeWalletSession({ address: ADDR, rdns: 'io.metamask' });
    expect(readWalletSession()).toMatchObject({ address: ADDR, rdns: 'io.metamask' });
  });

  it('accepts a null rdns (the bare-global entry)', () => {
    writeWalletSession({ address: ADDR, rdns: null });
    expect(readWalletSession()).toMatchObject({ address: ADDR, rdns: null });
  });

  it.each([
    ['absent', undefined],
    ['unparseable', '{not json'],
    ['a JSON array', []],
    ['a JSON string', '"nope"'],
    ['null', null],
    ['a missing address', { rdns: null, at: Date.now() }],
    ['a non-string address', { address: 123, rdns: null, at: Date.now() }],
    ['a too-short address', { address: '0x1111', rdns: null, at: Date.now() }],
    ['a non-hex address', { address: `0x${'z'.repeat(40)}`, rdns: null, at: Date.now() }],
    ['an address without 0x', { address: '1'.repeat(40), rdns: null, at: Date.now() }],
    ['a non-string rdns', { address: ADDR, rdns: 7, at: Date.now() }],
    ['a missing at', { address: ADDR, rdns: null }],
    ['a non-numeric at', { address: ADDR, rdns: null, at: 'soon' }],
    ['a NaN at', { address: ADDR, rdns: null, at: Number.NaN }],
    ['an Infinity at', { address: ADDR, rdns: null, at: Number.POSITIVE_INFINITY }],
  ])('rejects %s', (_label, raw) => {
    if (raw !== undefined) write(raw);
    expect(readWalletSession()).toBeNull();
  });

  it('rejects an expired record AND drops it', () => {
    write({ address: ADDR, rdns: null, at: Date.now() - WALLET_SESSION_TTL_MS - 1 });
    expect(readWalletSession()).toBeNull();
    expect(localStorage.getItem(WALLET_SESSION_KEY)).toBeNull();
  });

  it('accepts a record right at the TTL edge', () => {
    write({ address: ADDR, rdns: null, at: Date.now() - (WALLET_SESSION_TTL_MS - 5_000) });
    expect(readWalletSession()).not.toBeNull();
  });

  it('ignores a future-stamped record WITHOUT deleting it', () => {
    // `Date.now()` is not monotonic. Deleting here would let a backward clock/NTP step
    // permanently destroy a valid session; refusing the read is enough.
    write({ address: ADDR, rdns: null, at: Date.now() + 60_000 });
    expect(readWalletSession()).toBeNull();
    expect(localStorage.getItem(WALLET_SESSION_KEY)).not.toBeNull();
  });
});

describe('writeWalletSession', () => {
  it('refuses to record a malformed address', () => {
    writeWalletSession({ address: 'not-an-address', rdns: null });
    expect(localStorage.getItem(WALLET_SESSION_KEY)).toBeNull();
  });

  it('re-stamps `at` on every write', () => {
    write({ address: ADDR, rdns: null, at: Date.now() - WALLET_SESSION_TTL_MS / 2 });
    const before = readWalletSession()!.at;
    writeWalletSession({ address: ADDR, rdns: null });
    expect(readWalletSession()!.at).toBeGreaterThan(before);
  });

  it('clearWalletSession removes the record', () => {
    writeWalletSession({ address: ADDR, rdns: null });
    clearWalletSession();
    expect(localStorage.getItem(WALLET_SESSION_KEY)).toBeNull();
  });
});

describe('addressesEqual', () => {
  it('is case-insensitive', () => {
    expect(addressesEqual(ADDR.toUpperCase().replace('0X', '0x'), ADDR.toLowerCase())).toBe(true);
  });

  it('is false for a different address', () => {
    expect(addressesEqual(ADDR, `0x${'2'.repeat(40)}`)).toBe(false);
  });

  it('is false for null/undefined on either side', () => {
    expect(addressesEqual(null, ADDR)).toBe(false);
    expect(addressesEqual(ADDR, undefined)).toBe(false);
    expect(addressesEqual(null, null)).toBe(false);
  });

  it('never matches on a PREFIX', () => {
    expect(addressesEqual(ADDR, ADDR.slice(0, 20))).toBe(false);
  });

  it('cannot throw on malformed input', () => {
    // The persisted side is attacker-writable, and viem's checksum helpers throw on garbage.
    for (const bad of ['', '0x', 'null', '0xzzzz', `0x${'1'.repeat(41)}`, '0X' + '1'.repeat(40)]) {
      expect(() => addressesEqual(bad, ADDR)).not.toThrow();
      expect(addressesEqual(bad, ADDR)).toBe(false);
    }
  });
});
