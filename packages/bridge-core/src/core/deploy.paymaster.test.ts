// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Branch tests for ensureAccountDeployed's funding-path selection:
//   paymaster (sponsored) preferred → admin fallback → throw when neither set.
// We mock at the module boundaries (config / provider / tx / starknet) so no
// network is touched and we can toggle which funder is configured per test.

const h = vi.hoisted(() => ({
  cfg: {
    ozClassHash: '0xClass',
    strkToken: '0xStrk',
    rpcUrl: '/rpc',
    // Default 'sponsored' deploy-fee mode (existing behaviour). Tests flip it.
    deployFeeMode: 'sponsored' as 'sponsored' | 'default',
    depositToken: { address: '0xUsdc', symbol: 'USDC', decimals: 6 },
    admin: { address: '0xAdmin', privateKey: '0xAdminKey' } as
      | { address: string; privateKey: string }
      | undefined,
    paymaster: { endpoint: 'https://pm.test', apiKey: 'KEY' } as
      | { endpoint: string; apiKey: string }
      | undefined,
  },
  executePaymasterTransaction: vi.fn(),
  estimatePaymasterTransactionFee: vi.fn(),
  deployAccount: vi.fn(),
  estimateAccountDeployFee: vi.fn(),
  execute: vi.fn(),
  getClassHashAt: vi.fn(),
  callContract: vi.fn(),
  getDepositTokenBalance: vi.fn(),
  submitAndTrack: vi.fn(),
  PaymasterRpcCtor: vi.fn(),
}));

vi.mock('./config', () => ({ config: h.cfg }));

vi.mock('./provider', () => ({
  getRpcProvider: () => ({ getClassHashAt: h.getClassHashAt, callContract: h.callContract }),
  makeAccount: vi.fn(() => ({
    executePaymasterTransaction: h.executePaymasterTransaction,
    estimatePaymasterTransactionFee: h.estimatePaymasterTransactionFee,
    deployAccount: h.deployAccount,
    estimateAccountDeployFee: h.estimateAccountDeployFee,
    execute: h.execute,
  })),
}));

vi.mock('./tx', () => ({ READ_BLOCK: 'pre_confirmed', submitAndTrack: h.submitAndTrack }));

// deploy.ts imports getDepositTokenBalance from ./deposit for the pay-in-token
// pre-check. Mock it so the test controls the account's USDC balance without the SDK.
vi.mock('./deposit', () => ({ getDepositTokenBalance: h.getDepositTokenBalance }));

vi.mock('starknet', () => ({
  PaymasterRpc: class {
    constructor(opts: unknown) {
      h.PaymasterRpcCtor(opts);
    }
  },
  // deploy.ts now imports RpcError for isContractNotFoundError's type guard. These
  // tests reject with a plain Error('Contract not found') (matched via the message
  // fallback), so RpcError just needs to be a callable class for `instanceof`.
  RpcError: class RpcError {},
}));

import { ensureAccountDeployed } from './deploy';

const STRK = 10n ** 18n;

beforeEach(() => {
  vi.clearAllMocks();
  h.cfg.admin = { address: '0xAdmin', privateKey: '0xAdminKey' };
  h.cfg.paymaster = { endpoint: 'https://pm.test', apiKey: 'KEY' };
  h.cfg.deployFeeMode = 'sponsored';
  // Not deployed: getClassHashAt throws (isDeployed → false).
  h.getClassHashAt.mockRejectedValue(new Error('Contract not found'));
  // submitAndTrack invokes the submit thunk (so the underlying call is exercised)
  // and returns a fixed tracked result with a block number.
  h.submitAndTrack.mockImplementation(
    async (_p: unknown, submit: () => Promise<unknown>) => {
      await submit();
      return { transaction_hash: '0xhash', blockNumber: 1234 };
    },
  );
});

describe('ensureAccountDeployed funding-path selection', () => {
  it('prefers the AVNU paymaster (sponsored deploy) when configured — no admin STRK transfer', async () => {
    const phases: string[] = [];
    const block = await ensureAccountDeployed({
      address: '0xacc',
      publicKey: '0xpub',
      privateKey: '0xpriv',
      onStatus: ({ phase }) => phases.push(phase),
    });

    expect(h.PaymasterRpcCtor).toHaveBeenCalledWith({
      nodeUrl: 'https://pm.test',
      headers: { 'x-paymaster-api-key': 'KEY' },
    });
    // Sponsored mode passes no pay-in-token cap (maxFeeInGasToken is undefined).
    expect(h.executePaymasterTransaction).toHaveBeenCalledWith(
      [],
      {
        feeMode: { mode: 'sponsored' },
        deploymentData: {
          address: '0xacc',
          class_hash: '0xClass',
          salt: '0xpub',
          calldata: ['0xpub'],
          version: 1,
        },
      },
      undefined,
    );
    // No admin-funded fallback ran: no estimate, no STRK transfer, no self-deploy.
    expect(h.estimateAccountDeployFee).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.deployAccount).not.toHaveBeenCalled();
    expect(block).toBe(1234);
    expect(phases).toContain('deploying');
    expect(phases).toContain('deployed');
    // Sponsored mode pays no fee → no 'estimating'/'funding' phases.
    expect(phases).not.toContain('funding');
    expect(phases).not.toContain('estimating');
  });

  it('pay-in-token mode: feeMode is {default, gasToken:USDC}, submits with a maxFee', async () => {
    h.cfg.deployFeeMode = 'default';
    // AVNU's estimate (USDC, 6dp). The account holds enough → no shortfall throw.
    h.estimatePaymasterTransactionFee.mockResolvedValue({
      suggested_max_fee_in_gas_token: 500_000n,
      estimated_fee_in_gas_token: 400_000n,
    });
    h.getDepositTokenBalance.mockResolvedValue(42_000_000n);

    const phases: string[] = [];
    const block = await ensureAccountDeployed({
      address: '0xacc',
      publicKey: '0xpub',
      privateKey: '0xpriv',
      onStatus: ({ phase }) => phases.push(phase),
    });

    const expectedFees = {
      feeMode: { mode: 'default', gasToken: '0xUsdc' },
      deploymentData: {
        address: '0xacc',
        class_hash: '0xClass',
        salt: '0xpub',
        calldata: ['0xpub'],
        version: 1,
      },
    };
    // Estimated in the gas token first, then submitted with the suggested max fee.
    expect(h.estimatePaymasterTransactionFee).toHaveBeenCalledWith([], expectedFees);
    expect(h.executePaymasterTransaction).toHaveBeenCalledWith([], expectedFees, 500_000n);
    expect(block).toBe(1234);
    // An 'estimating' phase precedes the deploy (the sponsored path has none).
    expect(phases).toContain('estimating');
    expect(phases).toContain('deployed');
  });

  it('pay-in-token mode: throws an actionable error when the account USDC is short', async () => {
    h.cfg.deployFeeMode = 'default';
    h.estimatePaymasterTransactionFee.mockResolvedValue({
      suggested_max_fee_in_gas_token: 500_000n,
      estimated_fee_in_gas_token: 400_000n,
    });
    // Holds less than the suggested max fee → pre-check fails before submit.
    h.getDepositTokenBalance.mockResolvedValue(100_000n);

    await expect(
      ensureAccountDeployed({ address: '0xacc', publicKey: '0xpub', privateKey: '0xpriv' }),
    ).rejects.toThrow(/needs ~0\.5 USDC|increase the deposit/i);
    expect(h.executePaymasterTransaction).not.toHaveBeenCalled();
  });

  it('falls back to the admin-funded deploy when no paymaster is configured', async () => {
    h.cfg.paymaster = undefined;
    h.estimateAccountDeployFee.mockResolvedValue({ overall_fee: 0n });
    // Admin STRK balance pre-check: return ≥ 1 STRK as u256 (low, high) felts.
    h.callContract.mockResolvedValue([`0x${(2n * STRK).toString(16)}`, '0x0']);

    const block = await ensureAccountDeployed({
      address: '0xacc',
      publicKey: '0xpub',
      privateKey: '0xpriv',
    });

    expect(h.deployAccount).toHaveBeenCalled();
    expect(h.execute).toHaveBeenCalled(); // admin STRK transfer
    expect(h.executePaymasterTransaction).not.toHaveBeenCalled();
    expect(h.PaymasterRpcCtor).not.toHaveBeenCalled();
    expect(block).toBe(1234);
  });

  it('throws a clear, actionable error when neither paymaster nor admin is configured', async () => {
    h.cfg.paymaster = undefined;
    h.cfg.admin = undefined;
    await expect(
      ensureAccountDeployed({ address: '0xacc', publicKey: '0xpub', privateKey: '0xpriv' }),
    ).rejects.toThrow(/No account-deploy funding configured/);
    expect(h.executePaymasterTransaction).not.toHaveBeenCalled();
    expect(h.deployAccount).not.toHaveBeenCalled();
  });

  it('returns undefined and funds nothing when the account is already deployed', async () => {
    h.getClassHashAt.mockResolvedValue('0xAlreadyDeployed');
    const block = await ensureAccountDeployed({
      address: '0xacc',
      publicKey: '0xpub',
      privateKey: '0xpriv',
    });
    expect(block).toBeUndefined();
    expect(h.executePaymasterTransaction).not.toHaveBeenCalled();
    expect(h.deployAccount).not.toHaveBeenCalled();
    expect(h.PaymasterRpcCtor).not.toHaveBeenCalled();
  });
});
