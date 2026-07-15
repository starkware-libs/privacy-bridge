// BUGHUNT A — accountScan.scanAccountEoas is a BALANCE-ONLY detector.
//
// Claim: On a fresh browser (no local pmp.bidIndex / pmp.bids), the cross-chain
// used-detector must surface EVERY per-account index whose deposit wallet was
// ever consumed — including indices whose funds were fully spent on CLOB or
// fully returned to the pool (the CREATE2 deposit wallet is a CONTRACT that was
// deployed and now holds 0). The strong detector (see apps/web/src/starknet/
// bidScan.ts scanUsedBidIndices, plus the "bid-index cross-browser reuse"
// lesson in .claude/rules/code-style.md) uses BALANCE > 0 || isDeployed. The
// bridge-core counterpart in accountScan.ts:69-86 gates on balance alone, so a
// drained-but-deployed wallet is INVISIBLE and the next bid re-derives the same
// deposit wallet address (privacy break + local record clobber).
//
// RED probe: mock readUsdcBalance to return 0 for every address (drained) and
// pass a `isDepositWalletDeployed` probe that simulates index 3's deposit wallet
// as deployed. Pre-fix: `scanAccountEoas` had no `isDepositWalletDeployed`
// option — the extra probe couldn't be threaded through at all, so the test
// couldn't even express the strong-detector expectation and index 3 stayed
// invisible ⇒ `scanAccountEoas` returned []. Post-fix: the opts accept the
// probe, and `balance > 0 || isDeployed` surfaces index 3.

import { describe, it, expect, vi } from 'vitest';

// Mock BEFORE importing accountScan so the polygonClient reference it captures
// is the mocked one. readUsdcBalance is stubbed to always resolve to 0n —
// simulating "wallet & EOA drained" for every derived address.
vi.mock('./polygonClient', () => ({
  getPolygonPublicClient: () => ({}) as unknown as never,
  readUsdcBalance: async () => 0n,
  POLYGON_USDC_DECIMALS: 6,
}));

import { scanAccountEoas } from './accountScan';

describe('BUGHUNT A — scanAccountEoas misses deployed-but-drained deposit wallets', () => {
  it('surfaces a used index whose deposit wallet is deployed but has 0 balance', async () => {
    // Fake resolver: each index maps to a distinct deposit-wallet address.
    // The BALANCE for every one of these is 0 (per the mock above), but in the
    // real world index 3's deposit wallet IS a deployed contract that was drained
    // (a fully-returned bid). The strong detector observes that via the
    // `isDepositWalletDeployed` probe (post-fix): balance-only would miss it.
    const addressFor = (idx: number) =>
      `0x${(0x1000 + idx).toString(16).padStart(40, '0')}`;
    const resolver = async (_sig: string, idx: number) => addressFor(idx);
    const index3Address = addressFor(3).toLowerCase();
    const isDepositWalletDeployed = async (address: string) =>
      address.toLowerCase() === index3Address;

    const found = await scanAccountEoas('0xtestsig', resolver, {
      gapLimit: 5,
      isDepositWalletDeployed,
    });

    // The strong detector surfaces index 3 (deployed + drained). Balance-only
    // detection (pre-fix) returned [].
    expect(found.map((a) => a.accountIndex)).toContain(3);
  });
});
