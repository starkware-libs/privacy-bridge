// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// transferStrkFromAdmin does a direct out-of-band adminAccount.execute(transferCall)
// (the admin == the manager account), so — like deposit.ts:ensureDepositTokenFunded —
// it must call invalidateManagerNonce() afterwards. Otherwise proven-submit's shared
// localNonce is left stale and the next managerExecute collides (code-52) before
// recovering in-call. The invalidate must land AFTER the tracked transfer completes.
//
// Harness mirrors deploy.paymaster.test.ts (mock at module boundaries; no network),
// with ./proven-submit mocked so invalidateManagerNonce is an inspectable spy and the
// admin funding path is driven end-to-end.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  cfg: {
    ozClassHash: '0xClass',
    strkToken: '0xStrk',
    rpcUrl: '/rpc',
    deployFeeMode: 'default' as 'sponsored' | 'default',
    depositToken: { address: '0xUsdc', symbol: 'USDC', decimals: 6 },
    // Admin present, paymaster ABSENT → ensureAccountDeployed takes the admin path.
    admin: { address: '0xAdmin', privateKey: '0xAdminKey' } as
      | { address: string; privateKey: string }
      | undefined,
    paymaster: undefined as { endpoint: string; apiKey: string } | undefined,
  },
  deployAccount: vi.fn(),
  estimateAccountDeployFee: vi.fn(),
  execute: vi.fn(),
  getClassHashAt: vi.fn(),
  callContract: vi.fn(),
  getDepositTokenBalance: vi.fn(),
  submitAndTrack: vi.fn(),
  invalidateManagerNonce: vi.fn(),
}));

vi.mock('./config', () => ({ config: h.cfg }));

vi.mock('./provider', () => ({
  getRpcProvider: () => ({ getClassHashAt: h.getClassHashAt, callContract: h.callContract }),
  makeAccount: vi.fn(() => ({
    deployAccount: h.deployAccount,
    estimateAccountDeployFee: h.estimateAccountDeployFee,
    execute: h.execute,
  })),
}));

vi.mock('./tx', () => ({ READ_BLOCK: 'pre_confirmed', submitAndTrack: h.submitAndTrack }));
vi.mock('./deposit', () => ({ getDepositTokenBalance: h.getDepositTokenBalance }));
vi.mock('./proven-submit', () => ({ invalidateManagerNonce: h.invalidateManagerNonce }));

import { ensureAccountDeployed } from './deploy';

const STRK = 10n ** 18n;

beforeEach(() => {
  vi.clearAllMocks();
  h.cfg.admin = { address: '0xAdmin', privateKey: '0xAdminKey' };
  h.cfg.paymaster = undefined;
  // Not deployed: getClassHashAt throws (isDeployed → false).
  h.getClassHashAt.mockRejectedValue(new Error('Contract not found'));
  // Deploy fee estimate → fundAmount = deployFunding(1 STRK) = 3 STRK.
  h.estimateAccountDeployFee.mockResolvedValue({ overall_fee: STRK });
  // Admin STRK balance read (getStrkBalanceWei): plenty to cover the transfer.
  h.callContract.mockResolvedValue([(100n * STRK).toString(), '0']);
  h.execute.mockResolvedValue({ transaction_hash: '0xtransfer' });
  h.deployAccount.mockResolvedValue({ transaction_hash: '0xdeploy' });
  // submitAndTrack runs the submit thunk and returns a tracked result with a block.
  h.submitAndTrack.mockImplementation(async (_p: unknown, submit: () => Promise<unknown>) => {
    await submit();
    return { transaction_hash: '0xhash', blockNumber: 1234 };
  });
});

describe('transferStrkFromAdmin — invalidates the manager nonce after the transfer (#103)', () => {
  it('calls invalidateManagerNonce exactly once, after the admin STRK transfer', async () => {
    await ensureAccountDeployed({ address: '0xNew', publicKey: '0xPub', privateKey: '0xPk' });

    expect(h.invalidateManagerNonce).toHaveBeenCalledTimes(1);

    // Ordering: the invalidate must land AFTER the transfer submit (the first
    // submitAndTrack call) so the next managerExecute re-seeds from a settled read.
    const transferOrder = h.submitAndTrack.mock.invocationCallOrder[0];
    const invalidateOrder = h.invalidateManagerNonce.mock.invocationCallOrder[0];
    expect(invalidateOrder).toBeGreaterThan(transferOrder);
  });
});
