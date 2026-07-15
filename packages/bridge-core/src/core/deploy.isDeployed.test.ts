import { describe, expect, it, vi, beforeEach } from 'vitest';
import { RpcError } from 'starknet';

// Fake getClassHashAt behind getRpcProvider so the deployment checks hit a
// controllable RPC. isDeployed / isDeployedOnL2 call getRpcProvider().getClassHashAt.
const getClassHashAt = vi.fn();
vi.mock('./provider', () => ({
  getRpcProvider: () => ({ getClassHashAt }),
  getPaymasterRpc: () => undefined,
  makeAccount: vi.fn(),
}));

import { isDeployed, isDeployedOnL2, isContractNotFoundError } from './deploy';

// The exact error starknet's getClassHashAt throws for an address with no class
// deployed: JSON-RPC error CONTRACT_NOT_FOUND (code 20), wrapped in RpcError.
const contractNotFound = () =>
  new RpcError(
    { code: 20, message: 'Contract not found', data: undefined },
    'starknet_getClassHashAt',
    [],
  );

// A transient RPC / transport failure that is NOT "the contract is absent": a reset
// upstream (ECONNRESET → the dev proxy's 500), a timeout, a rate-limit, etc. This is
// the condition that exposed the bug — the testnet node was resetting connections.
const transientRpcError = () => new Error('read ECONNRESET');
const executionError = () =>
  new RpcError(
    { code: 41, message: 'Transaction execution error', data: undefined },
    'starknet_getClassHashAt',
    [],
  );

beforeEach(() => {
  getClassHashAt.mockReset();
});

// The pure classifier is the load-bearing logic: ONLY CONTRACT_NOT_FOUND (20) means
// "not deployed". Everything else is an ambiguous read that must NOT be reported as
// not-deployed (else a flaky RPC triggers a redundant deploy that reverts "already
// deployed" — paymaster code 156 / node code 41).
describe('isContractNotFoundError', () => {
  it('is true for RpcError CONTRACT_NOT_FOUND (code 20)', () => {
    expect(isContractNotFoundError(contractNotFound())).toBe(true);
  });

  it('is false for a transient transport error (ECONNRESET / 500)', () => {
    expect(isContractNotFoundError(transientRpcError())).toBe(false);
  });

  it('is false for an unrelated RPC error (execution error, code 41)', () => {
    expect(isContractNotFoundError(executionError())).toBe(false);
  });

  it('is false for undefined / non-error values', () => {
    expect(isContractNotFoundError(undefined)).toBe(false);
    expect(isContractNotFoundError(null)).toBe(false);
    expect(isContractNotFoundError('boom')).toBe(false);
  });

  // Fallback path: a non-RpcError wrapper that still carries the RPC code / message
  // (some transport/batch layers re-throw a plain Error). Still classified correctly.
  it('is true for a plain error carrying code 20 or the canonical message', () => {
    expect(isContractNotFoundError({ code: 20 })).toBe(true);
    expect(isContractNotFoundError({ baseError: { code: 20 } })).toBe(true);
    expect(isContractNotFoundError(new Error('20: Contract not found'))).toBe(true);
  });
});

describe('isDeployed', () => {
  it('returns true when the class read succeeds', async () => {
    getClassHashAt.mockResolvedValue('0xclass');
    await expect(isDeployed('0xabc')).resolves.toBe(true);
  });

  it('returns false ONLY for CONTRACT_NOT_FOUND', async () => {
    getClassHashAt.mockRejectedValue(contractNotFound());
    await expect(isDeployed('0xabc')).resolves.toBe(false);
  });

  // THE REGRESSION: a transient RPC failure must NOT be silently reported as
  // "not deployed". The old blanket `catch { return false }` returned false here,
  // making ensureAccountDeployed fire a redundant deploy that reverted on-chain
  // "contract already deployed". The fix re-throws so the caller fails loudly.
  it('RE-THROWS on a transient RPC error instead of returning false', async () => {
    getClassHashAt.mockRejectedValue(transientRpcError());
    await expect(isDeployed('0xabc')).rejects.toThrow(/ECONNRESET/);
  });
});

describe('isDeployedOnL2', () => {
  it('returns false ONLY for CONTRACT_NOT_FOUND', async () => {
    getClassHashAt.mockRejectedValue(contractNotFound());
    await expect(isDeployedOnL2('0xabc')).resolves.toBe(false);
  });

  it('RE-THROWS on a transient RPC error instead of returning false', async () => {
    getClassHashAt.mockRejectedValue(transientRpcError());
    await expect(isDeployedOnL2('0xabc')).rejects.toThrow(/ECONNRESET/);
  });
});
