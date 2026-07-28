// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isWalletUnavailableError,
  WALLET_UNAVAILABLE_RE,
  withSignTimeout,
} from './walletErrors';

describe('isWalletUnavailableError', () => {
  it('matches the MetaMask MV3 dead-port strings', () => {
    expect(isWalletUnavailableError(new Error('Extension context invalidated.'))).toBe(true);
    expect(isWalletUnavailableError(new Error('[ChromeTransport] chromePort disconnected'))).toBe(
      true,
    );
    expect(isWalletUnavailableError(new Error('Premature close'))).toBe(true);
    expect(
      isWalletUnavailableError(new Error('MetaMask: Provider is disconnected from all chains.')),
    ).toBe(true);
  });

  it('matches the sign-timeout sentinel (so a hang maps to the same copy)', () => {
    expect(WALLET_UNAVAILABLE_RE.test('Signature request timed out')).toBe(true);
    expect(isWalletUnavailableError(new Error('Signature request timed out'))).toBe(true);
  });

  it('matches EIP-1193 disconnect codes on the error or its cause', () => {
    expect(isWalletUnavailableError({ code: 4900, message: 'Disconnected' })).toBe(true);
    expect(isWalletUnavailableError({ code: 4901, message: 'Chain disconnected' })).toBe(true);
    expect(isWalletUnavailableError({ cause: { code: 4900 }, message: 'wrapped' })).toBe(true);
  });

  it('does NOT match a user rejection or an ordinary on-chain error', () => {
    expect(isWalletUnavailableError(Object.assign(new Error('User rejected'), { code: 4001 }))).toBe(
      false,
    );
    expect(isWalletUnavailableError(new Error('execution reverted: NON_ZERO_VALUE'))).toBe(false);
  });
});

describe('withSignTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the value when the operation resolves in time', async () => {
    const sig = `0x${'ab'.repeat(65)}`;
    await expect(withSignTimeout(async () => sig)).resolves.toBe(sig);
  });

  it('rejects with the timeout sentinel when the operation never resolves (zombie port)', async () => {
    vi.useFakeTimers();
    const p = withSignTimeout(() => new Promise<string>(() => {}), 1_000);
    const assertion = expect(p).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it('surfaces the operation error verbatim when it rejects before the timeout', async () => {
    await expect(
      withSignTimeout(async () => {
        throw new Error('Extension context invalidated.');
      }),
    ).rejects.toThrow(/context invalidated/i);
  });
});
