// Bug-hunter supervisor test file
// RED = fails on current code → PROVEN bug
// GREEN = passes on current code → documents behavior (not a bug)

import { describe, it, expect } from 'vitest';
import { formatTokenAmount } from './discover';
import { isValidInflightReturn } from './returnIn';

// ---- D3: formatTokenAmount with negative decimals ----
describe('D3 — formatTokenAmount negative decimals', () => {
  it('throws a clear RangeError with >=0 message on negative decimals', () => {
    expect(() => formatTokenAmount(100n, -1)).toThrowError(/must be >= 0/);
  });
});

// ---- D5: isValidInflightReturn unbounded amount regex (issue #110, FIXED) ----
// Was: the validator accepted arbitrarily-large digit strings (no length bound
// alongside the /^[0-9]+$/ regex) — defense-in-depth gap on the persisted return
// cursor. Fixed by adding a `r.amount.length <= 80` bound (packages/bridge-core/
// src/core/returnIn.ts). See also the dedicated coverage in returnIn.test.ts.
describe('D5 — isValidInflightReturn unbounded amount [behavioral probe]', () => {
  const validBase = {
    phase: 'cctp' as const,
    accountIndex: 0,
    burnTx: '0xabc123',
    sourceDomain: 7,
    anonymizerRecipient: '0xdeadbeef',
    evmChainId: 137,
  };

  it('rejects a 10000-digit amount string (upper-bound guard, #110)', () => {
    const hugeAmount = '9'.repeat(10000);
    expect(isValidInflightReturn({ ...validBase, amount: hugeAmount })).toBe(false);
  });
});
