import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { IdentityProvider, useIdentity } from './IdentityContext';

// Session reset on network switch (docs/network-switch-plan.md test 4): when the
// network changes, IdentityContext must WIPE the derived snAddress + status back to
// idle (the derived SN account is network-specific: ozClassHash / poolAddress
// differ). We drive this via useNetwork().networkEpoch, which
// NetworkContext bumps on every successful switch.

const signMessage = vi.fn().mockResolvedValue('sig');

vi.mock('@starkware-libs/starknet-privacy-bridge/react', () => ({
  useWallet: () => ({
    address: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    signMessage,
    requireWallet: () => true,
  }),
}));

vi.mock('@starkware-libs/starknet-privacy-bridge', () => ({
  deriveStarknetPrivateKey: (sig: string) => `pk-${sig}`,
  deriveViewingKey: (_sig: string) => 1n,
  deriveStarknetAccount: (pk: string) => ({ address: `sn-${pk}`, publicKey: '0x0' }),
  config: { ozClassHash: '0xclasshash' },
}));

// Controllable network epoch — bumping it simulates a network switch.
let mockEpoch = 0;
vi.mock('./NetworkContext', () => ({
  useNetwork: () => ({ networkEpoch: mockEpoch }),
}));

// IdentityProvider registers deriveIdentity with InFlightContext (#193) — stub it
// out since these tests exercise the network-reset path, not the in-flight guard.
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

describe('IdentityContext — session wipe on network switch', () => {
  beforeEach(() => {
    mockEpoch = 0;
    signMessage.mockClear();
  });

  it('clears snAddress + status when networkEpoch bumps (network switched)', async () => {
    const { rerender } = render(
      <IdentityProvider>
        <Probe />
      </IdentityProvider>,
    );

    // Derive an identity on the current network.
    fireEvent.click(screen.getByText('derive'));
    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('ready');
      expect(screen.getByTestId('sn-address').textContent).toBe('sn-pk-sig');
    });

    // Simulate a network switch: bump the epoch and re-render.
    mockEpoch = 1;
    rerender(
      <IdentityProvider>
        <Probe />
      </IdentityProvider>,
    );

    // Derived session must be wiped back to idle for the new network.
    await waitFor(() => {
      expect(screen.getByTestId('sn-address').textContent).toBe('none');
      expect(screen.getByTestId('status').textContent).toBe('idle');
    });
  });
});
