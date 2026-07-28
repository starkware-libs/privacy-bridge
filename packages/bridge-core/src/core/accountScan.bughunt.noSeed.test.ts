// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// BUGHUNT B — accountScan.scanDerivedAccounts writes recovered accounts to
// pmp.bids but NEVER seeds the pmp.bidIndex counter.
//
// Claim: scanDerivedAccounts (accountScan.ts:95-118) upserts each discovered
// account via upsertDerivedAccount (writing pmp.bids) but does NOT call
// seedAccountIndex(evmAddress, highest+1) to raise the pmp.bidIndex counter.
// peekNextAccountIndex() falls back to `nextAccountIndex(counter, accounts)`
// which reconciles against pmp.bids — so under a clean pmp.bids the counter
// LOOKS fine — but as soon as pmp.bids is cleared, evicted, or the record for
// this EVM address is otherwise dropped (dev tools tampering, migration, quota
// eviction), the counter regresses to 0. The trading-layer sibling
// (apps/web/src/starknet/bidScan.ts syncBidsFromChain :266 and
// seedBidIndexFromChain :318) DOES call seedBidIndex(evmAddress, highest+1) —
// this is the belt-and-suspenders described in the "bid-index cross-browser
// reuse" lesson in .claude/rules/code-style.md. bridge-core's counterpart is
// missing that write, defeating the same cross-device reuse guard when someone
// uses the SDK's own scanDerivedAccounts.
//
// RED probe: inject a fake scan that returns two used indices [2, 5]. After
// scanDerivedAccounts returns, read localStorage's pmp.bidIndex map directly.
// A correct seed would raise the counter for this EVM address to 6.

import { describe, it, expect, beforeEach } from 'vitest';
import { scanDerivedAccounts, type ScannedAccount } from './accountScan';

describe('BUGHUNT B — scanDerivedAccounts does not seed pmp.bidIndex', () => {
  beforeEach(() => localStorage.clear());

  it('raises pmp.bidIndex to highestUsed+1 so pmp.bids eviction cannot regress the counter', async () => {
    const evmAddress = '0x' + 'a'.repeat(40);
    const fakeScan = async (): Promise<ScannedAccount[]> => [
      {
        accountIndex: 2,
        eoaAddress: '0x' + '2'.repeat(40),
        depositWallet: '0x' + '3'.repeat(40),
        usdcBalanceWei: 1_000_000n,
      },
      {
        accountIndex: 5,
        eoaAddress: '0x' + '5'.repeat(40),
        depositWallet: '0x' + '6'.repeat(40),
        usdcBalanceWei: 1_000_000n,
      },
    ];

    await scanDerivedAccounts(
      {
        evmAddress,
        signature: '0xsig',
        resolveDepositWallet: async () => '0x' + '0'.repeat(40),
      },
      fakeScan,
    );

    // pmp.bidIndex map should carry evmAddress -> 6 (highestUsed 5, +1) after
    // the seed. Read localStorage DIRECTLY (readAccountIndexMap is not exported)
    // so we test the persisted counter, not the pmp.bids-reconciled peek.
    const raw = localStorage.getItem('pmp.bidIndex');
    const map = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    expect(map[evmAddress.toLowerCase()]).toBe(6);
  });
});
