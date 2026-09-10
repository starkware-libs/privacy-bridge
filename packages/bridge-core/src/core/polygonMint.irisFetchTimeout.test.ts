// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// The Iris attestation GET had no per-request timeout: pollIris only checks its
// 30-minute deadline AFTER the awaited fetch resolves, so a blackholed connection
// stalls the CCTP mint forever. Each request now carries its own AbortSignal, and the
// resulting TimeoutError must ride the existing transient/backoff path.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from './config.js';
import { isTransientError } from './errors.js';
import { IRIS_FETCH_TIMEOUT_MS, waitForAttestation } from './polygonMint.js';

const BURN_TX = '0xabc123';
const RECIPIENT = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

function buildCctpMessage(): `0x${string}` {
  const u32 = (n: number) => n.toString(16).padStart(8, '0');
  const recipient40 = RECIPIENT.replace(/^0x/, '').toLowerCase().padStart(40, '0');
  const header =
    u32(1) +
    u32(config.cctp.starknetDomain) +
    u32(config.polygon.domain) +
    '00'.repeat(32 * 4) +
    u32(1000) +
    u32(1000);
  const body =
    u32(1) + '00'.repeat(32) + '00'.repeat(12) + recipient40 + '00'.repeat(32) + '00'.repeat(32);
  return `0x${header}${body}` as `0x${string}`;
}

const MESSAGE = buildCctpMessage();
const ATTESTATION = `0x${'bb'.repeat(65)}` as `0x${string}`;

function okRes(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Iris poll — per-request abort budget', () => {
  it('bounds every Iris GET with an AbortSignal', async () => {
    fetchMock.mockResolvedValue(
      okRes({ messages: [{ status: 'complete', message: MESSAGE, attestation: ATTESTATION }] }),
    );

    const promise = waitForAttestation(BURN_TX, { intervalMs: 10, backoffBaseMs: 1 });
    await vi.runAllTimersAsync();
    await promise;

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('defaults the per-request budget to IRIS_FETCH_TIMEOUT_MS, far below the poll deadline', async () => {
    expect(IRIS_FETCH_TIMEOUT_MS).toBeLessThan(30 * 60_000);
    const spy = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockResolvedValue(
      okRes({ messages: [{ status: 'complete', message: MESSAGE, attestation: ATTESTATION }] }),
    );

    const promise = waitForAttestation(BURN_TX, { intervalMs: 10, backoffBaseMs: 1 });
    await vi.runAllTimersAsync();
    await promise;

    expect(spy).toHaveBeenCalledWith(IRIS_FETCH_TIMEOUT_MS);
    spy.mockRestore();
  });

  it('honours an injected fetchTimeoutMs', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockResolvedValue(
      okRes({ messages: [{ status: 'complete', message: MESSAGE, attestation: ATTESTATION }] }),
    );

    const promise = waitForAttestation(BURN_TX, {
      intervalMs: 10,
      backoffBaseMs: 1,
      fetchTimeoutMs: 1_234,
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(spy).toHaveBeenCalledWith(1_234);
    spy.mockRestore();
  });

  it('treats the abort rejection as transient and keeps polling', async () => {
    // The shape the browser rejects an AbortSignal.timeout()-bounded fetch with; #95
    // classifies it transient, which is what makes the backoff path below correct.
    const timeout = new DOMException('signal timed out', 'TimeoutError');
    expect(isTransientError(timeout)).toBe(true);

    fetchMock
      .mockRejectedValueOnce(timeout)
      .mockResolvedValue(
        okRes({ messages: [{ status: 'complete', message: MESSAGE, attestation: ATTESTATION }] }),
      );

    const promise = waitForAttestation(BURN_TX, { intervalMs: 10, backoffBaseMs: 1 });
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual({ message: MESSAGE, attestation: ATTESTATION });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
