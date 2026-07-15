import { beforeEach, describe, expect, it } from 'vitest';
import { PMP_STORAGE_KEYS, clearDeviceIdentity } from './device-store';

// C1 (privacy leak, PROVEN HIGH): "Disconnect / Forget this device" must wipe
// EVERY per-EVM-address pmp.* key the app writes. This bridge-core
// clearDeviceIdentity IS the function the real forget flow calls
// (WalletProvider.disconnect → clearDeviceIdentity). Its PMP_STORAGE_KEYS
// previously omitted four per-address keys written by the app-side identity
// stores — so residual trading metadata survived a forget:
//   - pmp.closed            (history-store.ts:      deposit wallets + P&L)
//   - pmp.chainSync         (chain-sync-store.ts:   scan timestamps)
//   - pmp.unclaimedReturns  (unclaimed-store.ts:    account indices + amounts)
//   - pmp.poolReturns       (pool-returns-store.ts: Starknet claim tx hashes + amounts)
// These are frozen wire strings, so we write them literally (bridge-core is
// acyclic-below the apps and can't import their stores).

const EVM_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';

const PER_ADDRESS_APP_KEYS = [
  'pmp.closed',
  'pmp.chainSync',
  'pmp.unclaimedReturns',
  'pmp.poolReturns',
] as const;

beforeEach(() => {
  localStorage.clear();
});

describe('bridge-core clearDeviceIdentity (real disconnect path) leaves no residual per-address metadata', () => {
  it('wipes the app-side per-EVM-address keys (pmp.closed / chainSync / unclaimedReturns / poolReturns) on forget', () => {
    // Populate the app-side per-address keys with representative shapes.
    localStorage.setItem('pmp.closed', JSON.stringify({ [EVM_ADDRESS]: { positions: [], syncedAt: 5 } }));
    localStorage.setItem('pmp.chainSync', JSON.stringify({ [EVM_ADDRESS]: { fullScannedAt: 5 } }));
    localStorage.setItem(
      'pmp.unclaimedReturns',
      JSON.stringify({ [EVM_ADDRESS]: { entries: [{ accountIndex: 3, amountWei: '1000000' }] } }),
    );
    localStorage.setItem(
      'pmp.poolReturns',
      JSON.stringify({
        [EVM_ADDRESS]: [
          { bidIndex: 2, amountWei: '5000000', claimTxHash: '0x' + 'a'.repeat(64), returnedAtMs: 1000 },
        ],
      }),
    );

    for (const key of PER_ADDRESS_APP_KEYS) {
      expect(localStorage.getItem(key)).not.toBeNull();
    }

    clearDeviceIdentity();

    // After "Forget this device" nothing per-address may survive on the REAL path.
    for (const key of PER_ADDRESS_APP_KEYS) {
      expect(localStorage.getItem(key)).toBeNull();
    }
  });

  it('the four app-side per-address keys are part of the wipe set', () => {
    // Guards against the frozen key list drifting out of sync with the app-side
    // stores again (the root cause of C1).
    for (const key of PER_ADDRESS_APP_KEYS) {
      expect(PMP_STORAGE_KEYS).toContain(key);
    }
  });
});
