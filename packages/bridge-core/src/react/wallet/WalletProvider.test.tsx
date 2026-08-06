// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { WalletProvider } from './WalletProvider';
import { useWallet } from './useWallet';
import { signMessage, type EthereumProvider } from './signMessage';
import { resetProviderDiscovery } from './injectedProvider';
import { PMP_STORAGE_KEYS } from './device-store';

// Throwaway test key (NOT a real seed). signMessage verifies the recovered signer
// against the connected account, so a provider that actually SIGNS must (a) report
// this key's address from eth_accounts/eth_requestAccounts and (b) return a
// personal_sign signature that recovers to it.
const SIGNER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const SIGNER_ACCT = privateKeyToAccount(SIGNER_PK);
const SIGNER_ADDR = SIGNER_ACCT.address;
// The WC mock reports + signs as the throwaway signer so signer-verification
// passes for the WC personal_sign test (WC_ADDR == the signer's address).
const WC_ADDR = SIGNER_ADDR;

// ---------------------------------------------------------------------------
// WalletConnect mock — hoisted so the vi.mock factory below can reference it
// without hoisting issues (vitest lifts vi.mock calls above imports, so any
// closure variables they reference must also be hoisted via vi.hoisted).
// ---------------------------------------------------------------------------

// Mutable WC mock state, reset between tests via resetWcMock(). `signRaw` is set
// after the viem import below so the hoisted personal_sign handler can return a
// signature that recovers to WC_ADDR (signer-verification requires this).
const wcState = vi.hoisted(() => ({
  session: undefined as unknown,
  calls: [] as string[],
  signRaw: undefined as undefined | ((hex: `0x${string}`) => Promise<`0x${string}`>),
}));
// Wire the lazy signer the hoisted wcMock.request reads (it can't reference the
// post-import SIGNER_ACCT at hoist time, so we assign it here, after import).
wcState.signRaw = (hex: `0x${string}`) => SIGNER_ACCT.signMessage({ message: { raw: hex } });

// The mock EIP-1193 + WC-extras provider. request() throws before a session
// exists (the load-bearing behaviour the WalletProvider gates rely on).
const wcMock = vi.hoisted(() => {
  // Handler map exposed on the object so resetWcMock() can clear it and __emit
  // can dispatch events.
  const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
  return {
    isWalletConnect: true as const,
    handlers,
    // connect() sets a truthy session + records the call.
    connect: vi.fn(async () => {
      wcState.calls.push('connect');
      wcState.session = {};
    }),
    disconnect: vi.fn(async () => {
      wcState.session = undefined;
    }),
    request: vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (!wcState.session) {
        throw new Error('Please call connect() before request()');
      }
      wcState.calls.push(`request:${method}`);
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
        return [WC_ADDR];
      }
      if (method === 'eth_chainId') return '0x89'; // Polygon mainnet
      if (method === 'personal_sign') {
        return wcState.signRaw ? wcState.signRaw(params?.[0] as `0x${string}`) : '0xsig:wc';
      }
      return null;
    }),
    on: (event: string, handler: (...a: unknown[]) => void) => {
      (handlers[event] ??= []).push(handler);
    },
    removeListener: (event: string, handler: (...a: unknown[]) => void) => {
      const list = handlers[event];
      if (list) {
        const idx = list.indexOf(handler);
        if (idx !== -1) list.splice(idx, 1);
      }
    },
    // Dispatch an event to all registered handlers.
    __emit: (event: string, ...args: unknown[]) => {
      for (const h of handlers[event] ?? []) h(...args);
    },
    // Expose session as a property so the session-less gate can read it.
    get session() {
      return wcState.session;
    },
  };
});

// vi.mock is hoisted to the top of the module by vitest. The factory returns the
// exports getWalletConnectProvider.ts defines:
//   - getWalletConnectProvider: returns the mock.
//   - registerWalletConnect: registers the mock into the SHARED discovery
//     registry as the sole 'walletconnect' entry — the coexistence seam. With no
//     window.ethereum and nothing selected, getEthereumProvider() then resolves to
//     this sole registered provider (the "bare connect() → sole WC entry" path).
//   - resetWalletConnectProvider: a spy (disconnect() calls it — tests assert it).
//   - disconnectWalletConnect: a spy (resetWalletConnectProvider wraps it in prod).
// The factory pulls the REAL injectedProvider via importActual so the WC mock is
// registered into the same registry the provider resolves through.
vi.mock('./getWalletConnectProvider', async () => {
  const injected = await vi.importActual<typeof import('./injectedProvider')>('./injectedProvider');
  return {
    getWalletConnectProvider: vi.fn(async () => wcMock),
    registerWalletConnect: vi.fn(async () => {
      injected.registerProvider({
        info: { uuid: 'walletconnect', name: 'WalletConnect', rdns: 'walletconnect', icon: 'data:,wc' },
        provider: wcMock as unknown as EthereumProvider,
      });
    }),
    disconnectWalletConnect: vi.fn(async () => {}),
    resetWalletConnectProvider: vi.fn(async () => {}),
  };
});

function resetWcMock() {
  wcState.session = undefined;
  wcState.calls = [];
  wcMock.connect.mockClear();
  wcMock.disconnect.mockClear();
  wcMock.request.mockClear();
  for (const key of Object.keys(wcMock.handlers)) {
    delete wcMock.handlers[key];
  }
}

beforeEach(() => {
  localStorage.clear();
  resetProviderDiscovery();
  resetWcMock();
});

afterEach(() => {
  localStorage.clear();
  resetProviderDiscovery();
  resetWcMock();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// CONNECT GATE — the dual-gate (authorizedAddress vs sessionEntered) holds. In
// the WC-only world a "returning user" is one whose WC session was rehydrated on
// mount, so canResume is driven by the silent eth_accounts read off a truthy
// session (we seed wcState.session before mount to simulate that).
// ---------------------------------------------------------------------------
describe('WalletProvider — connect gate', () => {
  it('does NOT expose the address from a silently-rehydrated WC session on mount', async () => {
    // A returning user whose WC session auto-restored from a previous load.
    wcState.session = { topic: 'restored' };

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });

    // The silent eth_accounts read resolves async; once it does, the app must
    // STILL be signed-out — no address exposed — but it must offer Resume.
    await waitFor(() => expect(result.current.canResume).toBe(true));
    expect(result.current.address).toBeNull();
    expect(result.current.isConnected).toBe(false);
  });

  it('reveals the address only after an explicit Resume session', async () => {
    wcState.session = { topic: 'restored' };
    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });

    await waitFor(() => expect(result.current.canResume).toBe(true));
    expect(result.current.address).toBeNull();

    act(() => {
      result.current.resumeSession();
    });

    // The affirmative action enters the session — NOW the connected/private UI is
    // allowed (address is non-null).
    expect(result.current.address).toBe(WC_ADDR);
    expect(result.current.isConnected).toBe(true);
    expect(result.current.canResume).toBe(false);
  });

  it('reveals the address after an explicit connect()', async () => {
    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });

    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.address).toBe(WC_ADDR);
    expect(result.current.isConnected).toBe(true);
  });

  it('offers neither a session nor resume when no WC session is rehydrated', async () => {
    // session-less on mount: the silent read is skipped (WC throws before connect).
    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });

    // Let the mount effect resolve the (session-less) provider.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.address).toBeNull();
    expect(result.current.canResume).toBe(false);
    expect(result.current.isConnected).toBe(false);
    // The session-less guard must have suppressed the silent eth_accounts read.
    expect(wcMock.request).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DISCONNECT / FORGET DEVICE
// ---------------------------------------------------------------------------
describe('WalletProvider — disconnect / forget device', () => {
  it('clears the persisted pmp.* keys and tears down the WC session', async () => {
    // Seed every persisted pmp.* key the device may hold.
    localStorage.setItem('pmp.identity', JSON.stringify({ [WC_ADDR]: { snAddress: '0x9' } }));
    localStorage.setItem('pmp.bids', JSON.stringify({ [WC_ADDR]: [] }));
    localStorage.setItem('pmp.bidIndex', JSON.stringify({ [WC_ADDR]: 3 }));
    localStorage.setItem('pmp.inflightBurn', JSON.stringify({ [WC_ADDR]: {} }));
    localStorage.setItem('pmp.inflightDeposit', JSON.stringify({ [WC_ADDR]: {} }));
    // A non-pmp key must survive (we only own the pmp namespace).
    localStorage.setItem('unrelated.key', 'keep-me');

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    // Connect first so there is a live session to tear down.
    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.isConnected).toBe(true);

    act(() => {
      result.current.disconnect();
    });

    for (const key of PMP_STORAGE_KEYS) {
      expect(localStorage.getItem(key)).toBeNull();
    }
    expect(localStorage.getItem('unrelated.key')).toBe('keep-me');
    // The session is fully ended.
    expect(result.current.address).toBeNull();
    expect(result.current.isConnected).toBe(false);
    expect(result.current.canResume).toBe(false);

    // resetWalletConnectProvider spy must have been called: disconnect() now RESETS
    // the WC singleton (tears down the session AND drops the memoized instance) so a
    // reconnect after a runtime network switch rebuilds the rpcMap from the active
    // config (Bugbot MEDIUM "WC config stale after switch").
    const { resetWalletConnectProvider } = await import('./getWalletConnectProvider');
    expect(resetWalletConnectProvider).toHaveBeenCalled();

    // No wallet-selection key written to localStorage.
    for (const key of Object.keys(localStorage)) {
      expect(key).not.toMatch(/walletconnect|selectedRdns|lastWallet/i);
    }
  });
});

// ---------------------------------------------------------------------------
// WALLETCONNECT — session lifecycle, WM-1 guard, accountsChanged/chainChanged,
// user-cancel mapping, session-rehydrate-on-mount.
// ---------------------------------------------------------------------------
describe('WalletProvider — WalletConnect', () => {
  // Test 1: silent mount does NOT call request() when session-less WC present.
  it('silent mount: no request() issued when the WC provider is session-less', async () => {
    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.address).toBeNull();
    expect(result.current.canResume).toBe(false);
    expect(result.current.isConnected).toBe(false);
    // Critical: the session-less guard must have suppressed ALL request() calls.
    expect(wcMock.request).not.toHaveBeenCalled();
  });

  // Test 2: connect() calls WC connect() BEFORE any request().
  it('connect() calls WC connect() before any request(), then resolves address', async () => {
    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });

    await act(async () => {
      await result.current.connect();
    });

    // connect() must have been called exactly once.
    expect(wcMock.connect).toHaveBeenCalledTimes(1);

    // The call-order recording proves ordering: 'connect' precedes the first request.
    const connectIdx = wcState.calls.indexOf('connect');
    const firstRequestIdx = wcState.calls.findIndex((c) => c.startsWith('request:'));
    expect(connectIdx).toBeGreaterThanOrEqual(0);
    expect(firstRequestIdx).toBeGreaterThan(connectIdx);

    expect(result.current.address).toBe(WC_ADDR);
    expect(result.current.isConnected).toBe(true);
  });

  // Test 3: personal_sign routes through WC and returns a recoverable signature.
  it('personal_sign routes through the WC provider and returns the WC signature', async () => {
    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });

    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.isConnected).toBe(true);

    let sig: string | undefined;
    await act(async () => {
      sig = await result.current.signMessage('hello');
    });

    // A recoverable signature came back (signer-verification passed) from WC.
    expect(sig).toMatch(/^0x[0-9a-f]+$/i);
    expect(wcMock.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'personal_sign' }),
    );
  });

  // Test 4: getProvider() exposes the live WC provider once connected.
  it('getProvider() returns the live WC provider after connect()', async () => {
    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.getProvider()).toBe(wcMock as unknown as EthereumProvider);
  });

  // Test 5: session-rehydrate-on-mount — a pre-existing WC session yields canResume
  // but does NOT auto-enter (the dual-gate invariant).
  it('session rehydrate on mount: canResume but no auto-enter; explicit connect enters', async () => {
    // Simulate WC-SDK auto-restored session from a previous page load.
    wcState.session = { topic: 'restored-session' };

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });

    // The silent eth_accounts read resolves the address → canResume true, but
    // sessionEntered stays false.
    await waitFor(() => expect(result.current.canResume).toBe(true));
    // The silent read DID run (truthy session is not session-less).
    expect(wcMock.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_accounts' }),
    );

    // The dual-gate invariant: address MUST be null until an explicit action.
    expect(result.current.address).toBeNull();
    expect(result.current.isConnected).toBe(false);

    // An explicit connect() DOES enter the session (the gate is one-way).
    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.address).toBe(WC_ADDR);
    expect(result.current.isConnected).toBe(true);
  });

  // accountsChanged([]) ends the session after WC connect() (listeners bound).
  it('accountsChanged([]) ends the session after WC connect() (listeners must be bound)', async () => {
    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });

    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.isConnected).toBe(true);
    expect(result.current.address).toBe(WC_ADDR);

    // Verify the effect bound the accountsChanged listener.
    expect(wcMock.handlers['accountsChanged']?.length).toBeGreaterThan(0);

    // Simulate a phone-side disconnect: wallet drops all accounts.
    act(() => {
      wcMock.__emit('accountsChanged', []);
    });

    // onAccountsChanged sets authorizedAddress=null + sessionEntered=false when
    // accounts is empty — the app must now be fully disconnected.
    expect(result.current.address).toBeNull();
    expect(result.current.isConnected).toBe(false);
  });

  // chainChanged updates the tracked chainId.
  it('chainChanged updates chainId after WC connect()', async () => {
    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    await act(async () => {
      await result.current.connect();
    });
    // connect() read eth_chainId → 0x89 (137).
    expect(result.current.chainId).toBe(137);

    act(() => {
      wcMock.__emit('chainChanged', '0x13882'); // 80002 (Amoy)
    });
    expect(result.current.chainId).toBe(80002);
  });

  // session_delete (relay-side / phone-side termination) ends the session.
  it('session_delete ends the session after WC connect()', async () => {
    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.isConnected).toBe(true);
    expect(wcMock.handlers['session_delete']?.length).toBeGreaterThan(0);

    act(() => {
      wcMock.__emit('session_delete');
    });
    expect(result.current.address).toBeNull();
    expect(result.current.isConnected).toBe(false);
  });

  // #233: EIP-1193 `disconnect` (provider becoming unavailable) must end the
  // session too — without this listener the SPA keeps showing a live session
  // against a dead provider.
  it('#233: disconnect ends the session after connect()', async () => {
    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.isConnected).toBe(true);
    // Pre-fix: no 'disconnect' listener is ever bound. FAILS.
    expect(wcMock.handlers['disconnect']?.length).toBeGreaterThan(0);

    act(() => {
      wcMock.__emit('disconnect');
    });
    expect(result.current.address).toBeNull();
    expect(result.current.isConnected).toBe(false);
  });

  // User-cancel mapping: a WebSocket close is NOT mapped to the user-cancel string.
  it('WebSocket close error is NOT mapped to the user-cancel message', async () => {
    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });

    wcMock.connect.mockRejectedValueOnce(new Error('WebSocket connection closed unexpectedly'));

    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.error).not.toBe('Connection request was rejected.');
    expect(result.current.error).toMatch(/websocket|closed/i);
  });

  it('genuine user-cancel error IS mapped to the friendly message', async () => {
    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });

    wcMock.connect.mockRejectedValueOnce(new Error('User closed modal'));

    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.error).toBe('Connection request was rejected.');
  });

  // WM-1 guard: abandoning the attempt (closeLoginModal/disconnect) while the
  // account request is in-flight — i.e. AFTER connect() snapshotted its attempt
  // token — must drop the late result on the floor instead of entering the
  // session. We gate eth_requestAccounts (which runs past the snapshot) so the
  // bump deterministically lands inside the guarded window.
  it('WM-1: closeLoginModal during an in-flight account request abandons the session entry', async () => {
    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });

    // Hold eth_requestAccounts open until we release it. connect() opens the WC
    // session, snapshots its attempt token, THEN issues eth_requestAccounts —
    // so the bump below lands after the snapshot, tripping the guard.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    wcMock.request.mockImplementationOnce(async ({ method }: { method: string }) => {
      if (!wcState.session) throw new Error('Please call connect() before request()');
      wcState.calls.push(`request:${method}`);
      await gate;
      return [WC_ADDR];
    });

    let connectPromise!: Promise<void>;
    await act(async () => {
      connectPromise = result.current.connect();
      // Let connect() open the session + snapshot the token + reach the gated
      // eth_requestAccounts await before we abandon the attempt.
      await Promise.resolve();
      await Promise.resolve();
    });

    // Abandon the attempt mid-flight (bumps the connect-attempt token).
    act(() => {
      result.current.closeLoginModal();
    });

    // Release the gated request and let connect() resolve.
    await act(async () => {
      release();
      await connectPromise;
    });

    // The late eth_requestAccounts result must NOT have entered the session.
    expect(result.current.address).toBeNull();
    expect(result.current.isConnected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// signMessage signer-binding (ported from apps/web ethereum.signer-binding.test).
// Now exercises the bridge-core signMessage from ./signMessage.
// ---------------------------------------------------------------------------
describe('signMessage signer-binding', () => {
  // Two distinct throwaway keys, generated at runtime (no literal key material in
  // the repo). The test only needs two DIFFERENT accounts.
  const KEY_A = generatePrivateKey();
  const KEY_B = generatePrivateKey();
  const ACCT_A = privateKeyToAccount(KEY_A);
  const ACCT_B = privateKeyToAccount(KEY_B);

  // A provider whose personal_sign signs the EXACT bytes it receives with KEY_B,
  // regardless of the address argument — i.e. the wallet's active account (B) has
  // drifted from the account the app connected (A).
  function foreignSignerProvider(): EthereumProvider & { request: ReturnType<typeof vi.fn> } {
    return {
      request: vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === 'personal_sign') {
          return ACCT_B.signMessage({ message: { raw: params?.[0] as `0x${string}` } });
        }
        return null;
      }),
      on: () => {},
      removeListener: () => {},
    };
  }

  // A correctly-behaving provider: signs with KEY_A, matching the connected addr.
  function matchingSignerProvider(): EthereumProvider & { request: ReturnType<typeof vi.fn> } {
    return {
      request: vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === 'personal_sign') {
          return ACCT_A.signMessage({ message: { raw: params?.[0] as `0x${string}` } });
        }
        return null;
      }),
      on: () => {},
      removeListener: () => {},
    };
  }

  it('throws when the recovered signer differs from the connected account', async () => {
    const provider = foreignSignerProvider();
    // We ask it to sign for account A, but it signs with B's key.
    await expect(signMessage(provider, ACCT_A.address, 'hello')).rejects.toThrow(
      /different account/i,
    );
    // The error names the recovered account so the user can fix their extension.
    await expect(signMessage(provider, ACCT_A.address, 'hello')).rejects.toThrow(ACCT_B.address);
  });

  it('returns the signature when the recovered signer matches the connected account', async () => {
    const provider = matchingSignerProvider();
    const sig = await signMessage(provider, ACCT_A.address, 'hello');
    expect(sig).toMatch(/^0x[0-9a-f]+$/i);
  });
});
