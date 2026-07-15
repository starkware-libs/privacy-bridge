import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { IdentityProvider, useIdentity } from './IdentityContext';

// Bugbot MEDIUM finding: switching the connected EVM address left stale
// snAddress/signature state around, so SessionEffect's guard (`if (snAddress ||
// deriveStatus.status !== 'idle') return;`) never re-ran deriveIdentity for the
// new account — the UI kept showing the PREVIOUS account's derived SN address.
// The fix adds a useEffect([evmAddress]) that resets snAddress/deriveStatus/
// sigRef/inflight/sigForAddress whenever the connected address changes.

let mockAddress: string | null = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const signMessage = vi.fn().mockImplementation(async () => `sig-for-${mockAddress}`);

vi.mock('@starkware-libs/starknet-privacy-bridge/react', () => ({
  useWallet: () => ({
    address: mockAddress,
    signMessage,
    requireWallet: () => true,
  }),
}));

vi.mock('@starkware-libs/starknet-privacy-bridge', () => ({
  BRIDGE_IDENTITY_SIGN_MESSAGE: 'sign-me',
  deriveStarknetPrivateKey: (sig: string) => `pk-${sig}`,
  deriveViewingKey: (_sig: string) => 1n,
  deriveStarknetAccount: (pk: string) => ({ address: `sn-${pk}`, publicKey: '0x0' }),
  config: { ozClassHash: '0xclasshash' },
}));

// IdentityProvider watches useNetwork().networkEpoch to wipe on a network switch.
// Pin it to 0 here so these address-change tests exercise only the address path.
vi.mock('./NetworkContext', () => ({
  useNetwork: () => ({ networkEpoch: 0 }),
}));

// IdentityProvider registers deriveIdentity with InFlightContext (#193) — stub it
// out since these tests exercise the address-change path, not the in-flight guard.
vi.mock('./InFlightContext', () => ({
  useInFlight: () => ({ anyInFlight: false, setFlowInFlight: vi.fn() }),
}));

function Probe() {
  const { snAddress, deriveStatus, deriveIdentity } = useIdentity();
  return (
    <div>
      <span data-testid="sn-address">{snAddress ?? 'none'}</span>
      <span data-testid="status">{deriveStatus.status}</span>
      <button onClick={() => void deriveIdentity()}>derive</button>
    </div>
  );
}

describe('IdentityContext', () => {
  it('resets snAddress/deriveStatus when the connected EVM address changes', async () => {
    mockAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const { rerender } = render(
      <IdentityProvider>
        <Probe />
      </IdentityProvider>,
    );

    // Derive identity for address A.
    fireEvent.click(screen.getByText('derive'));
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    const addressAResult = screen.getByTestId('sn-address').textContent;
    expect(addressAResult).not.toBe('none');

    // Switch to address B — simulate the wallet reconnecting to a new account.
    mockAddress = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    rerender(
      <IdentityProvider>
        <Probe />
      </IdentityProvider>,
    );

    // The stale snAddress from account A must be cleared so SessionEffect's
    // idle-guard allows a fresh derive for account B.
    await waitFor(() => {
      expect(screen.getByTestId('sn-address').textContent).toBe('none');
      expect(screen.getByTestId('status').textContent).toBe('idle');
    });

    // Deriving again now produces a DIFFERENT SN address (bound to B's signature).
    fireEvent.click(screen.getByText('derive'));
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    const addressBResult = screen.getByTestId('sn-address').textContent;
    expect(addressBResult).not.toBe('none');
    expect(addressBResult).not.toBe(addressAResult);
  });

  // Bugbot MEDIUM re-flag ("Stale derive after wallet switch"): deriveIdentity had
  // no guard after `await getSignature()`. If the connected EVM address changes
  // WHILE a personal_sign is in flight, the reset effect clears state back to
  // idle for the new address, but the in-flight call — once its OLD signature
  // finally resolves — would still write the OLD account's derived SN address
  // and 'ready' status, stomping the fresh idle state for the new account.
  it('does not stomp fresh idle state when a stale in-flight sign resolves after an address switch', async () => {
    mockAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    // Control exactly when address A's signMessage resolves.
    let resolveSignA: (sig: string) => void = () => {};
    const signAPromise = new Promise<string>((resolve) => {
      resolveSignA = resolve;
    });
    signMessage.mockImplementationOnce(() => signAPromise);

    const { rerender } = render(
      <IdentityProvider>
        <Probe />
      </IdentityProvider>,
    );

    // Kick off derive for address A — it hangs on the unresolved personal_sign.
    fireEvent.click(screen.getByText('derive'));
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('pending'));

    // Switch to address B WHILE A's signature is still in flight.
    mockAddress = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    rerender(
      <IdentityProvider>
        <Probe />
      </IdentityProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('sn-address').textContent).toBe('none');
      expect(screen.getByTestId('status').textContent).toBe('idle');
    });

    // NOW the stale signature for A finally resolves.
    await act(async () => {
      resolveSignA(`sig-for-0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`);
      await signAPromise;
    });

    // The late resolution for A must NOT overwrite the idle state for B.
    expect(screen.getByTestId('sn-address').textContent).toBe('none');
    expect(screen.getByTestId('status').textContent).toBe('idle');
  });
});
