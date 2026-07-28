// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WalletProvider } from './WalletProvider';
import { useWallet } from './useWallet';
import {
  getEthereumProvider,
  resetProviderDiscovery,
  type EthereumProvider,
} from './injectedProvider';

// Provider pinning on the SILENT paths. With several wallets announced via
// EIP-6963 and NONE picked, getEthereumProvider() falls back to the bare
// window.ethereum global — whichever extension won the injection race. The
// silent mount read and resumeSession must NOT enter against that ambiguous
// global (it could be a wallet the user never chose — the MetaMask+Phantom
// hazard from PR #124), but a lone global (0 or 1 discovered — the injected-E2E
// path) must still work unchanged.
//
// RED (pre-guard): the mount read used window.ethereum (Phantom) unconditionally,
// so canResume flipped true on Phantom's account, and resumeSession() entered
// against it (address === Phantom's). GREEN (with guard): the ambiguous-multi
// guard refuses — canResume stays false and resumeSession routes to the picker.

// WalletProvider imports ./getWalletConnectProvider on mount; stub it so no relay
// runs and no extra provider is injected into discovery.
vi.mock('./getWalletConnectProvider', () => ({
  registerWalletConnect: vi.fn(async () => {}),
  disconnectWalletConnect: vi.fn(async () => {}),
  resetWalletConnectProvider: vi.fn(async () => {}),
  getWalletConnectProvider: vi.fn(async () => undefined),
}));

// device-store touches localStorage on disconnect; stub the clear.
vi.mock('./device-store', () => ({
  clearDeviceIdentity: vi.fn(),
}));

const MM_ADDR = '0x1111111111111111111111111111111111111111';
const PHANTOM_ADDR = '0x2222222222222222222222222222222222222222';

function makeProvider(accounts: string[], tag = 'mm') {
  const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
  return {
    isMetaMask: true,
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_accounts') return accounts;
      if (method === 'eth_requestAccounts') return accounts;
      if (method === 'eth_chainId') return '0x89';
      if (method === 'personal_sign') return `0xsig:${tag}`;
      return null;
    }),
    on: (event: string, handler: (...a: unknown[]) => void) => {
      (handlers[event] ??= []).push(handler);
    },
    removeListener: () => {},
  };
}

function announce(
  info: { uuid: string; name: string; rdns: string; icon: string },
  provider: EthereumProvider,
) {
  window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info, provider } }));
}

const MM_INFO = { uuid: 'uuid-mm', name: 'MetaMask', rdns: 'io.metamask', icon: 'data:,mm' };
const PH_INFO = { uuid: 'uuid-ph', name: 'Phantom', rdns: 'app.phantom', icon: 'data:,ph' };
// WalletConnect's SYNTHETIC discovery entry: registered by getWalletConnectProvider.ts
// with this fixed rdns (kept in sync with SYNTHETIC_PROVIDER_RDNS in
// injectedProvider.ts). It never injects into window.ethereum, so it must not
// count toward injection ambiguity.
const WC_INFO = { uuid: 'walletconnect', name: 'WalletConnect', rdns: 'walletconnect', icon: 'data:,wc' };

beforeEach(() => {
  resetProviderDiscovery();
});
afterEach(() => {
  resetProviderDiscovery();
  delete (window as unknown as { ethereum?: unknown }).ethereum;
  vi.clearAllMocks();
});

describe('WalletProvider — provider pinning (ambiguous multi-wallet)', () => {
  it('silent mount does NOT expose an account when 2+ wallets are announced and none picked', async () => {
    // Phantom squats on window.ethereum; both wallets announce via EIP-6963.
    const phantomWindow = makeProvider([PHANTOM_ADDR], 'phantom-window');
    (window as unknown as { ethereum: unknown }).ethereum = phantomWindow;
    const mm = makeProvider([MM_ADDR], 'mm');
    const ph = makeProvider([PHANTOM_ADDR], 'ph');

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    act(() => {
      announce(MM_INFO, mm as unknown as EthereumProvider);
      announce(PH_INFO, ph as unknown as EthereumProvider);
    });
    await waitFor(() => expect(result.current.providers).toHaveLength(2));

    // Let any silent eth_accounts read settle.
    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
    });

    // The guard must have suppressed the silent read — no auto-resume offered,
    // no address from the ambiguous global.
    expect(result.current.canResume).toBe(false);
    expect(result.current.address).toBeNull();
  });

  it('resumeSession routes to the picker (does not enter against the global) when ambiguous', async () => {
    const phantomWindow = makeProvider([PHANTOM_ADDR], 'phantom-window');
    (window as unknown as { ethereum: unknown }).ethereum = phantomWindow;
    const mm = makeProvider([MM_ADDR], 'mm');
    const ph = makeProvider([PHANTOM_ADDR], 'ph');

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    act(() => {
      announce(MM_INFO, mm as unknown as EthereumProvider);
      announce(PH_INFO, ph as unknown as EthereumProvider);
    });
    await waitFor(() => expect(result.current.providers).toHaveLength(2));

    act(() => {
      result.current.resumeSession();
    });

    // Routed to the picker; did NOT silently enter against Phantom's account.
    expect(result.current.isModalOpen).toBe(true);
    expect(result.current.address).toBeNull();
    expect(result.current.isConnected).toBe(false);
  });

  it('does NOT clear the address when more wallets announce AFTER a lone-global connect (mid-session)', async () => {
    // Lone global at connect time: connect() with NO rdns enters the session
    // against window.ethereum, and selectedRdns STAYS null. RED (pre-fix): when
    // 2+ EIP-6963 wallets later announce (discovered count > 1, selectedRdns
    // null), the silent-read effect's ambiguity guard fires and nulls
    // authorizedAddress — the user is dropped to a signed-out view mid-session.
    // GREEN (post-fix): the guard also requires !sessionEntered, so it no-ops.
    (window as unknown as { ethereum: unknown }).ethereum = makeProvider([MM_ADDR], 'lone');

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });

    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.address).toBe(MM_ADDR);
    expect(result.current.isConnected).toBe(true);

    // Two wallets announce later — discovered count goes to 2 while selectedRdns
    // is still null (the user never picked from the EIP-6963 list).
    const mm = makeProvider([MM_ADDR], 'mm');
    const ph = makeProvider([PHANTOM_ADDR], 'ph');
    act(() => {
      announce(MM_INFO, mm as unknown as EthereumProvider);
      announce(PH_INFO, ph as unknown as EthereumProvider);
    });
    await waitFor(() => expect(result.current.providers).toHaveLength(2));

    // Let the silent-read effect (re-keyed on providers.length) settle.
    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
    });

    // Session preserved: address NOT cleared by the now-ambiguous guard.
    expect(result.current.address).toBe(MM_ADDR);
    expect(result.current.isConnected).toBe(true);
  });

  it('does NOT re-read/clobber the connected account when a provider announces mid-session', async () => {
    // The strongest form of the mid-session bug: the silent-read effect re-running
    // (it is keyed on providers.length) re-issues eth_accounts and OVERWRITES the
    // account connect() set — even to a DIFFERENT value, since some providers
    // answer eth_accounts and eth_requestAccounts differently. Here the lone global
    // returns MM_ADDR for eth_requestAccounts (what connect() uses) but PHANTOM_ADDR
    // for a subsequent eth_accounts (what a silent re-read would use).
    //
    // RED (pre-fix): when a provider announces later (providers.length 0->1), the
    // effect re-runs, reads eth_accounts === PHANTOM_ADDR, and clobbers address to
    // PHANTOM_ADDR mid-session — silently re-keying identity derivation.
    // GREEN (post-fix): the effect early-returns once sessionEntered, so no re-read
    // happens and address stays MM_ADDR.
    let accountsCall = 0;
    const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
    const clobberingGlobal = {
      isMetaMask: true,
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts') return [MM_ADDR];
        if (method === 'eth_accounts') {
          // First silent read (pre-connect mount) sees nothing; any later read
          // would return a DIFFERENT account — the clobber the fix must prevent.
          accountsCall += 1;
          return accountsCall === 1 ? [] : [PHANTOM_ADDR];
        }
        if (method === 'eth_chainId') return '0x89';
        if (method === 'personal_sign') return '0xsig:clobber';
        return null;
      }),
      on: (event: string, handler: (...a: unknown[]) => void) => {
        (handlers[event] ??= []).push(handler);
      },
      removeListener: () => {},
    };
    (window as unknown as { ethereum: unknown }).ethereum = clobberingGlobal;

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });

    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.address).toBe(MM_ADDR);
    expect(result.current.isConnected).toBe(true);

    // A wallet announces later — providers.length changes, re-keying the effect.
    const ph = makeProvider([PHANTOM_ADDR], 'ph');
    act(() => {
      announce(PH_INFO, ph as unknown as EthereumProvider);
    });
    await waitFor(() => expect(result.current.providers).toHaveLength(1));

    // Let any (forbidden) silent eth_accounts re-read settle.
    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
    });

    // Address NOT clobbered: still the connect()-set account, not the re-read one.
    expect(result.current.address).toBe(MM_ADDR);
    expect(result.current.isConnected).toBe(true);
  });

  it('single lone global still auto-resumes (injected-E2E fallback must not regress)', async () => {
    // Exactly one wallet, on window.ethereum, nothing announced via EIP-6963.
    (window as unknown as { ethereum: unknown }).ethereum = makeProvider([MM_ADDR], 'lone');

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });

    // The unambiguous fallback path reads the account and offers Resume.
    await waitFor(() => expect(result.current.canResume).toBe(true));
    expect(result.current.address).toBeNull();

    act(() => {
      result.current.resumeSession();
    });
    expect(result.current.address).toBe(MM_ADDR);
    expect(result.current.isConnected).toBe(true);
  });

  it('injected wallet + WalletConnect (synthetic) still auto-resumes — WC must not trip the guard', async () => {
    // One injected wallet (MetaMask on window.ethereum) plus WalletConnect's
    // synthetic EIP-6963 entry. Discovered count is 2, but only ONE provider
    // contends for window.ethereum, so the global is unambiguous. RED (pre-fix):
    // the guard counted raw getDiscoveredProviders().length > 1, refused the
    // silent read, and one-click resume never appeared. GREEN (post-fix):
    // injectedProviderCount() excludes WC, so the silent read proceeds.
    (window as unknown as { ethereum: unknown }).ethereum = makeProvider([MM_ADDR], 'lone');
    const mm = makeProvider([MM_ADDR], 'mm');
    // A session-ful WC provider (so it is not skipped as session-less); it is
    // only announced into discovery to bump the count, never selected.
    const wc = { ...makeProvider([], 'wc'), isWalletConnect: true, session: {} };

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    act(() => {
      announce(MM_INFO, mm as unknown as EthereumProvider);
      announce(WC_INFO, wc as unknown as EthereumProvider);
    });
    await waitFor(() => expect(result.current.providers).toHaveLength(2));

    // Unambiguous despite count 2: the silent read off the lone injected global
    // proceeds and Resume is offered.
    await waitFor(() => expect(result.current.canResume).toBe(true));
    expect(result.current.address).toBeNull();

    // And resumeSession enters against it rather than routing to the picker.
    act(() => {
      result.current.resumeSession();
    });
    expect(result.current.address).toBe(MM_ADDR);
    expect(result.current.isConnected).toBe(true);
    expect(result.current.isModalOpen).toBe(false);
  });

  it('WalletConnect only (zero injected) still resumes against the global — no false ambiguity', async () => {
    // Edge case: only WC is announced (injectedProviderCount() === 0) while a
    // lone injected global is present (e.g. a wallet that lost the announce race
    // but still owns window.ethereum). Count of injected providers is 0, so the
    // guard never fires and the lone-global fallback works unchanged.
    (window as unknown as { ethereum: unknown }).ethereum = makeProvider([MM_ADDR], 'lone');
    const wc = { ...makeProvider([], 'wc'), isWalletConnect: true, session: {} };

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    act(() => {
      announce(WC_INFO, wc as unknown as EthereumProvider);
    });
    await waitFor(() => expect(result.current.providers).toHaveLength(1));

    await waitFor(() => expect(result.current.canResume).toBe(true));
    expect(result.current.address).toBeNull();

    act(() => {
      result.current.resumeSession();
    });
    expect(result.current.address).toBe(MM_ADDR);
    expect(result.current.isConnected).toBe(true);
  });

  // Regression: disconnect must clear the MODULE-LEVEL provider pin, not just the
  // React selectedRdns state. Otherwise getEthereumProvider() keeps PREFERRING the
  // previously-pinned provider, so a bare connect()/sign after "Forget device"
  // routes to the PREVIOUS wallet while the UI shows no selection — the same
  // wrong-wallet-routing class PR #124 guarded. (Bugbot MEDIUM, PR #174.)
  it('disconnect clears the module provider pin so getEthereumProvider no longer prefers it', async () => {
    // Two injected wallets announce; the user PICKS MetaMask (pins io.metamask).
    const mm = makeProvider([MM_ADDR], 'mm');
    const ph = makeProvider([PHANTOM_ADDR], 'ph');

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    act(() => {
      announce(MM_INFO, mm as unknown as EthereumProvider);
      announce(PH_INFO, ph as unknown as EthereumProvider);
    });
    await waitFor(() => expect(result.current.providers).toHaveLength(2));

    await act(async () => {
      await result.current.connect('io.metamask');
    });
    expect(result.current.address).toBe(MM_ADDR);
    // The module pin now resolves the picked provider.
    expect(getEthereumProvider()).toBe(mm as unknown as EthereumProvider);

    act(() => {
      result.current.disconnect();
    });

    // React selection cleared…
    expect(result.current.selectedRdns).toBeNull();
    // …AND the module pin cleared: with 2 providers announced, none picked, and no
    // window.ethereum global, resolution is ambiguous — it must NOT silently return
    // the previously-pinned MetaMask (RED before the fix: still returned `mm`).
    expect(getEthereumProvider()).toBeUndefined();
  });
});
