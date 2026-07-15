import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { IdentityProvider, useIdentity } from './IdentityContext';

// Issue #193 (Bugbot MEDIUM, merged via #167): deriveIdentity only treated a
// run as stale when the connected EVM address changed — not when networkEpoch
// bumps after a runtime network switch. A network switch fully disconnects
// (evmAddress -> null) AND bumps networkEpoch via the SAME setNetwork call, but
// if a derive's signature resolves in the narrow window where the epoch has
// already bumped, this simulates that a late completion must not republish
// snAddress/'ready' onto the freshly-wiped identity.

const signMessage = vi.fn();

vi.mock('@polymarket-privacy/bridge-core/react', () => ({
  useWallet: () => ({
    address: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    signMessage,
    requireWallet: () => true,
  }),
}));

vi.mock('@polymarket-privacy/bridge-core', () => ({
  BRIDGE_IDENTITY_SIGN_MESSAGE: 'sign-me',
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

// Spy on setFlowInFlight registration (part of the #193 fix: derive must be
// tracked so NetworkContext's switch guard blocks a switch while pending).
const setFlowInFlight = vi.fn();
vi.mock('./InFlightContext', () => ({
  useInFlight: () => ({ anyInFlight: false, setFlowInFlight }),
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

describe('IdentityContext — stale derive after network switch (#193)', () => {
  beforeEach(() => {
    mockEpoch = 0;
    signMessage.mockClear();
    setFlowInFlight.mockClear();
  });

  it('does not republish snAddress/ready when the derive completes AFTER a networkEpoch bump', async () => {
    // Control exactly when the signature resolves.
    let resolveSign: (sig: string) => void = () => {};
    const signPromise = new Promise<string>((resolve) => {
      resolveSign = resolve;
    });
    signMessage.mockImplementationOnce(() => signPromise);

    const { rerender } = render(
      <IdentityProvider>
        <Probe />
      </IdentityProvider>,
    );

    // Kick off derive on epoch 0 — hangs on the unresolved personal_sign.
    fireEvent.click(screen.getByText('derive'));
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('pending'));
    // Registered as in-flight so a switch would be blocked while this is pending.
    expect(setFlowInFlight).toHaveBeenCalledWith('deriveIdentity', true);

    // Simulate a runtime network switch WHILE the derive is still pending:
    // networkEpoch bumps (the address stays the same in this simulation — the
    // point is that the epoch-only staleness path is what must catch this).
    mockEpoch = 1;
    rerender(
      <IdentityProvider>
        <Probe />
      </IdentityProvider>,
    );

    // NOW the stale signature (requested on epoch 0) finally resolves.
    await act(async () => {
      resolveSign('sig-epoch-0');
      await signPromise;
    });

    // The late completion must NOT republish snAddress/'ready' for the old epoch.
    expect(screen.getByTestId('sn-address').textContent).toBe('none');
    expect(screen.getByTestId('status').textContent).not.toBe('ready');
    // And the in-flight registration must have been cleared.
    expect(setFlowInFlight).toHaveBeenLastCalledWith('deriveIdentity', false);
  });

  // Bugbot MEDIUM on PR #197 ("Overlapping derive clears switch guard"): the
  // reset effect can force deriveStatus back to idle WHILE an earlier derive is
  // still awaiting personal_sign, so a SECOND derive starts — two runs overlap.
  // The in-flight flag is a single boolean per id, so when the FIRST run reaches
  // its finally it must NOT clear the guard while the second run is still
  // pending. The generation token (deriveGenRef) makes only the latest run own
  // (and clear) the flag. We model the real InFlightContext boolean-per-id
  // semantics here so `anyInFlight` reflects whether ANY registration is live.
  it('keeps the switch guard set when an older overlapping derive finishes before the newer one', async () => {
    // Control run #1 and run #2 signatures independently.
    let resolveSign1: (sig: string) => void = () => {};
    const sign1 = new Promise<string>((r) => {
      resolveSign1 = r;
    });
    let resolveSign2: (sig: string) => void = () => {};
    const sign2 = new Promise<string>((r) => {
      resolveSign2 = r;
    });
    signMessage.mockImplementationOnce(() => sign1).mockImplementationOnce(() => sign2);

    const { rerender } = render(
      <IdentityProvider>
        <Probe />
      </IdentityProvider>,
    );

    // Run #1 — hangs on personal_sign; registers the guard true.
    fireEvent.click(screen.getByText('derive'));
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('pending'));

    // Force the reset effect (a network switch bumps the epoch) so deriveStatus
    // flips back to idle mid-sign — this is exactly the window where an earlier
    // run is still awaiting personal_sign but SessionEffect can start a second
    // one. Run #1 (captured epoch 0) will become stale for its terminal writes,
    // but it STILL reaches its finally — which is where the guard-drop bug lives.
    mockEpoch = 1;
    rerender(
      <IdentityProvider>
        <Probe />
      </IdentityProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('idle'));

    // Run #2 — starts now that status is idle again; also hangs on sign.
    fireEvent.click(screen.getByText('derive'));
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('pending'));

    // Compute the NET in-flight state from the recorded registrations (models the
    // real boolean-per-id InFlightContext). Both runs registered true; neither
    // has cleared yet, so the guard is up.
    const netInFlight = (): boolean => {
      let live = false;
      for (const [id, v] of setFlowInFlight.mock.calls) {
        if (id === 'deriveIdentity') live = v as boolean;
      }
      return live;
    };
    expect(netInFlight()).toBe(true);

    // Now the OLDER run (#1) finishes FIRST. With a bare boolean it would call
    // setFlowInFlight('deriveIdentity', false) here and drop the guard even
    // though run #2 is still pending. The gen token must suppress that clear.
    await act(async () => {
      resolveSign1('sig-1');
      await sign1;
    });

    // Guard must STILL be up — run #2 owns it and hasn't finished.
    expect(netInFlight()).toBe(true);
    expect(screen.getByTestId('status').textContent).toBe('pending');

    // When run #2 finally finishes, the guard is released.
    await act(async () => {
      resolveSign2('sig-2');
      await sign2;
    });
    expect(netInFlight()).toBe(false);
  });
});
