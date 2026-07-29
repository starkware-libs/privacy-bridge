import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WalletProvider } from './WalletProvider';
import { useWallet } from './useWallet';
import { resetProviderDiscovery } from './injectedProvider';

// WM-1: closeLoginModal / disconnect must ABORT an in-flight connect(). A late
// success (the user approved AFTER closing the modal) must NOT silently enter the
// session, and a late rejection must NOT write an error onto a closed modal.
//
// RED (pre-guard): connect() had no attempt token, so a requestAccounts that
// resolved after close flipped sessionEntered=true behind the closed modal.
// GREEN (with connectAttemptRef): the late resolve is dropped; isConnected stays
// false. Exercised against the real WalletProvider with a controllable injected
// window.ethereum whose eth_requestAccounts we resolve manually.

vi.mock('./getWalletConnectProvider', () => ({
  registerWalletConnect: vi.fn(async () => {}),
  disconnectWalletConnect: vi.fn(async () => {}),
  resetWalletConnectProvider: vi.fn(async () => {}),
  getWalletConnectProvider: vi.fn(async () => undefined),
}));
vi.mock('./device-store', () => ({
  clearDeviceIdentity: vi.fn(),
}));

let resolveRequestAccounts: ((accounts: string[]) => void) | null = null;

function controllableGlobal() {
  const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
  return {
    isMetaMask: true,
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_requestAccounts') {
        return new Promise<string[]>((resolve) => {
          resolveRequestAccounts = resolve;
        });
      }
      if (method === 'eth_accounts') return [];
      if (method === 'eth_chainId') return '0x89';
      return null;
    }),
    on: (event: string, handler: (...a: unknown[]) => void) => {
      (handlers[event] ??= []).push(handler);
    },
    removeListener: () => {},
  };
}

beforeEach(() => {
  // The abandoned connect() must not leave a recorded session behind (session-store.ts
  // is unmocked here), and no leaked record may restore one.
  localStorage.clear();
  resetProviderDiscovery();
  resolveRequestAccounts = null;
});
afterEach(() => {
  // Unmount before clearing: no RTL auto-cleanup is configured in this repo, so a
  // provider left mounted keeps its effects alive into the next test.
  cleanup();
  localStorage.clear();
  resetProviderDiscovery();
  delete (window as unknown as { ethereum?: unknown }).ethereum;
  vi.clearAllMocks();
});

describe('WM-1: closeLoginModal aborts an in-flight connect', () => {
  it('a late success after close does NOT enter the session', async () => {
    (window as unknown as { ethereum: unknown }).ethereum = controllableGlobal();

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });

    // Start connect(); requestAccounts hangs on resolveRequestAccounts.
    let connectPromise: Promise<void>;
    act(() => {
      connectPromise = result.current.connect();
    });
    await waitFor(() => expect(resolveRequestAccounts).not.toBeNull());

    // User closes the modal mid-connect (bumps the attempt token).
    act(() => {
      result.current.closeLoginModal();
    });

    // Late success: requestAccounts resolves AFTER the modal was closed.
    await act(async () => {
      resolveRequestAccounts!(['0x' + 'a'.repeat(40)]);
      await connectPromise;
    });

    // The session did NOT silently enter behind the closed modal.
    expect(result.current.isConnected).toBe(false);
    expect(result.current.address).toBeNull();
  });
});
