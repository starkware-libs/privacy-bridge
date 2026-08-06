// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// #103 regression: ensureDepositTokenFunded's direct adminAccount.execute is invisible
// to proven-submit.ts's shared, locally-authoritative manager nonce counter — it never
// goes through managerExecute. If the admin account shares the manager's on-chain
// address, an out-of-band advance desyncs `localNonce`, forcing a spurious code-52 on
// the next managerExecute (recovered in-call, but wasted + latent risk if that
// recovery ever regresses). Fix: call invalidateManagerNonce() right after the direct
// admin invoke so the next managerExecute re-seeds from a settled chain read.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from 'starknet';

const { submitAndTrackMock, invalidateManagerNonceMock, executeMock, getRpcProviderMock } = vi.hoisted(() => ({
  submitAndTrackMock: vi.fn(async (_provider: unknown, send: () => Promise<{ transaction_hash: string }>) => {
    const r = await send();
    return { transaction_hash: r.transaction_hash, blockNumber: 1 };
  }),
  invalidateManagerNonceMock: vi.fn(),
  executeMock: vi.fn(async () => ({ transaction_hash: '0xfund' })),
  getRpcProviderMock: vi.fn(() => ({ callContract: vi.fn(async () => ['0x0', '0x0']) })),
}));

vi.mock('./tx', () => ({
  READ_BLOCK: 'latest',
  sanitizeErrorMessage: (e: unknown) => String(e),
  submitAndTrack: submitAndTrackMock,
}));
vi.mock('./proven-submit', () => ({
  submitProvenCall: vi.fn(async () => ({ transaction_hash: '0xhash' })),
  paymasterBuildLeg: vi.fn(),
  paymasterExecuteLeg: vi.fn(),
  invalidateManagerNonce: invalidateManagerNonceMock,
}));
vi.mock('./proving', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./proving')>();
  return { ...actual, waitForProvingBlock: vi.fn(async () => 0) };
});
vi.mock('./errorMessages', () => ({ humanizeFinality: (f: unknown) => String(f) }));
vi.mock('./register', () => ({ isAlreadyRegisteredError: () => false }));
vi.mock('@starkware-libs/starknet-privacy-sdk', () => ({
  createPrivateTransfers: vi.fn(),
  IndexerDiscoveryProvider: class {},
}));

vi.mock('./provider', () => ({
  getRpcProvider: getRpcProviderMock,
  makeAccount: () => ({ address: '0xADMIN', execute: executeMock } as unknown as Account),
}));

vi.mock('./config', () => ({
  config: {
    depositToken: { address: '0xUSDC', decimals: 6, symbol: 'USDC', mintEntrypoint: 'mint' },
    admin: { address: '0xADMIN', privateKey: '0xkey' },
    poolAddress: '0xPOOL',
  },
}));

import { ensureDepositTokenFunded } from './deposit';

beforeEach(() => {
  vi.clearAllMocks();
  getRpcProviderMock.mockReturnValue({ callContract: vi.fn(async () => ['0x0', '0x0']) } as never);
  executeMock.mockResolvedValue({ transaction_hash: '0xfund' });
});

describe('#103 — ensureDepositTokenFunded invalidates the shared manager nonce', () => {
  it('calls invalidateManagerNonce() after the direct admin funding execute', async () => {
    await ensureDepositTokenFunded({ account: {} as Account, address: '0xUSER', amountWei: 1_000_000n });

    expect(executeMock).toHaveBeenCalledOnce();
    // The out-of-band admin execute must invalidate the shared manager-nonce counter
    // so the NEXT managerExecute re-seeds from a settled chain read, instead of
    // trusting a localNonce that the direct execute advanced out-of-band.
    expect(invalidateManagerNonceMock).toHaveBeenCalledOnce();
  });

  it('does not call invalidateManagerNonce when the balance already covers the amount (no funding tx)', async () => {
    getRpcProviderMock.mockReturnValue({ callContract: vi.fn(async () => ['0xf4240', '0x0']) } as never); // 1_000_000 already

    await ensureDepositTokenFunded({ account: {} as Account, address: '0xUSER', amountWei: 1_000_000n });

    expect(executeMock).not.toHaveBeenCalled();
    expect(invalidateManagerNonceMock).not.toHaveBeenCalled();
  });
});
