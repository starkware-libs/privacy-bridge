import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { hasAnyInflightTransfer } from './depositIn';

// FUND-SAFETY (Bugbot — "Cash-out cursor skips switch guard" + generic-guard
// hardening): the network switch calls disconnect() which wipes ALL pmp.* keys, so
// ANY unresolved resumable cursor left behind is stranded funds. The guard the
// switch consults (hasAnyInflightTransfer) must therefore be GENERIC — it must
// block on ANY `pmp.inflight*` cursor that holds a resumable record, discovered by
// scanning storage keys at runtime, NOT an enumerated list of the currently-known
// cursor types. A corrupt/unparseable/empty cursor must NOT block (nothing to
// resume off garbage), matching the per-type readers' behavior.
//
// The per-type coverage (deposit/burn/return specific validity shapes) is unit-
// tested in depositIn/account-store/returnIn *.test.ts; here we prove the GENERIC
// property: cash-out blocks, an arbitrary future cursor blocks, garbage doesn't,
// and no cursor is allowed.

const INFLIGHT_CASH_OUT_KEY = 'pmp.inflightCashOut';
// A resumable per-address cursor map: keyed by EVM address → a non-empty record.
const RESUMABLE_RECORD = {
  burnTx: `0x${'ab'.repeat(32)}`,
  amount: '1000000',
  destination: '0x000000000000000000000000000000000000dEaD',
};

describe('hasAnyInflightTransfer — GENERIC inflight-cursor guard (Bugbot: cash-out + forward-compat)', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('(d) is FALSE with no persisted cursors — switch allowed', () => {
    expect(hasAnyInflightTransfer()).toBe(false);
  });

  it('(a) BLOCKS on a persisted pmp.inflightCashOut cursor', () => {
    localStorage.setItem(
      INFLIGHT_CASH_OUT_KEY,
      JSON.stringify({ '0x00000000000000000000000000000000000abcde': RESUMABLE_RECORD }),
    );
    expect(hasAnyInflightTransfer()).toBe(true);
  });

  it('(b) forward-compat: BLOCKS on an ARBITRARY unknown pmp.inflight<Something> cursor', () => {
    // A cursor type that does not exist yet — proves the guard is NOT enumerated.
    localStorage.setItem(
      'pmp.inflightSomethingBrandNew',
      JSON.stringify({ '0x00000000000000000000000000000000000fffff': RESUMABLE_RECORD }),
    );
    expect(hasAnyInflightTransfer()).toBe(true);
  });

  it('(c) does NOT block on a CORRUPT / unparseable cursor (nothing to resume off garbage)', () => {
    localStorage.setItem('pmp.inflightSomethingBrandNew', 'not-json{{{');
    expect(hasAnyInflightTransfer()).toBe(false);
  });

  it('does NOT block on an EMPTY cursor map', () => {
    localStorage.setItem(INFLIGHT_CASH_OUT_KEY, '{}');
    expect(hasAnyInflightTransfer()).toBe(false);
  });

  it('does NOT block on a non-inflight pmp.* key (e.g. the account-history key) even if populated', () => {
    // Only pmp.inflight* keys are transfer cursors; other pmp.* state is not.
    localStorage.setItem('pmp.bids', JSON.stringify({ '0xabc': [{ accountIndex: 0 }] }));
    expect(hasAnyInflightTransfer()).toBe(false);
  });
});
