// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// The client fetch budget must be NESTED outside the proxy/LB budget: Google's LB cuts
// a backend at 30s, so a 30s client abort races it and turns a definitive 502/504 into
// an unknown-status timeout on the submit leg.

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_RPC_TIMEOUT_MS,
  EXECUTE_RPC_TIMEOUT_MS,
  buildTransaction,
  executeTransaction,
  rpcTimeoutMs,
} from './avnuPaymaster.js';

const LB_BUDGET_MS = 30_000;

const BUILD_PARAMS = {
  transaction: { type: 'apply_action' as const, apply_action: { pool_address: '0x1' } },
  parameters: { version: '0x1', fee_mode: { mode: 'sponsored' as const } },
};

function capturingFetch(): { impl: typeof fetch; inits: RequestInit[] } {
  const inits: RequestInit[] = [];
  const impl = vi.fn(async (_url: string, init?: RequestInit) => {
    inits.push(init ?? {});
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tracking_id: 't', transaction_hash: '0x1' } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, inits };
}

describe('AVNU rpc() timeout budgets are nested outside the 30s LB cut', () => {
  it('defaults the build leg above the LB budget', () => {
    expect(DEFAULT_RPC_TIMEOUT_MS).toBeGreaterThan(LB_BUDGET_MS);
  });

  it('gives the execute (submit) leg the longest budget', () => {
    expect(EXECUTE_RPC_TIMEOUT_MS).toBeGreaterThan(DEFAULT_RPC_TIMEOUT_MS);
  });

  it('picks the execute budget for paymaster_executeTransaction only', () => {
    expect(rpcTimeoutMs('paymaster_executeTransaction')).toBe(EXECUTE_RPC_TIMEOUT_MS);
    expect(rpcTimeoutMs('paymaster_buildTransaction')).toBe(DEFAULT_RPC_TIMEOUT_MS);
  });

  it('lets an explicit timeoutMs win on both legs (tests inject tiny budgets)', () => {
    expect(rpcTimeoutMs('paymaster_executeTransaction', 50)).toBe(50);
    expect(rpcTimeoutMs('paymaster_buildTransaction', 50)).toBe(50);
  });

  it('still passes an AbortSignal on both legs', async () => {
    const { impl, inits } = capturingFetch();
    await buildTransaction(BUILD_PARAMS, { endpoint: 'https://paymaster.test', fetchImpl: impl });
    await executeTransaction(
      { ...BUILD_PARAMS, transaction: { ...BUILD_PARAMS.transaction } } as never,
      { endpoint: 'https://paymaster.test', fetchImpl: impl },
    );
    expect(inits).toHaveLength(2);
    for (const init of inits) expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
