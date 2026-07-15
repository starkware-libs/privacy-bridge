// Offline unit tests for the AVNU paymaster JSON-RPC client (avnuPaymaster.ts),
// pinned to AVNU's LIVE deployed schema (reverse-verified against the
// sepolia/mainnet endpoint's JSON-RPC validator, 2026-06-24). No network: fetch is
// mocked via an injected fetchImpl. We pin the wire contract: method names
// (paymaster_buildTransaction / paymaster_executeTransaction), the CALL shape
// ({to, selector, calldata}), version "0x1", proof/proof_facts forwarding, the
// pool_address on the executable apply_action, and error surfacing.

import { describe, expect, it, vi } from 'vitest';
import { hash } from 'starknet';

import {
  buildTransaction,
  decodeShortStringFelt,
  executeTransaction,
  extractRpcErrorDetail,
  toAvnuCall,
  type AvnuBuildParams,
  type AvnuExecuteParams,
} from './avnuPaymaster.js';

// Encode an ASCII string as a Cairo short-string felt (e.g. an assert reason).
const toFelt = (s: string): string =>
  `0x${[...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')}`;

// A fetch impl that captures the request and returns a JSON-RPC envelope.
function rpcFetch(result: unknown, status = 200) {
  const calls: { url: string; body: { method: string; params: unknown }; headers: unknown }[] = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string), headers: init.headers });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result }),
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const OPTS = (impl: typeof fetch, apiKey?: string) => ({
  endpoint: 'https://paymaster.test',
  apiKey,
  fetchImpl: impl,
});

describe('toAvnuCall', () => {
  it('maps a starknet Call to the live CALL {to, selector, calldata} with a hashed selector + 0x-hex calldata', () => {
    expect(
      toAvnuCall({ contractAddress: '0xpool', entrypoint: 'apply_actions', calldata: ['1', '2'] }),
    ).toEqual({
      to: '0xpool',
      selector: hash.getSelectorFromName('apply_actions'),
      // AVNU rejects decimal felts — calldata is normalised to 0x-hex.
      calldata: ['0x1', '0x2'],
    });
  });

  it('passes through an already-hashed 0x selector and normalises decimal/bigint calldata to 0x-hex', () => {
    const call = { contractAddress: '0xc', entrypoint: '0xabc', calldata: [255, 16n, '0xff'] as unknown as string[] };
    expect(toAvnuCall(call)).toEqual({ to: '0xc', selector: '0xabc', calldata: ['0xff', '0x10', '0xff'] });
  });
});

describe('buildTransaction', () => {
  it('POSTs paymaster_buildTransaction with named {transaction, parameters} (version 0x1) and returns the result', async () => {
    const { impl, calls } = rpcFetch({ type: 'apply_action', fee_action: { type: 'withdraw', recipient: '0xr', token: '0xt', amount: '0x0' } });
    const params: AvnuBuildParams = {
      transaction: { type: 'apply_action', apply_action: { pool_address: '0xpool' } },
      parameters: { version: '0x1', fee_mode: { mode: 'sponsored_private', pool_fee_token: '0xusdc' } },
    };
    const res = await buildTransaction(params, OPTS(impl));

    expect(res.fee_action?.amount).toBe('0x0');
    expect(calls[0]!.body.method).toBe('paymaster_buildTransaction');
    expect(calls[0]!.body.params).toEqual(params);
  });

  it('forwards the API key as x-paymaster-api-key when present', async () => {
    const { impl, calls } = rpcFetch({ type: 'apply_action' });
    await buildTransaction(
      { transaction: { type: 'apply_action', apply_action: { pool_address: '0x1' } }, parameters: { version: '0x1', fee_mode: { mode: 'sponsored' } } },
      OPTS(impl, 'KEY'),
    );
    expect((calls[0]!.headers as Record<string, string>)['x-paymaster-api-key']).toBe('KEY');
  });
});

describe('executeTransaction', () => {
  it('POSTs paymaster_executeTransaction with {transaction, parameters}, forwards proof/proof_facts + pool_address, returns the hash', async () => {
    const { impl, calls } = rpcFetch({ tracking_id: 'trk_1', transaction_hash: '0xhash' });
    const params: AvnuExecuteParams = {
      transaction: {
        type: 'apply_action',
        apply_action: {
          pool_address: '0xpool',
          apply_actions_call: { to: '0xpool', selector: '0xsel', calldata: ['9'] },
          proof: '0xPROOF',
          proof_facts: ['0xf1', '0xf2'],
        },
      },
      parameters: { version: '0x1', fee_mode: { mode: 'sponsored' } },
    };
    const res = await executeTransaction(params, OPTS(impl));

    expect(res.transaction_hash).toBe('0xhash');
    expect(res.tracking_id).toBe('trk_1');
    expect(calls[0]!.body.method).toBe('paymaster_executeTransaction');
    // execute takes BOTH transaction and parameters.
    expect(calls[0]!.body.params).toEqual(params);
  });
});

describe('#104 — rpc() fetch timeout', () => {
  it('rejects (does not hang) against a stalled endpoint once timeoutMs elapses', async () => {
    // A fetchImpl that never resolves on its own, but DOES respect the AbortSignal
    // (mirroring real fetch — an abort makes the pending promise reject).
    const neverResolvingFetch = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    }) as unknown as typeof fetch;

    await expect(
      buildTransaction(
        { transaction: { type: 'apply_action', apply_action: { pool_address: '0x1' } }, parameters: { version: '0x1', fee_mode: { mode: 'sponsored' } } },
        { endpoint: 'https://paymaster.test', fetchImpl: neverResolvingFetch, timeoutMs: 50 },
      ),
    ).rejects.toThrow();
  });

  it('passes an AbortSignal to fetchImpl (present regardless of outcome)', async () => {
    const { impl } = rpcFetch({ type: 'apply_action' });
    await buildTransaction(
      { transaction: { type: 'apply_action', apply_action: { pool_address: '0x1' } }, parameters: { version: '0x1', fee_mode: { mode: 'sponsored' } } },
      OPTS(impl),
    );
    const init = impl.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('error surfacing', () => {
  it('throws on a JSON-RPC error body (200 + error), including the data detail', async () => {
    const impl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: '',
      text: async () =>
        JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params', data: 'missing field `version`' } }),
    })) as unknown as typeof fetch;
    await expect(
      buildTransaction(
        { transaction: { type: 'apply_action', apply_action: { pool_address: '0x1' } }, parameters: { version: '0x1', fee_mode: { mode: 'sponsored' } } },
        OPTS(impl),
      ),
    ).rejects.toThrow(/Invalid params: missing field `version`/);
  });

  it('throws on a non-OK HTTP status', async () => {
    const impl = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      text: async () => 'boom',
    })) as unknown as typeof fetch;
    await expect(
      executeTransaction(
        {
          transaction: { type: 'apply_action', apply_action: { pool_address: '0x1', apply_actions_call: { to: '0x1', selector: '0x2', calldata: [] }, proof: '', proof_facts: [] } },
          parameters: { version: '0x1', fee_mode: { mode: 'sponsored' } },
        },
        OPTS(impl),
      ),
    ).rejects.toThrow(/500/);
  });

  it('decodes the on-chain revert reason out of a TRANSACTION_EXECUTION_ERROR data blob', async () => {
    // AVNU collapses on-chain reverts to a generic message but stashes the real
    // execution error (with the felt-encoded assert reason) in error.data. We must
    // surface the DECODED assert ('INSUFFICIENT_CLAIMABLE') — not just "code 156".
    const impl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: '',
      text: async () =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: {
            code: 156,
            message: 'An error occurred (TRANSACTION_EXECUTION_ERROR)',
            data: { execution_error: `Error in the called contract: ${toFelt('INSUFFICIENT_CLAIMABLE')} ('CLAIM' failed)` },
          },
        }),
    })) as unknown as typeof fetch;
    const err = await executeTransaction(
      {
        transaction: { type: 'apply_action', apply_action: { pool_address: '0x1', apply_actions_call: { to: '0x1', selector: '0x2', calldata: [] }, proof: '', proof_facts: [] } },
        parameters: { version: '0x1', fee_mode: { mode: 'sponsored' } },
      },
      OPTS(impl),
    ).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(err).toMatch(/code 156/);
    expect(err).toMatch(/INSUFFICIENT_CLAIMABLE/); // decoded from the felt in error.data
  });
});

describe('decodeShortStringFelt', () => {
  it('decodes a Cairo short-string felt (assert reason) to ASCII', () => {
    expect(decodeShortStringFelt(toFelt('CALLER_NOT_POOL'))).toBe('CALLER_NOT_POOL');
    expect(decodeShortStringFelt(toFelt('INSUFFICIENT_CLAIMABLE'))).toBe('INSUFFICIENT_CLAIMABLE');
  });
  it('returns undefined for addresses / hashes / non-printable felts', () => {
    expect(decodeShortStringFelt('0x' + 'ff'.repeat(32))).toBeUndefined(); // non-printable
    expect(decodeShortStringFelt('0x' + '11'.repeat(32))).toBeUndefined(); // 32 bytes > 31
    expect(decodeShortStringFelt('0x0')).toBeUndefined(); // all-zero
  });
  // #164: an INTERIOR 0x00 byte is NOT padding — it's a null in the middle of the
  // felt, which is not a valid Cairo short-string encoding. The old code treated
  // EVERY zero byte (leading AND interior) as skippable padding, so it silently
  // spliced the bytes around the null together and fabricated a clean-looking
  // string instead of failing closed. Only LEADING zero bytes are padding.
  it('fails closed (undefined) on an interior 0x00 byte instead of splicing around it', () => {
    // 'AB' + 0x00 + 'CD' — a null in the middle of the felt. Must NOT decode to
    // the fabricated 'ABCD'; the felt is not a valid short string.
    const withInteriorNull = `0x${toFelt('AB').slice(2)}00${toFelt('CD').slice(2)}`;
    expect(decodeShortStringFelt(withInteriorNull)).toBeUndefined();
  });
});

describe('extractRpcErrorDetail', () => {
  it('reads a string data directly', () => {
    expect(extractRpcErrorDetail('missing field `version`')).toBe('missing field `version`');
  });
  it('reads a nested execution_error and appends the decoded assert', () => {
    const out = extractRpcErrorDetail({ execution_error: `panic: ${toFelt('INSUFFICIENT_CLAIMABLE')}` });
    expect(out).toMatch(/panic:/);
    expect(out).toMatch(/\[decoded: INSUFFICIENT_CLAIMABLE\]/);
  });
  it('stringifies an object with no known revert field', () => {
    expect(extractRpcErrorDetail({ foo: 'bar' })).toBe('{"foo":"bar"}');
  });
  it('returns empty for null/undefined', () => {
    expect(extractRpcErrorDetail(null)).toBe('');
    expect(extractRpcErrorDetail(undefined)).toBe('');
  });
});
