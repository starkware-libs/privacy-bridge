// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Sign out, then sign straight back in without a reload, over WalletConnect (the phone
// path: no injected window.ethereum, WC is the only registered provider). Runs the REAL
// WalletProvider, discovery registry and WC singleton against the synthetic E2E WC
// provider. The one seam is relay latency: the old session's disconnect() resolves only
// when the test releases it, as a WC session delete waits on the relay.

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { WalletProvider } from './WalletProvider';
import { useWallet } from './useWallet';
import { resetProviderDiscovery } from './injectedProvider';
import { resetWalletConnectProvider, WALLETCONNECT_RDNS } from './getWalletConnectProvider';
import { E2E_TEST_ADDRESS } from './e2eTestProvider';
import type { EthereumProvider } from './signMessage';
import { initTestConfig } from '../../../vitest.setup';

type TestWcProvider = EthereumProvider & { disconnect(): Promise<void>; session?: unknown };

function renderWallet() {
  return renderHook(() => useWallet(), { wrapper: WalletProvider });
}
type Wallet = ReturnType<typeof renderWallet>['result'];

async function connectWalletConnect(result: Wallet) {
  await waitFor(() =>
    expect(result.current.providers.some((p) => p.rdns === WALLETCONNECT_RDNS)).toBe(true),
  );
  await act(async () => {
    await result.current.connect(WALLETCONNECT_RDNS);
  });
}

// Teardowns a failed test left held open, released before the next test's reset.
const heldTeardowns: Array<() => Promise<void>> = [];

// Hold the connected provider's session teardown open and count personal_sign requests
// sent to it once teardown began (the wallet has dropped the session; nothing answers).
function holdTeardown(provider: TestWcProvider) {
  const realDisconnect = provider.disconnect.bind(provider);
  const realRequest = provider.request.bind(provider);
  let release: () => Promise<void> = async () => {};
  let tearingDown = false;
  const signsToDeadSession = { count: 0 };
  provider.disconnect = () =>
    new Promise<void>((resolve) => {
      tearingDown = true;
      release = async () => {
        await realDisconnect();
        resolve();
      };
      heldTeardowns.push(release);
    });
  provider.request = (args) => {
    if (tearingDown && args.method === 'personal_sign') {
      signsToDeadSession.count += 1;
      return new Promise(() => {});
    }
    return realRequest(args);
  };
  return { finishTeardown: () => release(), signsToDeadSession };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  localStorage.clear();
  resetProviderDiscovery();
  initTestConfig({ E2E_WALLET: '1' });
});

afterEach(async () => {
  cleanup();
  await Promise.all(heldTeardowns.splice(0).map((release) => release()));
  await resetWalletConnectProvider();
  resetProviderDiscovery();
  localStorage.clear();
});

describe('WalletProvider — WalletConnect sign-out, then sign back in without a reload', () => {
  it('does not offer Resume for the session sign-out is tearing down', async () => {
    const { result } = renderWallet();
    await connectWalletConnect(result);
    expect(result.current.address).toBe(E2E_TEST_ADDRESS);
    const { finishTeardown } = holdTeardown(result.current.getProvider() as TestWcProvider);

    act(() => result.current.disconnect());
    await settle();

    expect(result.current.address).toBeNull();
    expect(result.current.canResume).toBe(false);
    expect(result.current.getProvider()).toBeUndefined();

    await act(async () => {
      await finishTeardown();
    });
    await settle();
    expect(result.current.canResume).toBe(false);
  });

  it('sends no identity signature to the torn-down session', async () => {
    const { result } = renderWallet();
    await connectWalletConnect(result);
    const { finishTeardown, signsToDeadSession } = holdTeardown(
      result.current.getProvider() as TestWcProvider,
    );

    act(() => result.current.disconnect());
    await settle();
    // What a "Resume session" button does while canResume is true.
    act(() => {
      if (result.current.canResume) result.current.resumeSession();
    });
    if (result.current.address) {
      void result.current.signMessage('derive-identity').catch(() => {});
    }
    await act(async () => {
      await finishTeardown();
    });
    await settle();

    expect(signsToDeadSession.count).toBe(0);
  });

  it('lists WalletConnect again after teardown, so signing back in needs no reload', async () => {
    const { result } = renderWallet();
    await connectWalletConnect(result);
    const oldProvider = result.current.getProvider() as TestWcProvider;
    const { finishTeardown, signsToDeadSession } = holdTeardown(oldProvider);

    act(() => result.current.disconnect());
    await settle();
    await act(async () => {
      await finishTeardown();
    });

    await connectWalletConnect(result);
    expect(result.current.address).toBe(E2E_TEST_ADDRESS);
    const fresh = result.current.getProvider();
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(oldProvider);
    await expect(result.current.signMessage('derive-identity')).resolves.toMatch(/^0x[0-9a-f]+$/i);
    expect(signsToDeadSession.count).toBe(0);
  });

  it('same address: logout → login → logout → login each sign over the live session', async () => {
    const { result } = renderWallet();
    await connectWalletConnect(result);

    for (let round = 0; round < 2; round += 1) {
      act(() => result.current.disconnect());
      await settle();
      expect(result.current.address).toBeNull();
      expect(result.current.canResume).toBe(false);

      await connectWalletConnect(result);
      expect(result.current.address).toBe(E2E_TEST_ADDRESS);
      expect(result.current.isConnected).toBe(true);
      await expect(result.current.signMessage(`derive-${round}`)).resolves.toMatch(
        /^0x[0-9a-f]+$/i,
      );
    }
  });

  it('A → B: signing back in as a different WC account exposes and signs as B only', async () => {
    const { result } = renderWallet();
    await connectWalletConnect(result);
    expect(result.current.address).toBe(E2E_TEST_ADDRESS);

    act(() => result.current.disconnect());
    await settle();
    await waitFor(() =>
      expect(result.current.providers.some((p) => p.rdns === WALLETCONNECT_RDNS)).toBe(true),
    );

    // The phone now approves the new pairing with a different account (throwaway key).
    const accountB = privateKeyToAccount(generatePrivateKey());
    const fresh = result.current.getProvider() as TestWcProvider;
    const realRequest = fresh.request.bind(fresh);
    fresh.request = async (args) => {
      if (!fresh.session) return realRequest(args);
      if (args.method === 'eth_requestAccounts' || args.method === 'eth_accounts') {
        return [accountB.address];
      }
      if (args.method === 'personal_sign') {
        return accountB.signMessage({ message: { raw: args.params?.[0] as `0x${string}` } });
      }
      return realRequest(args);
    };

    await connectWalletConnect(result);
    expect(result.current.address).toBe(accountB.address);
    await expect(result.current.signMessage('derive-identity')).resolves.toMatch(/^0x[0-9a-f]+$/i);
  });
});
