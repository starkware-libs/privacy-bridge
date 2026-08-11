// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// The RECOVERY cursor writer: a chain-evidence rebuild that keys by the SLOT's deposit
// wallet, stamps `proven`, and can never overwrite anything a live return already owns.
//
// Three outcomes, one write section. The occupancy checks are COMMITMENT-scoped, not
// key-scoped: organic cursors and pending records are keyed by the CONNECTED address
// while a rebuild is keyed by the deposit wallet, so a keyed-only look-up would see an
// empty slot and mint a second cursor for a burn that is already in flight.
//
// Also pins `proven` handling on the READ side: a forged non-`true` value is STRIPPED,
// never rejected — the validator's rejection path clears the cursor and hides it from
// the network-switch wipe guard, so rejecting there would delete the very cursors this
// feature exists to rebuild.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PENDING_RETURN_BURN_KEY, type PendingReturnBurn } from './pendingReturnBurn';
import { isNonRetryable } from './errors';
import {
  DEFAULT_BATCH_DEADLINE_MS,
  INFLIGHT_RETURN_KEY,
  hasAnyInflightReturn,
  listInflightReturns,
  peekInflightReturn,
  writeRecoveredInflightReturn,
  type RecoveredReturnRecord,
} from './returnIn';

// The slot's deposit wallet (the CREATE2 contract that burned) — the rebuild key.
const DEPOSIT_WALLET = '0x1111111111111111111111111111111111111111' as const;
// The connected EVM wallet — what every ORGANIC cursor/pending record is keyed by.
const CONNECTED = '0x2222222222222222222222222222222222222222' as const;
const COMMITMENT = '987654321';
const BURN_TX = '0xbeef01';
const INBOUND = '0x4';

const RECOVERED: RecoveredReturnRecord = {
  accountIndex: 3,
  burnTx: BURN_TX,
  sourceDomain: 7,
  amountWei: 2_500_000n,
  commitment: COMMITMENT,
  evmChainId: 137,
  inboundAnonymizer: INBOUND,
};

function seedCursor(key: string, overrides: Record<string, unknown> = {}): void {
  const raw = localStorage.getItem(INFLIGHT_RETURN_KEY);
  const map = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  map[key.toLowerCase()] = {
    accountIndex: 3,
    burnTx: BURN_TX,
    sourceDomain: 7,
    amount: '2500000',
    commitment: COMMITMENT,
    evmChainId: 137,
    inboundAnonymizer: INBOUND,
    ...overrides,
  };
  localStorage.setItem(INFLIGHT_RETURN_KEY, JSON.stringify(map));
}

function seedPending(key: string, overrides: Partial<PendingReturnBurn> = {}): void {
  const record: PendingReturnBurn = {
    accountIndex: 3,
    depositWallet: DEPOSIT_WALLET,
    amount: '2500000',
    commitment: COMMITMENT,
    sourceDomain: 7,
    evmChainId: 137,
    inboundAnonymizer: INBOUND,
    submittedAtMs: 1_000,
    deadlineMs: 601_000,
    ...overrides,
  };
  localStorage.setItem(PENDING_RETURN_BURN_KEY, JSON.stringify({ [key.toLowerCase()]: record }));
}

function storedCursors(): Record<string, Record<string, unknown>> {
  const raw = localStorage.getItem(INFLIGHT_RETURN_KEY);
  return raw ? (JSON.parse(raw) as Record<string, Record<string, unknown>>) : {};
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('writeRecoveredInflightReturn', () => {
  it('writes a proven cursor at the deposit-wallet key', () => {
    expect(writeRecoveredInflightReturn(DEPOSIT_WALLET, RECOVERED)).toBe('written');

    const stored = storedCursors()[DEPOSIT_WALLET.toLowerCase()];
    expect(stored).toBeDefined();
    expect(stored.proven).toBe(true);
    expect(stored.burnTx).toBe(BURN_TX);
    expect(stored.commitment).toBe(COMMITMENT);
    expect(stored.accountIndex).toBe(3);
    expect(stored.inboundAnonymizer).toBe(INBOUND);
  });

  // The store's `amount` is a decimal STRING; callers hold a bigint. Convert HERE — the
  // one boundary that knows both shapes.
  it('converts amountWei to the store\'s decimal-string amount', () => {
    writeRecoveredInflightReturn(DEPOSIT_WALLET, RECOVERED);

    expect(storedCursors()[DEPOSIT_WALLET.toLowerCase()].amount).toBe('2500000');
    expect(peekInflightReturn(DEPOSIT_WALLET)?.amountWei).toBe(2_500_000n);
  });

  it('carries an explicit channel through to the cursor', () => {
    writeRecoveredInflightReturn(DEPOSIT_WALLET, { ...RECOVERED, channel: 'fast' });

    expect(storedCursors()[DEPOSIT_WALLET.toLowerCase()].channel).toBe('fast');
  });

  it('lowercases a mixed-case deposit wallet', () => {
    const mixed = `0x${'1111111111111111111111111111111111111111'.toUpperCase()}` as const;
    expect(writeRecoveredInflightReturn(mixed, RECOVERED)).toBe('written');

    expect(Object.keys(storedCursors())).toEqual([DEPOSIT_WALLET.toLowerCase()]);
  });

  describe('never overwrites', () => {
    it("reports 'tracked' for a live cursor carrying the SAME burnTx at the same key", () => {
      seedCursor(DEPOSIT_WALLET);
      const before = localStorage.getItem(INFLIGHT_RETURN_KEY);

      expect(writeRecoveredInflightReturn(DEPOSIT_WALLET, RECOVERED)).toBe('tracked');
      expect(localStorage.getItem(INFLIGHT_RETURN_KEY)).toBe(before);
    });

    // The organic cursor lives under the CONNECTED address, not the deposit wallet — a
    // keyed-only look-up would miss it and mint a duplicate for the same burn.
    it("reports 'tracked' for the SAME burn tracked under the connected address", () => {
      seedCursor(CONNECTED);
      const before = localStorage.getItem(INFLIGHT_RETURN_KEY);

      expect(writeRecoveredInflightReturn(DEPOSIT_WALLET, RECOVERED)).toBe('tracked');
      expect(localStorage.getItem(INFLIGHT_RETURN_KEY)).toBe(before);
    });

    it("reports 'occupied' for a cursor on this commitment with a DIFFERENT burnTx", () => {
      seedCursor(CONNECTED, { burnTx: '0xfeed99' });
      const before = localStorage.getItem(INFLIGHT_RETURN_KEY);

      expect(writeRecoveredInflightReturn(DEPOSIT_WALLET, RECOVERED)).toBe('occupied');
      expect(localStorage.getItem(INFLIGHT_RETURN_KEY)).toBe(before);
    });

    it("reports 'occupied' for a FOREIGN cursor sitting at the deposit-wallet key", () => {
      seedCursor(DEPOSIT_WALLET, { burnTx: '0xfeed99', commitment: '111222333' });
      const before = localStorage.getItem(INFLIGHT_RETURN_KEY);

      expect(writeRecoveredInflightReturn(DEPOSIT_WALLET, RECOVERED)).toBe('occupied');
      expect(localStorage.getItem(INFLIGHT_RETURN_KEY)).toBe(before);
    });

    // A pending record has no burnTx by schema, so "same burn" is unprovable — it is
    // ALWAYS occupancy, and it is keyed by the connected address.
    it("reports 'occupied' for a pending record on this commitment", () => {
      seedPending(CONNECTED);
      const before = localStorage.getItem(INFLIGHT_RETURN_KEY);

      expect(writeRecoveredInflightReturn(DEPOSIT_WALLET, RECOVERED)).toBe('occupied');
      expect(localStorage.getItem(INFLIGHT_RETURN_KEY)).toBe(before);
      expect(storedCursors()[DEPOSIT_WALLET.toLowerCase()]).toBeUndefined();
    });

    it('writes past a pending record for a DIFFERENT commitment', () => {
      seedPending(CONNECTED, { commitment: '111222333' });

      expect(writeRecoveredInflightReturn(DEPOSIT_WALLET, RECOVERED)).toBe('written');
    });

    it('writes past a cursor for a DIFFERENT commitment at another key', () => {
      seedCursor(CONNECTED, { burnTx: '0xfeed99', commitment: '111222333' });

      expect(writeRecoveredInflightReturn(DEPOSIT_WALLET, RECOVERED)).toBe('written');
      expect(storedCursors()[CONNECTED.toLowerCase()].burnTx).toBe('0xfeed99');
    });
  });

  describe('refuses rather than silently dropping', () => {
    it('throws on a record the cursor validator rejects', () => {
      expect(() =>
        writeRecoveredInflightReturn(DEPOSIT_WALLET, { ...RECOVERED, burnTx: 'not-hex' }),
      ).toThrow(/recovered return cursor/i);
      expect(storedCursors()).toEqual({});
    });

    // The wallet becomes a permanent map key, so it is shape-checked like the record —
    // mirrors isValidPendingReturnBurn's own depositWallet guard.
    it('throws on a wallet that is not a 20-byte address', () => {
      expect(() => writeRecoveredInflightReturn('0xabc', RECOVERED)).toThrow(
        /recovered return cursor/i,
      );
      expect(storedCursors()).toEqual({});
    });

    it('throws on a zero amount', () => {
      expect(() =>
        writeRecoveredInflightReturn(DEPOSIT_WALLET, { ...RECOVERED, amountWei: 0n }),
      ).toThrow(/recovered return cursor/i);
      expect(storedCursors()).toEqual({});
    });

    // A write that never reached storage must not be reported as a rebuild: the marker
    // would advance over a burn that stayed invisible. Retryable — next sweep re-runs.
    it('throws RETRYABLY when the write does not persist', () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string) => {
        if (key === INFLIGHT_RETURN_KEY) throw new DOMException('QuotaExceededError');
      });

      let thrown: unknown;
      try {
        writeRecoveredInflightReturn(DEPOSIT_WALLET, RECOVERED);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/could not be saved/i);
      expect(isNonRetryable(thrown)).toBe(false);
    });
  });
});

describe('`proven` is stripped on read, never rejected', () => {
  it('drops a forged non-true value while keeping the cursor', () => {
    seedCursor(CONNECTED, { proven: 'yes' });

    const [entry] = listInflightReturns();
    expect(entry).toBeDefined();
    expect(entry.record.burnTx).toBe(BURN_TX);
    expect(entry.record.proven).toBeUndefined();
    expect('proven' in entry.record).toBe(false);
    // Never cleared — the record is still on disk, forged flag and all.
    expect(storedCursors()[CONNECTED.toLowerCase()]).toBeDefined();
  });

  it.each([false, 1, 'true', null, {}])('drops the non-true value %p', (forged) => {
    seedCursor(CONNECTED, { proven: forged });

    expect(listInflightReturns()[0]?.record.proven).toBeUndefined();
  });

  it('keeps a literal true', () => {
    seedCursor(CONNECTED, { proven: true });

    expect(listInflightReturns()[0]?.record.proven).toBe(true);
  });

  // REGRESSION PIN (green before this PR): the wipe guard must still see a cursor whose
  // `proven` is forged. A rejection clause in isValidInflightReturn would hide it here
  // and a network switch would then wipe a live burn cursor.
  it('leaves the network-switch wipe guard seeing the cursor', () => {
    seedCursor(CONNECTED, { proven: 'yes' });

    expect(hasAnyInflightReturn()).toBe(true);
  });

  it('survives malformed map entries without throwing', () => {
    localStorage.setItem(
      INFLIGHT_RETURN_KEY,
      JSON.stringify({ a: null, b: 'nope', c: [1, 2], d: 7 }),
    );

    expect(() => listInflightReturns()).not.toThrow();
    expect(listInflightReturns()).toEqual([]);
    expect(hasAnyInflightReturn()).toBe(false);
  });
});

describe('DEFAULT_BATCH_DEADLINE_MS', () => {
  it('is exported for the app-side recovery marker', () => {
    expect(DEFAULT_BATCH_DEADLINE_MS).toBe(600_000);
  });
});
