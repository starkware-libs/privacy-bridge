import { describe, it, expect, beforeEach } from 'vitest';
import { gapLimitScan, scanDerivedAccounts, type ScannedAccount } from './accountScan';
import { readDerivedAccounts, upsertDerivedAccount } from './account-store';

// A fake probe: indices in `active` return a ScannedAccount; everything else is null.
function fakeProbe(active: Map<number, bigint>) {
  return async (accountIndex: number): Promise<ScannedAccount | null> =>
    active.has(accountIndex)
      ? {
          accountIndex,
          eoaAddress: `0x${accountIndex.toString(16).padStart(40, '0')}`,
          depositWallet: `0x${(accountIndex + 0x1000).toString(16).padStart(40, '0')}`,
          usdcBalanceWei: active.get(accountIndex)!,
        }
      : null;
}

describe('gapLimitScan', () => {
  it('recovers a contiguous run of consumed indices', async () => {
    const active = new Map([[0, 1_000_000n], [1, 2_000_000n], [2, 500_000n]]);
    const found = await gapLimitScan(fakeProbe(active), { gapLimit: 5 });
    expect(found.map((b) => b.accountIndex)).toEqual([0, 1, 2]);
    expect(found[1].usdcBalanceWei).toBe(2_000_000n);
  });

  it('tolerates an interior gap smaller than gapLimit', async () => {
    // index 1 burned-but-unminted (empty), 2 funded again.
    const active = new Map([[0, 1n], [2, 1n]]);
    const found = await gapLimitScan(fakeProbe(active), { gapLimit: 3 });
    expect(found.map((b) => b.accountIndex)).toEqual([0, 2]);
  });

  it('stops after gapLimit consecutive empty indices', async () => {
    const active = new Map([[0, 1n]]); // then 1,2,3 empty with gapLimit 3 → stop
    const found = await gapLimitScan(fakeProbe(active), { gapLimit: 3 });
    expect(found.map((b) => b.accountIndex)).toEqual([0]);
  });

  it('never scans past maxIndices', async () => {
    const active = new Map(Array.from({ length: 10 }, (_, i) => [i, 1n] as const));
    const found = await gapLimitScan(fakeProbe(active), { gapLimit: 5, maxIndices: 4 });
    expect(found.map((b) => b.accountIndex)).toEqual([0, 1, 2, 3]);
  });

  // #162: with gapLimit: 0, the loop condition `consecutiveEmpty < gapLimit`
  // (0 < 0) is false BEFORE index 0 is ever probed — the scan silently returns
  // empty even when index 0 IS active. gapLimit is meant to tolerate N
  // consecutive empties before stopping; 0 (or negative) must still probe at
  // least once, not skip the scan entirely.
  it('#162: gapLimit: 0 still probes index 0 (does not skip the scan)', async () => {
    const active = new Map([[0, 1_000_000n]]);
    const found = await gapLimitScan(fakeProbe(active), { gapLimit: 0 });
    expect(found.map((b) => b.accountIndex)).toEqual([0]);
  });

  it('#162: gapLimit: 0 stops immediately after the first empty index', async () => {
    const active = new Map([[1, 1n]]); // index 0 empty, index 1 active
    const found = await gapLimitScan(fakeProbe(active), { gapLimit: 0 });
    expect(found).toEqual([]);
  });
});

describe('scanDerivedAccounts', () => {
  beforeEach(() => localStorage.clear());

  it('upserts recovered records with the on-chain amount and minted lifecycle', async () => {
    const depositWallet = '0x' + '2'.repeat(40);
    const fakeScan = async (): Promise<ScannedAccount[]> => [
      { accountIndex: 0, eoaAddress: '0x' + '1'.repeat(40), depositWallet, usdcBalanceWei: 1_500_000n },
    ];
    const evmAddress = '0x' + 'a'.repeat(40);

    const accounts = await scanDerivedAccounts(
      { evmAddress, signature: '0xsig', resolveDepositWallet: async () => '0x' + '0'.repeat(40) },
      fakeScan,
    );

    expect(accounts).toHaveLength(1);
    expect(accounts[0].accountIndex).toBe(0);
    expect(accounts[0].amountHuman).toBe('1.5'); // 1_500_000 at 6 dp
    expect(accounts[0].lifecycle).toBe('minted');
    expect(readDerivedAccounts(evmAddress)[0].eoaAddress.toLowerCase()).toBe('0x' + '1'.repeat(40));
    // The deposit wallet (mint recipient / order maker) is recorded as funder.
    expect(readDerivedAccounts(evmAddress)[0].funder?.toLowerCase()).toBe(depositWallet);
  });

  it('upgrades an existing recovered record to the real on-chain amount and minted lifecycle', async () => {
    const evmAddress = '0x' + 'a'.repeat(40);
    const eoaAddress = '0x' + '1'.repeat(40);

    // Pre-populate a record as if it was previously recovered (signature-only, no on-chain read).
    upsertDerivedAccount(evmAddress, {
      accountIndex: 0,
      amountHuman: '1',
      eoaAddress,
      lifecycle: 'recovered',
      timestamp: 0,
    });

    // The chain scan returns the same EOA with a real on-chain balance.
    const fakeScan = async (): Promise<ScannedAccount[]> => [
      { accountIndex: 0, eoaAddress, depositWallet: '0x' + '2'.repeat(40), usdcBalanceWei: 1_500_000n },
    ];

    const accounts = await scanDerivedAccounts(
      { evmAddress, signature: '0xsig', resolveDepositWallet: async () => '0x' + '0'.repeat(40) },
      fakeScan,
    );

    expect(accounts).toHaveLength(1);
    // Amount upgraded from the on-chain balance (1_500_000 at 6 dp = 1.5).
    expect(accounts[0].amountHuman).toBe('1.5');
    // Lifecycle promoted from 'recovered' to 'minted'.
    expect(accounts[0].lifecycle).toBe('minted');
    // Original EOA address preserved.
    expect(accounts[0].eoaAddress.toLowerCase()).toBe(eoaAddress);
    // timestamp=0 preserved (no original time known).
    expect(accounts[0].timestamp).toBe(0);
  });
});
