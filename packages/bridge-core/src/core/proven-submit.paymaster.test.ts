// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Branch tests for the proven-submit AVNU paymaster path
// (submitProvenViaPaymaster / submitProvenCall routing). The AVNU client is mocked
// so no network is touched; we assert the buildTransaction→(sign)→executeTransaction
// wiring against AVNU's LIVE schema: proof + pool_address forwarding, the `invoke`
// shape (typed_data + signature), version "0x1", the non-zero fee_action guard, and
// that the manager path is NOT taken when the paymaster is configured.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  cfg: {
    poolAddress: '0xPOOL',
    depositToken: { address: '0xUSDC' },
    paymaster: { endpoint: 'https://pm.test', apiKey: 'KEY', feeMode: 'sponsored_private', poolFeeToken: '' } as
      | { endpoint: string; apiKey: string; feeMode: 'sponsored_private' | 'sponsored'; poolFeeToken: string }
      | undefined,
    admin: undefined as { address: string; privateKey: string } | undefined,
  },
  buildTransaction: vi.fn(),
  executeTransaction: vi.fn(),
}));

vi.mock('./config', () => ({ config: h.cfg }));
vi.mock('./avnuPaymaster', () => ({
  buildTransaction: h.buildTransaction,
  executeTransaction: h.executeTransaction,
  // Passthrough conversion to the live CALL shape so request assertions read naturally.
  toAvnuCall: (c: { contractAddress: string; entrypoint: string; calldata: string[] }) => ({
    to: c.contractAddress,
    selector: c.entrypoint,
    calldata: (c.calldata ?? []).map((x) => x.toString()),
  }),
}));
vi.mock('./provider', () => ({ makeAccount: vi.fn() }));

import {
  submitProvenViaPaymaster,
  submitProvenCall,
  paymasterBuildLeg,
  paymasterExecuteLeg,
} from './proven-submit';

const POOL_CALL = { contractAddress: '0xPOOL', entrypoint: 'apply_actions', calldata: ['7'] };
const PROOF = { proof: '0xPROOF', proofFacts: ['0xf1'] };

function fakeAccount() {
  return {
    address: '0xACCT',
    signMessage: vi.fn(async () => ['0x1a2b', '0x3c4d']),
  } as unknown as Parameters<typeof submitProvenViaPaymaster>[0] & { signMessage: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.cfg.paymaster = { endpoint: 'https://pm.test', apiKey: 'KEY', feeMode: 'sponsored_private', poolFeeToken: '' };
  h.cfg.admin = undefined;
  // Default build response: zero fee_action so the guard passes.
  h.buildTransaction.mockResolvedValue({ type: 'apply_action', fee_action: { type: 'withdraw', recipient: '0xr', token: '0xUSDC', amount: '0x0' } });
  h.executeTransaction.mockResolvedValue({ tracking_id: 'trk', transaction_hash: '0xHASH' });
});

describe('submitProvenViaPaymaster — apply_action (register/withdraw/claim)', () => {
  it('forwards proof + proof_facts + pool_address, does not sign, returns the tx hash', async () => {
    const account = fakeAccount();
    const res = await submitProvenViaPaymaster(account, POOL_CALL, PROOF);

    expect(account.signMessage).not.toHaveBeenCalled();
    const buildReq = h.buildTransaction.mock.calls[0]![0];
    expect(buildReq.transaction.type).toBe('apply_action');
    expect(buildReq.parameters.version).toBe('0x1');

    const execReq = h.executeTransaction.mock.calls[0]![0];
    expect(execReq.transaction.type).toBe('apply_action');
    expect(execReq.parameters.version).toBe('0x1');
    expect(execReq.transaction.apply_action.pool_address).toBe('0xPOOL');
    expect(execReq.transaction.apply_action.apply_actions_call).toEqual({
      to: '0xPOOL',
      selector: 'apply_actions',
      calldata: ['7'],
    });
    expect(execReq.transaction.apply_action.proof).toBe('0xPROOF');
    expect(execReq.transaction.apply_action.proof_facts).toEqual(['0xf1']);
    expect(execReq.transaction.invoke).toBeUndefined();
    expect(res.transaction_hash).toBe('0xHASH');
  });

  it('defaults the sponsored_private pool-fee token to the deposit token when poolFeeToken is empty', async () => {
    await submitProvenViaPaymaster(fakeAccount(), POOL_CALL, PROOF);
    expect(h.buildTransaction.mock.calls[0]![0].parameters.fee_mode).toEqual({
      mode: 'sponsored_private',
      pool_fee_token: '0xUSDC',
    });
  });

  it('throws when fee_action is non-zero (the fee withdraw must be baked into the proof — both modes)', async () => {
    // beforeEach sets feeMode 'sponsored_private'.
    h.buildTransaction.mockResolvedValue({ type: 'apply_action', fee_action: { type: 'withdraw', recipient: '0xr', token: '0xUSDC', amount: '0x3e8' } });
    await expect(submitProvenViaPaymaster(fakeAccount(), POOL_CALL, PROOF)).rejects.toThrow(/fee_action is non-zero/i);
    expect(h.executeTransaction).not.toHaveBeenCalled();
  });

  it('also throws under sponsored on a non-zero fee_action (sponsored only fixes the fee token to STRK, it does NOT waive the fee)', async () => {
    h.cfg.paymaster = { endpoint: 'https://pm.test', apiKey: 'KEY', feeMode: 'sponsored', poolFeeToken: '' };
    // The exact 4-STRK fee_action the live sponsored register returned (→ AVNU 165 MISSING_FEE_TRANSFER_TO if submitted).
    h.buildTransaction.mockResolvedValue({ type: 'apply_action', fee_action: { type: 'withdraw', recipient: '0xr', token: '0xSTRK', amount: '0x3782dace9d900000' } });
    await expect(submitProvenViaPaymaster(fakeAccount(), POOL_CALL, PROOF)).rejects.toThrow(/fee_action is non-zero/i);
    expect(h.executeTransaction).not.toHaveBeenCalled();
  });

  it('#237: forwards leg.onRelayStart through to paymasterExecuteLeg, fired before executeTransaction', async () => {
    const onRelayStart = vi.fn();
    const order: string[] = [];
    onRelayStart.mockImplementation(() => order.push('onRelayStart'));
    h.executeTransaction.mockImplementation(async () => {
      order.push('executeTransaction');
      return { tracking_id: 'trk', transaction_hash: '0xHASH' };
    });

    // Pre-fix: ProvenLeg has no onRelayStart field, and submitProvenViaPaymaster
    // never passed a 5th opts arg to paymasterExecuteLeg — this callback was
    // unreachable from this entry point. FAILS (never called).
    await submitProvenViaPaymaster(fakeAccount(), POOL_CALL, PROOF, { onRelayStart });

    expect(onRelayStart).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['onRelayStart', 'executeTransaction']);
  });
});

describe('submitProvenViaPaymaster — invoke_and_apply_action (deposit)', () => {
  it('signs the typed_data and carries it under transaction.invoke', async () => {
    const approve = { contractAddress: '0xUSDC', entrypoint: 'approve', calldata: ['0xPOOL', '1', '0'] };
    // typed_data.message.calls must echo the honest submitted calls (#77 guard) — the
    // mocked toAvnuCall passthrough converts contractAddress/entrypoint to to/selector.
    const honestTypedData = { domain: 'snip9', message: { calls: [{ to: '0xUSDC', selector: 'approve', calldata: ['0xPOOL', '1', '0'] }] } };
    h.buildTransaction.mockResolvedValue({ type: 'invoke_and_apply_action', typed_data: honestTypedData, fee_action: { type: 'withdraw', recipient: '0xr', token: '0xUSDC', amount: '0x0' } });
    const account = fakeAccount();

    await submitProvenViaPaymaster(account, POOL_CALL, PROOF, {
      type: 'invoke_and_apply_action',
      userCalls: [approve],
    });

    // Build carries the user calls under `invoke.calls`.
    expect(h.buildTransaction.mock.calls[0]![0].transaction.invoke.calls[0].selector).toBe('approve');
    expect(account.signMessage).toHaveBeenCalledWith(honestTypedData);

    const execReq = h.executeTransaction.mock.calls[0]![0];
    expect(execReq.transaction.type).toBe('invoke_and_apply_action');
    expect(execReq.transaction.invoke.user_address).toBe('0xACCT');
    expect(execReq.transaction.invoke.typed_data).toEqual(honestTypedData);
    expect(execReq.transaction.invoke.signature).toEqual(['0x1a2b', '0x3c4d']);
    expect(execReq.transaction.apply_action.pool_address).toBe('0xPOOL');
    expect(execReq.transaction.apply_action.proof).toBe('0xPROOF');
  });

  it('throws if build returns no typed_data for an invoke leg', async () => {
    h.buildTransaction.mockResolvedValue({ type: 'invoke_and_apply_action', fee_action: { type: 'withdraw', recipient: '0xr', token: '0xUSDC', amount: '0x0' } });
    await expect(
      submitProvenViaPaymaster(fakeAccount(), POOL_CALL, PROOF, { type: 'invoke_and_apply_action', userCalls: [POOL_CALL] }),
    ).rejects.toThrow(/no typed_data/i);
  });
});

describe('paymasterBuildLeg / paymasterExecuteLeg (the build→inject→prove→execute split)', () => {
  it('paymasterBuildLeg returns the fee_action + typed_data + parameters (version 0x1) without executing', async () => {
    h.buildTransaction.mockResolvedValue({
      type: 'invoke_and_apply_action',
      typed_data: { domain: 'snip9' },
      fee_action: { type: 'withdraw', recipient: '0xFWD', token: '0xUSDC', amount: '0x3e8' },
    });
    const ctx = await paymasterBuildLeg(fakeAccount(), {
      type: 'invoke_and_apply_action',
      userCalls: [{ contractAddress: '0xUSDC', entrypoint: 'approve', calldata: ['0xPOOL', '1', '0'] }],
    });

    expect(ctx.type).toBe('invoke_and_apply_action');
    expect(ctx.parameters.version).toBe('0x1');
    expect(ctx.feeAction).toEqual({ type: 'withdraw', recipient: '0xFWD', token: '0xUSDC', amount: '0x3e8' });
    expect(ctx.typedData).toEqual({ domain: 'snip9' });
    expect(h.executeTransaction).not.toHaveBeenCalled();
  });

  it('paymasterExecuteLeg signs + forwards proof + pool_address and returns the hash', async () => {
    const ctx = await paymasterBuildLeg(fakeAccount(), {
      type: 'invoke_and_apply_action',
      userCalls: [{ contractAddress: '0xUSDC', entrypoint: 'approve', calldata: [] }],
    });
    // build (beforeEach) returns zero fee_action + no typed_data → set one for signing,
    // echoing the same (honest) calls ctx.userCalls carries (#77 guard).
    const honestTypedData = { domain: 'snip9', message: { calls: ctx.userCalls } };
    ctx.typedData = honestTypedData;
    const account = fakeAccount();
    const res = await paymasterExecuteLeg(account, POOL_CALL, PROOF, ctx);

    expect(account.signMessage).toHaveBeenCalledWith(honestTypedData);
    const execReq = h.executeTransaction.mock.calls[0]![0];
    expect(execReq.transaction.invoke.signature).toEqual(['0x1a2b', '0x3c4d']);
    expect(execReq.transaction.apply_action.pool_address).toBe('0xPOOL');
    expect(execReq.transaction.apply_action.proof).toBe('0xPROOF');
    expect(res.transaction_hash).toBe('0xHASH');
  });
});

describe('submitProvenCall routing', () => {
  it('routes to the AVNU paymaster when config.paymaster is set', async () => {
    const res = await submitProvenCall({} as never, fakeAccount(), POOL_CALL, PROOF);
    expect(h.executeTransaction).toHaveBeenCalledOnce();
    expect(res.transaction_hash).toBe('0xHASH');
  });

  it('does NOT touch the paymaster when config.paymaster is unset (manager fallback)', async () => {
    h.cfg.paymaster = undefined;
    await expect(submitProvenCall({} as never, fakeAccount(), POOL_CALL, PROOF)).rejects.toBeDefined();
    expect(h.buildTransaction).not.toHaveBeenCalled();
    expect(h.executeTransaction).not.toHaveBeenCalled();
  });
});
