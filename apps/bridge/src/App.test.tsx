import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { InFlightProvider } from './InFlightContext';
import { NetworkProvider } from './NetworkContext';

// Mutable wallet/identity state so a test can flip connect + identity status. The
// derive-on-connect behavior (SessionEffect) is what lets useBridgeResume detect a
// chain-sourced residual after a fresh connect (#433) — snAddress is derived LAZILY,
// so without it the residual would only surface once the user submits.
const walletState = {
  isConnected: false,
  openLoginModal: vi.fn(),
  address: null as string | null,
  chainId: null as number | null,
  isConnecting: false,
  error: null,
  isModalOpen: false,
  canResume: false,
  sessionRestored: false,
  closeLoginModal: vi.fn(),
  connect: vi.fn(),
  resumeSession: vi.fn(),
  disconnect: vi.fn(),
  requireWallet: vi.fn(),
  signMessage: vi.fn(),
  getProvider: vi.fn(),
};

const identityState = {
  snAddress: null as string | null,
  deriveStatus: { status: 'idle' } as { status: string; message?: string },
  deriveIdentity: vi.fn(async () => {}),
  getSignature: vi.fn(),
};

vi.mock('@starkware-libs/starknet-privacy-bridge/react', () => ({
  WalletProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWallet: () => walletState,
  useBridgeFundingEstimate: () => ({ status: 'idle' }),
  shortenAddress: (a: string) => `${a.slice(0, 6)}…`,
}));

// Mock IdentityContext (bridge-core not built in test; avoids SDK import chain).
vi.mock('./IdentityContext', () => ({
  IdentityProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useIdentity: () => identityState,
}));

// Mock the connected dashboard's heavy flow components — they import the real
// bridge-core (SDK import chain) and are irrelevant to the shell/derive-on-connect
// behavior under test here.
vi.mock('./components/MoveIntoPool', () => ({ MoveIntoPool: () => null }));
vi.mock('./components/MoveFromPool', () => ({ MoveFromPool: () => null }));
vi.mock('./components/PrivateBalance', () => ({ PrivateBalance: () => null }));

function renderApp() {
  return render(
    <InFlightProvider>
      <NetworkProvider>
        <App />
      </NetworkProvider>
    </InFlightProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  walletState.isConnected = false;
  walletState.address = null;
  identityState.snAddress = null;
  identityState.deriveStatus = { status: 'idle' };
  walletState.sessionRestored = false;
});

describe('App shell', () => {
  it('renders connect button when not connected', () => {
    renderApp();
    expect(screen.getByRole('button', { name: /connect wallet/i })).toBeDefined();
  });

  it('does NOT derive identity while disconnected', () => {
    renderApp();
    expect(identityState.deriveIdentity).not.toHaveBeenCalled();
  });
});

describe('App — derive identity on connect (SessionEffect, #433)', () => {
  it('auto-derives once when a wallet connects with no derived identity yet', async () => {
    // A fresh connect (address present, snAddress null, derive idle) must derive the
    // Starknet identity so snAddress populates → useBridgeResume can detect a chain-
    // sourced pool-deposit residual before the user ever submits.
    walletState.isConnected = true;
    walletState.address = '0xabc123';
    renderApp();

    await waitFor(() => expect(identityState.deriveIdentity).toHaveBeenCalledTimes(1));
  });

  it('does NOT re-derive when the identity is already derived', () => {
    // snAddress present → the derived identity already exists; SessionEffect must not
    // prompt a redundant personal_sign.
    walletState.isConnected = true;
    walletState.address = '0xabc123';
    identityState.snAddress = '0xsn';
    identityState.deriveStatus = { status: 'ready' };
    renderApp();

    expect(identityState.deriveIdentity).not.toHaveBeenCalled();
  });

  it('does NOT re-derive while a derive is already pending', () => {
    walletState.isConnected = true;
    walletState.address = '0xabc123';
    identityState.deriveStatus = { status: 'pending' };
    renderApp();

    expect(identityState.deriveIdentity).not.toHaveBeenCalled();
  });
});

describe('App — a RESTORED session must not prompt (SessionEffect gate)', () => {
  it('does NOT auto-derive when the session was restored from storage', async () => {
    // A session the SDK restored across a page refresh had no user gesture behind it, so
    // deriving here would pop a `personal_sign` unbidden on EVERY page load — and leave the
    // app connected-but-keyless if rejected. RED without the `sessionRestored` early-return.
    walletState.isConnected = true;
    walletState.address = '0xabc123';
    walletState.sessionRestored = true;
    renderApp();

    await new Promise((r) => setTimeout(r, 20));
    expect(identityState.deriveIdentity).not.toHaveBeenCalled();
  });

  it('offers "Sign to derive identity" for a restored (idle, keyless) session', () => {
    // The gate above suppresses the automatic prompt, so the manual affordance is the ONLY
    // way in. RED if `needsSign` is narrowed back to `status === 'error'`: the dashboard
    // would render no way to sign, stranding a restored session.
    walletState.isConnected = true;
    walletState.address = '0xabc123';
    walletState.sessionRestored = true;
    renderApp();

    expect(screen.getByRole('button', { name: /sign to derive identity/i })).toBeDefined();
  });

  it('still auto-derives when the session was entered by a click', async () => {
    walletState.isConnected = true;
    walletState.address = '0xabc123';
    walletState.sessionRestored = false;
    renderApp();

    await waitFor(() => expect(identityState.deriveIdentity).toHaveBeenCalledTimes(1));
  });
});
