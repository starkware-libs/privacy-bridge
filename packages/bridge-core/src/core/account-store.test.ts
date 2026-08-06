// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  consumeAccountIndex,
  hasAnyInflightBurn,
  migrateLegacyAccounts,
  nextAccountIndex,
  peekNextAccountIndex,
  readDerivedAccounts,
  seedAccountIndex,
  upsertDerivedAccount,
} from './account-store';
import type { DerivedAccountRecord } from './account-store';

const ACCOUNTS_KEY = 'pmp.bids';

// FUND-SAFETY (Bugbot HIGH — "Switch guard skips burn cursors"): the funder-
// AGNOSTIC reader for the account BURN cursor (pmp.inflightBurn). The network
// switch wipes ALL pmp.* on disconnect, so a burn-but-not-minted account in
// flight must block the switch even signed-out. hasAnyInflightBurn scans the
// whole per-address map and counts only VALID (resumable) records.
const INFLIGHT_BURN_KEY = 'pmp.inflightBurn';
// Required-field shape mirrors the app's own InflightBurn (still the legacy
// index field on disk — that cursor is app-owned until a later slice migrates
// it into core; see the fixture below).
const VALID_BURN = {
  burnTxHash: `0x${'cd'.repeat(32)}`,
  eoaAddress: '0x000000000000000000000000000000000000dEaD',
  bidIndex: 0,
  amountHuman: '1',
};

describe('hasAnyInflightBurn — funder-agnostic burn-cursor detection (Bugbot HIGH)', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('is false with no persisted cursor', () => {
    expect(hasAnyInflightBurn()).toBe(false);
  });

  it('is TRUE when SOME address has a valid burn cursor — WITHOUT passing an address', () => {
    localStorage.setItem(
      INFLIGHT_BURN_KEY,
      JSON.stringify({ '0x00000000000000000000000000000000000abcde': VALID_BURN }),
    );
    expect(hasAnyInflightBurn()).toBe(true);
  });

  it('is false when the ONLY record is corrupt (missing/invalid required fields)', () => {
    localStorage.setItem(
      INFLIGHT_BURN_KEY,
      JSON.stringify({ '0xabc': { burnTxHash: 123, bidIndex: -1 } }),
    );
    expect(hasAnyInflightBurn()).toBe(false);
  });

  it('is TRUE when at least one of several records is valid (mixed corrupt + valid)', () => {
    localStorage.setItem(
      INFLIGHT_BURN_KEY,
      JSON.stringify({ '0xbad': { eoaAddress: 'nope' }, '0x9999': VALID_BURN }),
    );
    expect(hasAnyInflightBurn()).toBe(true);
  });

  it('is false for an empty map', () => {
    localStorage.setItem(INFLIGHT_BURN_KEY, '{}');
    expect(hasAnyInflightBurn()).toBe(false);
  });
});

describe('readDerivedAccounts — migrate-on-read for the pre-Slice-R legacy index field', () => {
  const EVM = '0x00000000000000000000000000000000000abc99';

  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('accepts a record persisted with the legacy index field as `accountIndex`', () => {
    localStorage.setItem(
      ACCOUNTS_KEY,
      JSON.stringify({
        [EVM]: [
          {
            bidIndex: 5,
            amountHuman: '1',
            eoaAddress: '0x000000000000000000000000000000000000dEaD',
            lifecycle: 'minted',
            timestamp: 1,
          },
        ],
      }),
    );
    const accounts = readDerivedAccounts(EVM);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].accountIndex).toBe(5);
  });
});

// Ported from apps/web/src/identity/nextBidIndex.test.ts (Slice D — the
// peek/persist/next logic moved here from BidContext; the app keeps thin
// `peekNextBidIndex`/`persistConsumedBidIndex` aliases).
//
// Regression: `scanDerivedAccounts` upserts recovered accounts into `pmp.bids`
// WITHOUT bumping the standalone `pmp.bidIndex` counter, so the counter can lag
// the accounts actually present. Picking the bare counter would then re-issue
// an already-used index → re-derive a used deposit wallet → overwrite that
// account (and inherit its often-`claimed` lifecycle). nextAccountIndex
// reconciles the counter against the accounts so the picked index can never
// collide with an existing one.
describe('nextAccountIndex — collision-proof picker', () => {
  function accountsAt(...indices: number[]): DerivedAccountRecord[] {
    return indices.map((accountIndex) => ({ accountIndex }) as DerivedAccountRecord);
  }

  it('returns highestExisting+1 when the counter lags the accounts (the recovery bug)', () => {
    // counter=4 but a recovered account sits at index 11 → must skip past it to
    // 12, NOT re-issue 4. (RED before the fix: the picker returned the bare 4.)
    expect(nextAccountIndex(4, accountsAt(0, 1, 2, 3, 11))).toBe(12);
  });

  it('returns the counter unchanged for an empty account list (default-0 first account)', () => {
    expect(nextAccountIndex(0, [])).toBe(0);
    expect(nextAccountIndex(7, [])).toBe(7);
  });

  it('keeps a counter that is already ahead of the accounts', () => {
    // counter=20 with the highest account at 11 → the counter wins (20 is still free).
    expect(nextAccountIndex(20, accountsAt(0, 5, 11))).toBe(20);
  });
});

describe('peekNextAccountIndex / consumeAccountIndex — pmp.bidIndex persistence', () => {
  const INDEX_KEY = 'pmp.bidIndex';
  const EVM = '0x00000000000000000000000000000000000abc42';

  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('peeks 0 with no persisted counter and no accounts', () => {
    expect(peekNextAccountIndex(EVM)).toBe(0);
  });

  it('consume persists index+1 under the unchanged pmp.bidIndex wire key', () => {
    consumeAccountIndex(EVM, 0);
    const map = JSON.parse(localStorage.getItem(INDEX_KEY)!) as Record<string, number>;
    expect(map[EVM.toLowerCase()]).toBe(1);
    expect(peekNextAccountIndex(EVM)).toBe(1);

    consumeAccountIndex(EVM, 1);
    expect(peekNextAccountIndex(EVM)).toBe(2);
  });

  it('drops a corrupt (non-integer) persisted counter, falling back to reconciling against accounts', () => {
    localStorage.setItem(INDEX_KEY, JSON.stringify({ [EVM.toLowerCase()]: 1.5 }));
    expect(peekNextAccountIndex(EVM)).toBe(0);
  });

  it('never collides with an existing account even when the counter lags (recovery collision)', () => {
    consumeAccountIndex(EVM, 3); // counter now 4
    upsertDerivedAccount(EVM, {
      accountIndex: 11,
      amountHuman: '1',
      eoaAddress: '0x000000000000000000000000000000000000dEaD',
      lifecycle: 'recovered',
      timestamp: 1,
    });
    expect(peekNextAccountIndex(EVM)).toBe(12);
  });
});

describe('channel — channel isolation (separate counter + records)', () => {
  const EVM = '0x00000000000000000000000000000000000abc42';
  const CHANNEL = 'fast-session';
  const CHANNEL_INDEX_KEY = 'pmp.bidIndex:fast-session';
  const CHANNEL_ACCOUNTS_KEY = 'pmp.bids:fast-session';
  const account = (accountIndex: number): DerivedAccountRecord => ({
    accountIndex,
    amountHuman: '1',
    eoaAddress: '0x000000000000000000000000000000000000dEaD',
    lifecycle: 'minted',
    timestamp: 1,
  });

  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('omitting channel writes the LEGACY keys (default channel back-compat)', () => {
    consumeAccountIndex(EVM, 0); // no channel
    upsertDerivedAccount(EVM, account(0)); // no channel
    expect(JSON.parse(localStorage.getItem('pmp.bidIndex')!)[EVM.toLowerCase()]).toBe(1);
    expect(readDerivedAccounts(EVM).map((a) => a.accountIndex)).toEqual([0]);
    // No suffixed channel key is written for the default (absence) channel.
    expect(localStorage.getItem('pmp.bidIndex:')).toBeNull();
    expect(localStorage.getItem('pmp.bids:')).toBeNull();
  });

  it('migrateLegacyAccounts routes a channel burn cursor to its OWN channel, not default', () => {
    // A fast-session burn cursor carries its channel; migration must file the
    // record in that channel so its reserved-band index never poisons default peek.
    localStorage.setItem(
      'pmp.inflightBurn',
      JSON.stringify({
        [EVM.toLowerCase()]: {
          burnTxHash: `0x${'ab'.repeat(32)}`,
          eoaAddress: '0x000000000000000000000000000000000000dEaD',
          bidIndex: 2 ** 48 + 3,
          amountHuman: '1',
          channel: CHANNEL,
        },
      }),
    );
    migrateLegacyAccounts(EVM);
    // Filed under the channel...
    expect(readDerivedAccounts(EVM, CHANNEL).map((a) => a.accountIndex)).toEqual([2 ** 48 + 3]);
    // ...NOT the default store, so the default next index stays unpoisoned.
    expect(readDerivedAccounts(EVM)).toEqual([]);
    expect(peekNextAccountIndex(EVM)).toBe(0);
  });

  it('consumes a channel under a suffixed counter key, never touching the default counter', () => {
    consumeAccountIndex(EVM, 5, CHANNEL);
    expect(JSON.parse(localStorage.getItem(CHANNEL_INDEX_KEY)!)[EVM.toLowerCase()]).toBe(6);
    expect(localStorage.getItem('pmp.bidIndex')).toBeNull();
    expect(peekNextAccountIndex(EVM, CHANNEL)).toBe(6);
    expect(peekNextAccountIndex(EVM)).toBe(0); // default channel untouched
  });

  it('stores channel records under a suffixed key, invisible to the default channel', () => {
    upsertDerivedAccount(EVM, account(7), CHANNEL);
    expect(localStorage.getItem(CHANNEL_ACCOUNTS_KEY)).not.toBeNull();
    expect(localStorage.getItem('pmp.bids')).toBeNull();
    expect(readDerivedAccounts(EVM, CHANNEL).map((a) => a.accountIndex)).toEqual([7]);
    expect(readDerivedAccounts(EVM)).toEqual([]); // default channel sees nothing
  });

  it('reconciles peek against ONLY its own channel records (closes the cross-channel poison)', () => {
    upsertDerivedAccount(EVM, account(4)); // default record at 4 (no channel)
    upsertDerivedAccount(EVM, account(2 ** 48 + 9), CHANNEL); // channel record in its band
    // The default next index ignores the channel record (no poison from a session)...
    expect(peekNextAccountIndex(EVM)).toBe(5);
    // ...and the channel next index ignores the default record.
    expect(peekNextAccountIndex(EVM, CHANNEL)).toBe(2 ** 48 + 10);
  });

  it('keeps two non-default channels fully independent', () => {
    consumeAccountIndex(EVM, 0, 'a');
    seedAccountIndex(EVM, 4, 'b');
    expect(peekNextAccountIndex(EVM, 'a')).toBe(1);
    expect(peekNextAccountIndex(EVM, 'b')).toBe(4);
    expect(peekNextAccountIndex(EVM)).toBe(0);
  });
});

describe('seedAccountIndex — chain-seeded reuse guard (cross-device)', () => {
  const INDEX_KEY = 'pmp.bidIndex';
  const EVM = '0x00000000000000000000000000000000000abc42';

  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('raises the counter on a FRESH store so the next index is highestUsed+1', () => {
    // Fresh browser: no persisted counter → would start at 0 and reuse index 0.
    expect(peekNextAccountIndex(EVM)).toBe(0);
    seedAccountIndex(EVM, 3); // chain shows indices 0,1,2 used → next must be 3
    const map = JSON.parse(localStorage.getItem(INDEX_KEY)!) as Record<string, number>;
    expect(map[EVM.toLowerCase()]).toBe(3);
    expect(peekNextAccountIndex(EVM)).toBe(3);
  });

  it('is monotonic — never lowers an already-higher counter', () => {
    consumeAccountIndex(EVM, 4); // counter now 5
    seedAccountIndex(EVM, 3); // stale/lower chain seed must not regress
    expect(peekNextAccountIndex(EVM)).toBe(5);
  });

  it('ignores a non-positive or non-integer minNextIndex', () => {
    seedAccountIndex(EVM, 0);
    seedAccountIndex(EVM, -1);
    seedAccountIndex(EVM, 1.5);
    expect(localStorage.getItem(INDEX_KEY)).toBeNull();
    expect(peekNextAccountIndex(EVM)).toBe(0);
  });
});
