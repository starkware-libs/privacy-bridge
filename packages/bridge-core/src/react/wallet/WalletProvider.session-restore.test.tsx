import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WalletProvider } from './WalletProvider';
import { useWallet } from './useWallet';
import { resetProviderDiscovery, type EthereumProvider } from './injectedProvider';
import { PMP_STORAGE_KEYS } from './device-store';
import { WALLET_SESSION_KEY, WALLET_SESSION_TTL_MS, readWalletSession } from './session-store';

// SESSION RESTORE ACROSS A PAGE REFRESH.
//
// RED (pre-fix): nothing was persisted, so `sessionEntered` was false on every fresh
// mount and `address` stayed null — a refresh dropped the user to the signed-out /
// "Resume session" state. GREEN: a session the user ENTERED on this device is
// recorded (public address + wallet rdns + a TTL stamp) and re-entered on load, but
// only after the wallet re-confirms the SAME account through the SAME pinned wallet.
//
// The strict gate is unchanged for everything we did not record: a wallet-side
// session the SDK rehydrated on its own still only yields `canResume` (pinned by
// WalletProvider.test.tsx's connect-gate suite).

// Keep WalletConnect out of discovery so `window.ethereum` resolution is the only
// variable under test.
vi.mock('./getWalletConnectProvider', () => ({
  registerWalletConnect: vi.fn(async () => {}),
  disconnectWalletConnect: vi.fn(async () => {}),
  resetWalletConnectProvider: vi.fn(async () => {}),
  getWalletConnectProvider: vi.fn(async () => undefined),
}));

const MM_ADDR = '0x1111111111111111111111111111111111111111';
const OTHER_ADDR = '0x2222222222222222222222222222222222222222';

const MM_INFO = { uuid: 'uuid-mm', name: 'MetaMask', rdns: 'io.metamask', icon: 'data:,mm' };
const PH_INFO = { uuid: 'uuid-ph', name: 'Phantom', rdns: 'app.phantom', icon: 'data:,ph' };

function makeProvider(accounts: string[]) {
  const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
  return {
    isMetaMask: true,
    handlers,
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return accounts;
      if (method === 'eth_chainId') return '0x89';
      return null;
    }),
    on: (event: string, handler: (...a: unknown[]) => void) => {
      (handlers[event] ??= []).push(handler);
    },
    removeListener: () => {},
    __emit: (event: string, ...args: unknown[]) => {
      for (const h of handlers[event] ?? []) h(...args);
    },
  };
}

function announce(
  info: { uuid: string; name: string; rdns: string; icon: string },
  provider: EthereumProvider,
) {
  window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info, provider } }));
}

function recordSession(address: string, rdns: string | null, at: number = Date.now()) {
  localStorage.setItem(WALLET_SESSION_KEY, JSON.stringify({ address, rdns, at }));
}

// The bare-global branch of the restore waits for the EIP-6963 announce window (the
// discovery effect's 6 × 250ms poll) to close before trusting injectedProviderCount(), so
// these cases let real time pass — ~1.6s each, in 4 of the 18 tests here.
//
// Deliberately NOT fake timers, despite the usual preference for advancing the clock: this
// suite interleaves the faked discovery interval with REAL-timer promise resolution
// (`waitFor` cannot run under vitest fake timers at all — RTL gates fake-timer support on a
// global `jest`), and swapping to advanceTimersByTimeAsync broke two unrelated cases in the
// file by reordering that interleaving. A correct 1.6s beats a green-but-fragile clock dance.
const ANNOUNCE_WINDOW_MS = 1600;
async function letAnnounceWindowClose() {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, ANNOUNCE_WINDOW_MS));
  });
}

beforeEach(() => {
  localStorage.clear();
  resetProviderDiscovery();
});
afterEach(() => {
  // UNMOUNT first. This repo configures no RTL auto-cleanup (no `globals` in
  // vitest.config.ts, no cleanup() in vitest.setup.ts), so without this every earlier
  // test's WalletProvider stays mounted with a LIVE restore effect — and a parked
  // `eth_accounts` resolving later re-writes `pmp.lastWallet`, so the next test sees a
  // record it never created. `localStorage.clear()` alone does NOT fix that: clearing
  // storage doesn't stop a leaked component from re-writing it a moment later. Proven
  // with `--sequence.shuffle.tests=true` (2 of 3 shuffles failed the HIGH-#2 guard).
  cleanup();
  localStorage.clear();
  resetProviderDiscovery();
  delete (window as unknown as { ethereum?: unknown }).ethereum;
  vi.clearAllMocks();
});

describe('WalletProvider — restores an entered session across a refresh', () => {
  it('re-enters the session for the recorded account+wallet with no prompt', async () => {
    const mm = makeProvider([MM_ADDR]);
    recordSession(MM_ADDR, 'io.metamask');

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    act(() => {
      announce(MM_INFO, mm as unknown as EthereumProvider);
    });

    // RED pre-fix: address stays null and the app offers "Resume session" instead.
    await waitFor(() => expect(result.current.isConnected).toBe(true));
    expect(result.current.address).toBe(MM_ADDR);
    expect(result.current.canResume).toBe(false);
    // Restored, not clicked — consumers must not fire gesture-only work off this.
    expect(result.current.sessionRestored).toBe(true);
    // NO wallet prompt: eth_requestAccounts is what pops the extension.
    expect(mm.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_requestAccounts' }),
    );
    // The recorded wallet is re-pinned, so every later request (incl. signing) routes
    // to the wallet the session was entered through.
    expect(result.current.selectedRdns).toBe('io.metamask');
    // chainId was read off the restored provider.
    expect(result.current.chainId).toBe(137);
  });

  it('records the session on connect() and on resumeSession()', async () => {
    const mm = makeProvider([MM_ADDR]);
    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    act(() => {
      announce(MM_INFO, mm as unknown as EthereumProvider);
    });
    await waitFor(() => expect(result.current.providers).toHaveLength(1));

    await act(async () => {
      await result.current.connect('io.metamask');
    });

    expect(readWalletSession()).toMatchObject({ address: MM_ADDR, rdns: 'io.metamask' });
    // A clicked entry is NOT a restored one.
    expect(result.current.sessionRestored).toBe(false);
  });

  it('slides the TTL stamp forward on every restore', async () => {
    const mm = makeProvider([MM_ADDR]);
    const stale = Date.now() - WALLET_SESSION_TTL_MS / 2;
    recordSession(MM_ADDR, 'io.metamask', stale);

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    act(() => {
      announce(MM_INFO, mm as unknown as EthereumProvider);
    });
    await waitFor(() => expect(result.current.isConnected).toBe(true));

    expect(readWalletSession()!.at).toBeGreaterThan(stale);
  });

  it('restores against an unambiguous lone window.ethereum once discovery settles', async () => {
    (window as unknown as { ethereum: unknown }).ethereum = makeProvider([MM_ADDR]);
    recordSession(MM_ADDR, null);

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    await letAnnounceWindowClose();

    await waitFor(() => expect(result.current.isConnected).toBe(true));
    expect(result.current.address).toBe(MM_ADDR);
  });
});

describe('WalletProvider — restore fails closed', () => {
  it('does NOT restore through a wallet other than the recorded one (wrong-wallet routing)', async () => {
    // The security case. The session was entered through MetaMask, but Phantom won
    // the window.ethereum race this load and MetaMask never announces (disabled /
    // uninstalled). Phantom reports the SAME address — the user imported the account
    // into both — so neither the address check nor signMessage's signer-binding can
    // tell the wallets apart. Only the provider PIN can, so the restore must refuse
    // rather than fall back to the global.
    const phantom = makeProvider([MM_ADDR]);
    (window as unknown as { ethereum: unknown }).ethereum = phantom;
    recordSession(MM_ADDR, 'io.metamask');

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    act(() => {
      announce(PH_INFO, phantom as unknown as EthereumProvider);
    });
    // Let the whole announce window pass: the refusal must be permanent, not a race
    // the restore wins later.
    await letAnnounceWindowClose();

    expect(result.current.isConnected).toBe(false);
    expect(result.current.address).toBeNull();
    expect(result.current.sessionRestored).toBe(false);
    expect(result.current.selectedRdns).toBeNull();
    // The pre-fix gate still applies: a one-click Resume, which re-checks ambiguity.
    expect(result.current.canResume).toBe(true);
  });

  it('does NOT restore when the wallet is locked (eth_accounts empty) but KEEPS the record', async () => {
    const locked = makeProvider([]);
    recordSession(MM_ADDR, 'io.metamask');

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    act(() => {
      announce(MM_INFO, locked as unknown as EthereumProvider);
    });
    await waitFor(() => expect(locked.request).toHaveBeenCalled());

    expect(result.current.isConnected).toBe(false);
    expect(result.current.address).toBeNull();
    expect(result.current.canResume).toBe(false);
    // A lock is transient — the record survives so unlocking + reloading restores.
    expect(readWalletSession()).not.toBeNull();
  });

  it('does NOT restore when the wallet moved to a different account, and forgets the record', async () => {
    const switched = makeProvider([OTHER_ADDR]);
    recordSession(MM_ADDR, 'io.metamask');

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    act(() => {
      announce(MM_INFO, switched as unknown as EthereumProvider);
    });
    await waitFor(() => expect(result.current.canResume).toBe(true));

    // Entering here would rehydrate MM_ADDR's identity against OTHER_ADDR's wallet.
    expect(result.current.isConnected).toBe(false);
    expect(result.current.address).toBeNull();
    expect(readWalletSession()).toBeNull();
  });

  it('does NOT restore an expired record', async () => {
    const mm = makeProvider([MM_ADDR]);
    recordSession(MM_ADDR, 'io.metamask', Date.now() - WALLET_SESSION_TTL_MS - 1);

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    act(() => {
      announce(MM_INFO, mm as unknown as EthereumProvider);
    });
    await waitFor(() => expect(result.current.canResume).toBe(true));

    expect(result.current.isConnected).toBe(false);
    // The expired record is dropped rather than left to linger.
    expect(localStorage.getItem(WALLET_SESSION_KEY)).toBeNull();
  });

  it('ignores a malformed record without throwing', async () => {
    const mm = makeProvider([MM_ADDR]);
    localStorage.setItem(WALLET_SESSION_KEY, '{not json');

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    act(() => {
      announce(MM_INFO, mm as unknown as EthereumProvider);
    });
    await waitFor(() => expect(result.current.canResume).toBe(true));
    expect(result.current.isConnected).toBe(false);
  });

  it('refuses a lone-global record once the global is contended by two injected wallets', async () => {
    // Recorded when only one wallet was installed; a second has since been added, so
    // window.ethereum is no longer attributable.
    (window as unknown as { ethereum: unknown }).ethereum = makeProvider([MM_ADDR]);
    recordSession(MM_ADDR, null);

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    act(() => {
      announce(MM_INFO, makeProvider([MM_ADDR]) as unknown as EthereumProvider);
      announce(PH_INFO, makeProvider([OTHER_ADDR]) as unknown as EthereumProvider);
    });
    await letAnnounceWindowClose();

    expect(result.current.isConnected).toBe(false);
    expect(result.current.address).toBeNull();
  });
});

// The restore's own async lifecycle. Its `eth_accounts` read can outlive the effect run
// that started it, and a session can be entered by a CLICK meanwhile — through the same
// already-pinned wallet, which changes none of this effect's deps, so the cleanup never
// runs. (B3 review, findings 1 and 2.)
describe('WalletProvider — restore lifecycle', () => {
  // A provider whose eth_accounts is held open until the test releases it.
  function deferredProvider(accounts: string[], requestAccounts = accounts) {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
    return {
      release: () => release(),
      provider: {
        isMetaMask: true,
        request: vi.fn(async ({ method }: { method: string }) => {
          if (method === 'eth_accounts') {
            await gate;
            return accounts;
          }
          if (method === 'eth_requestAccounts') return requestAccounts;
          if (method === 'eth_chainId') return '0x89';
          return null;
        }),
        on: (event: string, handler: (...a: unknown[]) => void) => {
          (handlers[event] ??= []).push(handler);
        },
        removeListener: () => {},
      },
    };
  }

  it('still restores when a dep changes while the account read is in flight', async () => {
    // RED (pre-fix): the once-guard was claimed before the await and never released, so
    // the re-run triggered by `discoverySettled` flipping at 1.5s early-returned and the
    // restore was lost for the entire page load — silently back to "Resume session".
    const { provider, release } = deferredProvider([MM_ADDR]);
    recordSession(MM_ADDR, 'io.metamask');

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    act(() => {
      announce(MM_INFO, provider as unknown as EthereumProvider);
    });
    await waitFor(() => expect(result.current.selectedRdns).toBe('io.metamask'));

    // Let the announce window close (flips discoverySettled → re-runs the effect) while
    // the read is still parked.
    await letAnnounceWindowClose();
    await act(async () => {
      release();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.isConnected).toBe(true));
    expect(result.current.address).toBe(MM_ADDR);
  });

  it('a late restore does NOT overwrite a session entered by an explicit connect()', async () => {
    // RED (pre-fix): connect() through the ALREADY-pinned wallet changes no dep, so no
    // cleanup ran and `cancelled` stayed false — the stale read then set address to the
    // RECORDED account (not the one the user just authorized) and flipped
    // sessionRestored true, suppressing the consumer's auto-derive.
    const { provider, release } = deferredProvider([MM_ADDR], [OTHER_ADDR]);
    recordSession(MM_ADDR, 'io.metamask');

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    act(() => {
      announce(MM_INFO, provider as unknown as EthereumProvider);
    });
    await waitFor(() => expect(result.current.selectedRdns).toBe('io.metamask'));

    await act(async () => {
      await result.current.connect('io.metamask');
    });
    expect(result.current.address).toBe(OTHER_ADDR);

    await act(async () => {
      release();
      await Promise.resolve();
    });

    // The clicked session stands, and it is NOT reported as restored.
    expect(result.current.address).toBe(OTHER_ADDR);
    expect(result.current.sessionRestored).toBe(false);
    expect(readWalletSession()).toMatchObject({ address: OTHER_ADDR });
  });

  it('a late restore does NOT resurrect the session after disconnect()', async () => {
    const { provider, release } = deferredProvider([MM_ADDR]);
    recordSession(MM_ADDR, 'io.metamask');

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    act(() => {
      announce(MM_INFO, provider as unknown as EthereumProvider);
    });
    await waitFor(() => expect(result.current.selectedRdns).toBe('io.metamask'));

    act(() => {
      result.current.disconnect();
    });
    await act(async () => {
      release();
      await Promise.resolve();
    });

    expect(result.current.isConnected).toBe(false);
    expect(localStorage.getItem(WALLET_SESSION_KEY)).toBeNull();
  });

  it('a foreign pre-session wallet locking does NOT wipe another wallet record', async () => {
    // RED (pre-fix): the accountsChanged→[] branch cleared unconditionally, and
    // pre-session the listener binds to the bare global — so a locked squatter extension
    // destroyed a record belonging to a wallet it has nothing to do with.
    const phantom = makeProvider([]);
    (window as unknown as { ethereum: unknown }).ethereum = phantom;
    recordSession(MM_ADDR, 'io.metamask');

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    act(() => {
      announce(PH_INFO, phantom as unknown as EthereumProvider);
    });
    await waitFor(() => expect(result.current.providers).toHaveLength(1));

    act(() => {
      phantom.__emit('accountsChanged', []);
    });

    expect(result.current.isConnected).toBe(false);
    expect(readWalletSession()).not.toBeNull();
  });
});

describe('WalletProvider — the record is dropped on every exit', () => {
  it('disconnect() / Forget this device removes it', async () => {
    const mm = makeProvider([MM_ADDR]);
    recordSession(MM_ADDR, 'io.metamask');

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    act(() => {
      announce(MM_INFO, mm as unknown as EthereumProvider);
    });
    await waitFor(() => expect(result.current.isConnected).toBe(true));

    act(() => {
      result.current.disconnect();
    });

    // Otherwise "Forget this device" is a no-op: the next load re-enters the session
    // the user just forgot.
    expect(localStorage.getItem(WALLET_SESSION_KEY)).toBeNull();
    expect(result.current.sessionRestored).toBe(false);
    // And it is part of the wipe set, so the app-side forget path clears it too.
    expect(PMP_STORAGE_KEYS).toContain(WALLET_SESSION_KEY);
  });

  it('a wallet-side revocation (accountsChanged → []) removes it', async () => {
    const mm = makeProvider([MM_ADDR]);
    recordSession(MM_ADDR, 'io.metamask');

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    act(() => {
      announce(MM_INFO, mm as unknown as EthereumProvider);
    });
    await waitFor(() => expect(result.current.isConnected).toBe(true));

    act(() => {
      mm.__emit('accountsChanged', []);
    });

    expect(result.current.isConnected).toBe(false);
    expect(localStorage.getItem(WALLET_SESSION_KEY)).toBeNull();
  });

  it('a wallet-side account switch re-points the record and clears sessionRestored', async () => {
    const mm = makeProvider([MM_ADDR]);
    recordSession(MM_ADDR, 'io.metamask');

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    act(() => {
      announce(MM_INFO, mm as unknown as EthereumProvider);
    });
    await waitFor(() => expect(result.current.sessionRestored).toBe(true));

    act(() => {
      mm.__emit('accountsChanged', [OTHER_ADDR]);
    });

    // Follows the wallet, so the next load doesn't see a mismatch and drop the session.
    expect(readWalletSession()).toMatchObject({ address: OTHER_ADDR });
    // The switch is a fresh wallet-side action, so consumers may prompt again.
    expect(result.current.sessionRestored).toBe(false);
  });

  it('an abandoned connect() (WM-1) records nothing', async () => {
    let release!: (accounts: string[]) => void;
    const mm = {
      isMetaMask: true,
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts') {
          return new Promise<string[]>((r) => {
            release = r;
          });
        }
        if (method === 'eth_accounts') return [];
        if (method === 'eth_chainId') return '0x89';
        return null;
      }),
      on: () => {},
      removeListener: () => {},
    };
    (window as unknown as { ethereum: unknown }).ethereum = mm;

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    let connectPromise!: Promise<void>;
    act(() => {
      connectPromise = result.current.connect();
    });
    await waitFor(() => expect(release).toBeDefined());

    act(() => {
      result.current.closeLoginModal();
    });
    await act(async () => {
      release([MM_ADDR]);
      await connectPromise;
    });

    // A cancelled connect must not leave a session the next load would auto-enter.
    expect(result.current.isConnected).toBe(false);
    expect(localStorage.getItem(WALLET_SESSION_KEY)).toBeNull();
  });
});
