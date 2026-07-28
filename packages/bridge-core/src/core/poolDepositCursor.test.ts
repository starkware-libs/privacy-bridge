// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearPendingPoolDeposit,
  readPendingPoolDeposit,
  recordPendingPoolDeposit,
} from './poolDepositCursor';
import { hasAnyInflightTransfer } from './depositIn';

// FUND-SAFETY (Row 1 double-burn guard, docs/bridge-sdk-refactor.md §1): the pool-deposit
// resume cursor persists that funds landed on a derived SN account pending a pool deposit,
// so a cross-run resume never re-funds (re-burns). Round-trip + corrupt-drop + the
// network-switch guard interaction are proven here; the orchestrator wiring is proven in
// moveIntoPool.test.ts.

const KEY = 'pmp.inflightPoolDeposit';
const ACCOUNT = '0xABCdef0000000000000000000000000000000001';
const NET = 980_000n;

describe('poolDepositCursor', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('records then reads back the net, keyed per (lower-cased) account', () => {
    recordPendingPoolDeposit(ACCOUNT, NET);
    expect(readPendingPoolDeposit(ACCOUNT)).toEqual({ netWei: NET });
    // Case-insensitive on the account address.
    expect(readPendingPoolDeposit(ACCOUNT.toUpperCase())).toEqual({ netWei: NET });
  });

  it('returns null when there is no cursor for the account', () => {
    recordPendingPoolDeposit('0x00000000000000000000000000000000000000ff', NET);
    expect(readPendingPoolDeposit(ACCOUNT)).toBeNull();
  });

  it('clear removes only that account, leaving others intact', () => {
    const other = '0x00000000000000000000000000000000000000ff';
    recordPendingPoolDeposit(ACCOUNT, NET);
    recordPendingPoolDeposit(other, 1n);
    clearPendingPoolDeposit(ACCOUNT);
    expect(readPendingPoolDeposit(ACCOUNT)).toBeNull();
    expect(readPendingPoolDeposit(other)).toEqual({ netWei: 1n });
  });

  it('drops (and clears) a corrupt record — a garbage net is not resumable', () => {
    localStorage.setItem(KEY, JSON.stringify({ [ACCOUNT.toLowerCase()]: { netWei: 'NaN' } }));
    expect(readPendingPoolDeposit(ACCOUNT)).toBeNull();
    // The corrupt entry was purged.
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify({}));
  });

  it('drops a non-positive net (0 is not a resumable deposit)', () => {
    localStorage.setItem(KEY, JSON.stringify({ [ACCOUNT.toLowerCase()]: { netWei: '0' } }));
    expect(readPendingPoolDeposit(ACCOUNT)).toBeNull();
  });

  it('tolerates unparseable JSON (returns null, no throw)', () => {
    localStorage.setItem(KEY, '{not json');
    expect(readPendingPoolDeposit(ACCOUNT)).toBeNull();
  });

  it('a pending cursor BLOCKS a network switch (hasAnyInflightTransfer picks up pmp.inflight*)', () => {
    expect(hasAnyInflightTransfer()).toBe(false);
    recordPendingPoolDeposit(ACCOUNT, NET);
    // Wiping this cursor mid-flight would re-open the double-burn, so the generic
    // pmp.inflight* switch guard must block while a pool deposit is pending.
    expect(hasAnyInflightTransfer()).toBe(true);
    clearPendingPoolDeposit(ACCOUNT);
    expect(hasAnyInflightTransfer()).toBe(false);
  });
});
