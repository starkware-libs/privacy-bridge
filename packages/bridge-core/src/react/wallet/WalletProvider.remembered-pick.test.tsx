import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WalletProvider } from './WalletProvider';
import { useWallet } from './useWallet';
import { resetProviderDiscovery, type EthereumProvider } from './injectedProvider';

// REMEMBERED WALLET PICK. `selectedRdns` is per-page-load state, so on a cold load with
// 2+ INJECTED wallets and nothing picked, the ambiguous-multi guard refuses the silent
// eth_accounts read: canResume stays false and the user is pushed through the picker on
// EVERY reload even though the wallet never revoked anything (see
// WalletProvider.provider-pinning.test.tsx for that guard's own cases).
//
// Persisting WHICH wallet was last used (an EIP-6963 rdns — a public vendor id, never an
// address or key) lets a returning visit re-pin that provider before any interaction, so
// the silent read proceeds against the RIGHT wallet. The load-bearing properties: it
// resolves the remembered wallet even when another extension squats window.ethereum, it
// never calls eth_requestAccounts (so it can't raise a wallet popup on load), and it
// yields to the picker whenever the remembered wallet can't be resolved.

const { readWalletPickMock, writeWalletPickMock, clearDeviceIdentityMock } = vi.hoisted(() => ({
  readWalletPickMock: vi.fn<() => string | null>(() => null),
  writeWalletPickMock: vi.fn<(rdns: string) => void>(),
  clearDeviceIdentityMock: vi.fn(),
}));

vi.mock('./getWalletConnectProvider', () => ({
  registerWalletConnect: vi.fn(async () => {}),
  disconnectWalletConnect: vi.fn(async () => {}),
  resetWalletConnectProvider: vi.fn(async () => {}),
  getWalletConnectProvider: vi.fn(async () => undefined),
}));

vi.mock('./device-store', () => ({
  clearDeviceIdentity: clearDeviceIdentityMock,
  readWalletPick: readWalletPickMock,
  writeWalletPick: writeWalletPickMock,
}));

const MM_ADDR = '0x1111111111111111111111111111111111111111';
const PHANTOM_ADDR = '0x2222222222222222222222222222222222222222';

const MM_INFO = { uuid: 'uuid-mm', name: 'MetaMask', rdns: 'io.metamask', icon: 'data:,mm' };
const PH_INFO = { uuid: 'uuid-ph', name: 'Phantom', rdns: 'app.phantom', icon: 'data:,ph' };
const WC_INFO = {
  uuid: 'walletconnect',
  name: 'WalletConnect',
  rdns: 'walletconnect',
  icon: 'data:,wc',
};

function makeProvider(accounts: string[], tag = 'mm') {
  return {
    isMetaMask: true,
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_accounts') return accounts;
      if (method === 'eth_requestAccounts') return accounts;
      if (method === 'eth_chainId') return '0x89';
      if (method === 'personal_sign') return `0xsig:${tag}`;
      return null;
    }),
    on: () => {},
    removeListener: () => {},
  };
}

function announce(
  info: { uuid: string; name: string; rdns: string; icon: string },
  provider: EthereumProvider,
) {
  window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info, provider } }));
}

/** Count the eth_* calls a provider received, by method. */
function callsFor(provider: { request: { mock: { calls: unknown[][] } } }, method: string): number {
  return provider.request.mock.calls.filter(
    (call) => (call[0] as { method: string }).method === method,
  ).length;
}

beforeEach(() => {
  resetProviderDiscovery();
  readWalletPickMock.mockReturnValue(null);
});

afterEach(() => {
  resetProviderDiscovery();
  delete (window as unknown as { ethereum?: unknown }).ethereum;
  vi.clearAllMocks();
});

describe('WalletProvider — remembered wallet pick', () => {
  it('resolves the REMEMBERED wallet on a cold load even with 2+ injected wallets announced', async () => {
    // Phantom squats window.ethereum (it won the injection race), but MetaMask is what the
    // user last connected with. Without a remembered pick this is the ambiguous case and
    // canResume stays false — the reload-forces-the-picker bug.
    readWalletPickMock.mockReturnValue('io.metamask');
    (window as unknown as { ethereum: unknown }).ethereum = makeProvider(
      [PHANTOM_ADDR],
      'phantom-window',
    );
    const mm = makeProvider([MM_ADDR], 'mm');
    const ph = makeProvider([PHANTOM_ADDR], 'ph');

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    act(() => {
      announce(MM_INFO, mm as unknown as EthereumProvider);
      announce(PH_INFO, ph as unknown as EthereumProvider);
    });
    await waitFor(() => expect(result.current.providers).toHaveLength(2));

    // The restore pins MetaMask, which unblocks the silent read against IT.
    await waitFor(() => expect(result.current.canResume).toBe(true));
    expect(result.current.selectedRdns).toBe('io.metamask');
    // Read off MetaMask, never off the squatting global.
    expect(callsFor(mm, 'eth_accounts')).toBeGreaterThan(0);
    expect(callsFor(ph, 'eth_accounts')).toBe(0);

    // Still gated: canResume is an OFFER, not an entered session.
    expect(result.current.address).toBeNull();
    act(() => result.current.resumeSession());
    await waitFor(() => expect(result.current.address).toBe(MM_ADDR));
  });

  it('never calls eth_requestAccounts while restoring (cannot pop a wallet prompt on load)', async () => {
    readWalletPickMock.mockReturnValue('io.metamask');
    const mm = makeProvider([MM_ADDR], 'mm');
    const ph = makeProvider([PHANTOM_ADDR], 'ph');

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    act(() => {
      announce(MM_INFO, mm as unknown as EthereumProvider);
      announce(PH_INFO, ph as unknown as EthereumProvider);
    });
    await waitFor(() => expect(result.current.canResume).toBe(true));

    expect(callsFor(mm, 'eth_requestAccounts')).toBe(0);
    expect(callsFor(ph, 'eth_requestAccounts')).toBe(0);
  });

  it('falls back to the picker when the remembered wallet is no longer installed', async () => {
    // The user uninstalled MetaMask; only Phantom announces now. The stale pick must not
    // resolve, and must NOT silently fall through to Phantom.
    readWalletPickMock.mockReturnValue('io.metamask');
    (window as unknown as { ethereum: unknown }).ethereum = makeProvider(
      [PHANTOM_ADDR],
      'phantom-window',
    );
    const ph = makeProvider([PHANTOM_ADDR], 'ph');
    const other = makeProvider([PHANTOM_ADDR], 'other');

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    act(() => {
      announce(PH_INFO, ph as unknown as EthereumProvider);
      announce({ ...MM_INFO, uuid: 'uuid-other', rdns: 'io.other' }, other as unknown as EthereumProvider);
    });
    await waitFor(() => expect(result.current.providers).toHaveLength(2));
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.selectedRdns).toBeNull();
    expect(result.current.canResume).toBe(false);
    expect(result.current.address).toBeNull();
  });

  it('ignores a remembered SYNTHETIC pick (WalletConnect is never silently re-pinned)', async () => {
    readWalletPickMock.mockReturnValue('walletconnect');
    const mm = makeProvider([MM_ADDR], 'mm');
    const ph = makeProvider([PHANTOM_ADDR], 'ph');
    const wc = makeProvider([MM_ADDR], 'wc');

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    act(() => {
      announce(MM_INFO, mm as unknown as EthereumProvider);
      announce(PH_INFO, ph as unknown as EthereumProvider);
      announce(WC_INFO, wc as unknown as EthereumProvider);
    });
    await waitFor(() => expect(result.current.providers).toHaveLength(3));
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    // Nothing pinned ⇒ the two injected wallets stay ambiguous ⇒ picker required.
    expect(result.current.selectedRdns).toBeNull();
    expect(result.current.canResume).toBe(false);
  });

  it('remembers the wallet only after it actually authorized us', async () => {
    const mm = makeProvider([MM_ADDR], 'mm');

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    act(() => announce(MM_INFO, mm as unknown as EthereumProvider));
    await waitFor(() => expect(result.current.providers).toHaveLength(1));

    await act(async () => {
      await result.current.connect('io.metamask');
    });

    expect(writeWalletPickMock).toHaveBeenCalledWith('io.metamask');
  });

  it('does NOT remember a wallet that rejected the connect', async () => {
    const mm = makeProvider([MM_ADDR], 'mm');
    mm.request = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_requestAccounts') {
        throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      }
      if (method === 'eth_accounts') return [];
      return null;
    }) as typeof mm.request;

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    act(() => announce(MM_INFO, mm as unknown as EthereumProvider));
    await waitFor(() => expect(result.current.providers).toHaveLength(1));

    await act(async () => {
      await result.current.connect('io.metamask');
    });

    expect(writeWalletPickMock).not.toHaveBeenCalled();
  });

  it('does not override the wallet the user picked this visit', async () => {
    // Remembered MetaMask, but the user explicitly connects Phantom — the restore must not
    // re-pin MetaMask underneath them.
    readWalletPickMock.mockReturnValue('io.metamask');
    const mm = makeProvider([MM_ADDR], 'mm');
    const ph = makeProvider([PHANTOM_ADDR], 'ph');

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    act(() => {
      announce(MM_INFO, mm as unknown as EthereumProvider);
      announce(PH_INFO, ph as unknown as EthereumProvider);
    });
    await waitFor(() => expect(result.current.providers).toHaveLength(2));

    await act(async () => {
      await result.current.connect('app.phantom');
    });

    expect(result.current.selectedRdns).toBe('app.phantom');
    expect(result.current.address).toBe(PHANTOM_ADDR);
    expect(writeWalletPickMock).toHaveBeenCalledWith('app.phantom');
  });

  it('drops the pick on disconnect, so the next visit asks again', async () => {
    const mm = makeProvider([MM_ADDR], 'mm');

    const { result } = renderHook(() => useWallet(), { wrapper: WalletProvider });
    act(() => announce(MM_INFO, mm as unknown as EthereumProvider));
    await waitFor(() => expect(result.current.providers).toHaveLength(1));
    await act(async () => {
      await result.current.connect('io.metamask');
    });

    act(() => result.current.disconnect());

    // The pick lives in PMP_STORAGE_KEYS, so the one existing wipe covers it — asserting on
    // that call keeps this honest without reaching into localStorage past the module mock.
    expect(clearDeviceIdentityMock).toHaveBeenCalled();
    expect(result.current.selectedRdns).toBeNull();
    expect(result.current.address).toBeNull();
  });
});
