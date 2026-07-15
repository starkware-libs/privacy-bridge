import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { InFlightProvider, useInFlight } from './InFlightContext';
import { NetworkProvider, useNetwork } from './NetworkContext';

// Runtime network switch (docs/network-switch-plan.md). Covers:
//  - FULL DISCONNECT on switch: setNetwork bumps networkEpoch (session-wipe signal)
//    AND calls useWallet().disconnect (EVM connection dropped).
//  - BLOCK while in-flight: when a flow reports in-flight, setNetwork no-ops, the
//    config is NOT swapped, and switchBlocked (→ toggle disabled) is true.

const setActiveNetwork = vi.fn();
const disconnect = vi.fn();
// Bugbot HIGH: funder-agnostic persisted-cursor reader covering ALL resumable
// cursors (deposit-in / bid burn / return). Mutable so a test can simulate a
// stranded burn-but-not-resolved transfer with NO mounted flow. (The per-cursor
// coverage — which pmp.* keys count — is unit-tested against real localStorage in
// packages/bridge-core/src/core/*.test.ts; here we mock the aggregate.)
const anyInflightTransfer = { value: false };
// Bugbot MEDIUM: prod fence — DEV-only runtime switch. Mutable per test.
const switchEnabled = { value: true };
// Bugbot MEDIUM "Persisted network crashes mount": networks whose per-network env
// is unresolved make configFor(n) throw inside setActiveNetwork. A test sets this
// to simulate that (e.g. ['mainnet'] = mainnet env missing).
const throwForNetworks = { value: [] as string[] };

vi.mock('@polymarket-privacy/bridge-core', () => ({
  // Build-time default network — the switch flips AWAY from this.
  network: 'testnet',
  setActiveNetwork: (n: string) => {
    // Mirror configFor's fail-loud when a per-network required env var is unset.
    if (throwForNetworks.value.includes(n)) {
      throw new Error(`Config error: VITE_..._${n.toUpperCase()} is not set for network '${n}'`);
    }
    return setActiveNetwork(n);
  },
  hasAnyInflightTransfer: () => anyInflightTransfer.value,
  isNetworkSwitchEnabled: () => switchEnabled.value,
}));

vi.mock('@polymarket-privacy/bridge-core/react', () => ({
  useWallet: () => ({ disconnect }),
}));

// A probe that surfaces network state and lets the test drive setNetwork + the
// in-flight signal from within the provider tree.
function Probe() {
  const { network, networkEpoch, switchBlocked, setNetwork } = useNetwork();
  const { setFlowInFlight } = useInFlight();
  return (
    <div>
      <span data-testid="network">{network}</span>
      <span data-testid="epoch">{networkEpoch}</span>
      <span data-testid="blocked">{String(switchBlocked)}</span>
      <button onClick={() => setNetwork('mainnet')}>switch</button>
      <button onClick={() => setFlowInFlight('flow', true)}>start-flow</button>
      <button onClick={() => setFlowInFlight('flow', false)}>end-flow</button>
    </div>
  );
}

function renderTree() {
  return render(
    <InFlightProvider>
      <NetworkProvider>
        <Probe />
      </NetworkProvider>
    </InFlightProvider>,
  );
}

describe('NetworkProvider — runtime switch', () => {
  beforeEach(() => {
    setActiveNetwork.mockClear();
    disconnect.mockClear();
    anyInflightTransfer.value = false;
    switchEnabled.value = true;
    throwForNetworks.value = [];
    try {
      localStorage.removeItem('bridge.network');
    } catch {
      // ignore
    }
  });

  it('starts on the build-time default network', () => {
    renderTree();
    expect(screen.getByTestId('network').textContent).toBe('testnet');
    // Active config aligned to the default at mount.
    expect(setActiveNetwork).toHaveBeenCalledWith('testnet');
  });

  it('setNetwork switches, bumps networkEpoch (session wipe), and disconnects the wallet', () => {
    renderTree();
    const epochBefore = screen.getByTestId('epoch').textContent;
    fireEvent.click(screen.getByText('switch'));
    expect(screen.getByTestId('network').textContent).toBe('mainnet');
    expect(setActiveNetwork).toHaveBeenCalledWith('mainnet');
    // FULL DISCONNECT: wallet dropped + session-wipe epoch bumped.
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('epoch').textContent).not.toBe(epochBefore);
    // Persisted so a reload keeps the selected network.
    expect(localStorage.getItem('bridge.network')).toBe('mainnet');
  });

  it('BLOCKS the switch while a flow is in-flight (config unchanged, toggle disabled)', () => {
    renderTree();
    // A flow goes in-flight.
    act(() => {
      fireEvent.click(screen.getByText('start-flow'));
    });
    expect(screen.getByTestId('blocked').textContent).toBe('true');
    setActiveNetwork.mockClear();

    // Attempt to switch — must NO-OP.
    fireEvent.click(screen.getByText('switch'));
    expect(screen.getByTestId('network').textContent).toBe('testnet'); // unchanged
    expect(setActiveNetwork).not.toHaveBeenCalled(); // config NOT swapped
    expect(disconnect).not.toHaveBeenCalled(); // wallet NOT dropped

    // Flow settles → switching is unblocked again.
    act(() => {
      fireEvent.click(screen.getByText('end-flow'));
    });
    expect(screen.getByTestId('blocked').textContent).toBe('false');
    fireEvent.click(screen.getByText('switch'));
    expect(screen.getByTestId('network').textContent).toBe('mainnet');
  });

  // Bugbot HIGH — "Switch guard skips burn cursors": a persisted burn-but-not-
  // resolved CCTP cursor (deposit-in / bid burn / return) exists for SOME funder,
  // but NO flow is mounted (signed out / first render after connect). The OLD code
  // only blocked on anyInFlight (a MOUNTED flow's signal) + the deposit cursor, so a
  // stranded BURN/RETURN left the toggle ENABLED → setNetwork → disconnect() wiped
  // the resume cursor mid-transfer (stranded funds). The block must derive DIRECTLY
  // from the aggregate cursor read (hasAnyInflightTransfer), independent of mount.
  describe('any persisted transfer cursor blocks the switch even with NO mounted flow', () => {
    it('switchBlocked is true from a persisted cursor alone (no in-flight flow signal)', () => {
      anyInflightTransfer.value = true; // a stranded cursor exists for some funder
      renderTree();
      // No start-flow click → anyInFlight is false; the block comes from the cursor.
      expect(screen.getByTestId('blocked').textContent).toBe('true');
    });

    it('setNetwork NO-OPs and does NOT disconnect (cursor survives) while a cursor is persisted', () => {
      anyInflightTransfer.value = true;
      renderTree();
      fireEvent.click(screen.getByText('switch'));
      // Network unchanged, config NOT swapped, wallet NOT dropped → disconnect (which
      // would wipe pmp.inflight* cursors) never ran, so the resume cursor survives.
      expect(screen.getByTestId('network').textContent).toBe('testnet');
      expect(setActiveNetwork).not.toHaveBeenCalledWith('mainnet');
      expect(disconnect).not.toHaveBeenCalled();
    });
  });

  // Bugbot MEDIUM — "Persisted network crashes mount": a stale persisted network
  // whose per-network env is UNRESOLVED makes setActiveNetwork/configFor throw
  // during the useState initializer. The restore must be robust: fall back to the
  // build-time default, mount cleanly, and repair the bad persisted value.
  describe('persisted-network restore is robust (must never crash the mount)', () => {
    it('falls back to the default + clears the bad value when the persisted network THROWS', () => {
      localStorage.setItem('bridge.network', 'mainnet');
      throwForNetworks.value = ['mainnet']; // mainnet env unresolved → configFor throws
      // Must NOT throw during mount.
      expect(() => renderTree()).not.toThrow();
      // Mounted on the build-time default instead of the crashing persisted network.
      expect(screen.getByTestId('network').textContent).toBe('testnet');
      expect(setActiveNetwork).toHaveBeenCalledWith('testnet');
      // The bad persisted value is repaired so a reload doesn't crash again.
      expect(localStorage.getItem('bridge.network')).not.toBe('mainnet');
    });

    it('restores a persisted network normally when its env IS available', () => {
      localStorage.setItem('bridge.network', 'mainnet');
      throwForNetworks.value = []; // mainnet env resolves fine
      expect(() => renderTree()).not.toThrow();
      expect(screen.getByTestId('network').textContent).toBe('mainnet');
      expect(setActiveNetwork).toHaveBeenCalledWith('mainnet');
    });

    it('falls back to the default when the persisted value is CORRUPT', () => {
      localStorage.setItem('bridge.network', 'garbage-not-a-network');
      expect(() => renderTree()).not.toThrow();
      expect(screen.getByTestId('network').textContent).toBe('testnet');
      expect(setActiveNetwork).toHaveBeenCalledWith('testnet');
    });
  });

  // Bugbot MEDIUM — "Production RPC paths ignore network": in a prod build the
  // runtime switch is fenced off (both networks share one Starknet upstream). The
  // toggle is hidden and setNetwork no-ops.
  describe('prod fence — runtime switch disabled', () => {
    it('setNetwork no-ops in a prod build (switch disabled)', () => {
      switchEnabled.value = false;
      renderTree();
      fireEvent.click(screen.getByText('switch'));
      expect(screen.getByTestId('network').textContent).toBe('testnet'); // unchanged
      expect(setActiveNetwork).not.toHaveBeenCalledWith('mainnet');
      expect(disconnect).not.toHaveBeenCalled();
    });
  });
});
