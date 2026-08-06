// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAddressEqual } from 'viem';
import {
  E2E_TEST_ADDRESS,
  createE2ETestProvider,
  isE2EWalletEnabled,
} from './e2eTestProvider';
import {
  getWalletConnectProvider,
  resetWalletConnectProvider,
} from './getWalletConnectProvider';
import { signMessage } from './signMessage';
import { initTestConfig } from '../../../vitest.setup';

// The E2E seam is DEV/TEST-ONLY and gated by the injected config.e2eWallet flag
// (Slice X — no import.meta.env). These tests prove:
//   1. With the flag ON, getWalletConnectProvider() returns the synthetic provider
//      and the connect→personal_sign path resolves (signer-binding guard passes).
//   2. With the flag OFF, the seam is absent — getWalletConnectProvider() falls
//      through to the real WC path (null without a projectId).
// getWalletConnectProvider memoises a singleton, so each seam-wiring case resets it
// via resetWalletConnectProvider() and (re)injects config via initTestConfig.

afterEach(async () => {
  await resetWalletConnectProvider();
});

describe('e2eTestProvider — synthetic provider', () => {
  it('createE2ETestProvider gates request() until connect() (preserves explicit-connect)', async () => {
    const provider = createE2ETestProvider();
    expect(provider.session).toBeUndefined();
    // Pre-session request() must throw — the load-bearing gate the WalletProvider
    // relies on (identical to the real WC provider).
    await expect(provider.request({ method: 'eth_accounts' })).rejects.toThrow(
      /connect\(\) before request\(\)/,
    );

    await provider.connect();
    expect(provider.session).toBeDefined();
    const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
    expect(isAddressEqual(accounts[0] as `0x${string}`, E2E_TEST_ADDRESS)).toBe(true);
  });

  it('connect→personal_sign resolves a signature that recovers to the test account', async () => {
    const provider = createE2ETestProvider();
    await provider.connect();
    // signMessage runs the recover-and-compare signer-binding guard; it only
    // resolves if personal_sign signed the exact bytes with the test key.
    const sig = await signMessage(provider, E2E_TEST_ADDRESS, 'derive-seed');
    expect(sig).toMatch(/^0x[0-9a-f]+$/i);
  });

  it('reports the testnet (Amoy) chain id', async () => {
    const provider = createE2ETestProvider();
    await provider.connect();
    expect(await provider.request({ method: 'eth_chainId' })).toBe('0x13882');
  });
});

describe('isE2EWalletEnabled — flag gating', () => {
  it('is FALSE when config.e2eWallet is unset/empty/false/0', () => {
    initTestConfig({ E2E_WALLET: '' });
    expect(isE2EWalletEnabled()).toBe(false);
    initTestConfig({ E2E_WALLET: 'false' });
    expect(isE2EWalletEnabled()).toBe(false);
    initTestConfig({ E2E_WALLET: '0' });
    expect(isE2EWalletEnabled()).toBe(false);
  });

  it('is TRUE when config.e2eWallet is truthy', () => {
    initTestConfig({ E2E_WALLET: '1' });
    expect(isE2EWalletEnabled()).toBe(true);
  });
});

describe('getWalletConnectProvider — E2E seam wiring', () => {
  beforeEach(async () => {
    await resetWalletConnectProvider();
  });

  it('flag ON: returns the synthetic provider; connect→sign works', async () => {
    initTestConfig({ E2E_WALLET: '1' });
    const provider = await getWalletConnectProvider();
    expect(provider).not.toBeNull();
    expect(provider!.isWalletConnect).toBe(true);
    await provider!.connect();
    const sig = await signMessage(provider!, E2E_TEST_ADDRESS, 'hello');
    expect(sig).toMatch(/^0x[0-9a-f]+$/i);
  });

  it('flag OFF: seam absent — falls through to real WC (null without projectId)', async () => {
    // e2eWallet unset AND no projectId in the fixture → real init returns null.
    initTestConfig({ E2E_WALLET: '' });
    const provider = await getWalletConnectProvider();
    expect(provider).toBeNull();
  });
});
