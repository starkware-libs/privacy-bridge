// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

/**
 * Runtime network selection for apps/bridge.
 *
 * bridge-core's config is now RUNTIME-SWAPPABLE: `setActiveNetwork(n)` rebuilds
 * the active config (RPCs, CCTP domains, pool addresses, Polygon chain, the EVM
 * source registry) and the `config` Proxy makes every call site observe the swap.
 * This context is the app's single entry point for that swap.
 *
 * SAFETY:
 *   - FULL DISCONNECT on switch — the derived Starknet account is network-specific
 *     (ozClassHash / poolAddress differ). Switching fully
 *     disconnects the EVM wallet AND wipes the derived session (IdentityContext
 *     watches `networkEpoch`). The user reconnects + re-derives from scratch.
 *   - BLOCK while in-flight — a CCTP burn/mint or any resumable transfer must
 *     prevent switching (funds would strand). setNetwork no-ops when
 *     useInFlight().anyInFlight is true; the NavBar toggle is disabled + tooltip.
 *   - The confirm dialog is driven by the NavBar (the UI layer) before it calls
 *     setNetwork; setNetwork itself is the guarded, side-effecting primitive.
 *
 * Persistence: the chosen network is saved to localStorage['bridge.network'] and
 * re-applied on load (so a reload keeps the selected network). The wallet/session
 * are NOT persisted — a reload starts disconnected on the persisted network.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  network as buildNetwork,
  setActiveNetwork,
  hasAnyInflightTransfer,
  isNetworkSwitchEnabled,
} from '@starkware-libs/starknet-privacy-bridge';
import type { Network } from '@starkware-libs/starknet-privacy-bridge';
import { useWallet } from '@starkware-libs/starknet-privacy-bridge/react';
import { useInFlight } from './InFlightContext';

// Human-readable chain names shown in the UI.
export type NetworkProfile = {
  network: Network;
  starknetChain: string;
  polygonChain: string;
  polygonChainId: number;
};

const PROFILES: Record<Network, NetworkProfile> = {
  testnet: {
    network: 'testnet',
    starknetChain: 'Starknet Sepolia',
    polygonChain: 'Polygon Amoy',
    polygonChainId: 80002,
  },
  mainnet: {
    network: 'mainnet',
    starknetChain: 'Starknet Mainnet',
    polygonChain: 'Polygon',
    polygonChainId: 137,
  },
};

const STORAGE_KEY = 'bridge.network';

// Resolve the initial network: a persisted choice wins over the build-time
// default, so a reload keeps the last selected network. bridge-core's active
// config is aligned to it immediately (before any flow reads config).
// PROD FENCE (Bugbot MEDIUM): the switch is DEV-only, so in a prod build we IGNORE
// any persisted choice and pin to the build-time default — honoring a stale
// persisted network would (a) mismatch the prod endpoints (which don't vary by
// network) and (b) throw in setActiveNetwork's fence.
function initialNetwork(): Network {
  if (!isNetworkSwitchEnabled()) return buildNetwork;
  try {
    const persisted = localStorage.getItem(STORAGE_KEY);
    if (persisted === 'testnet' || persisted === 'mainnet') return persisted;
  } catch {
    // localStorage unavailable (SSR / privacy mode) — fall back to build default.
  }
  return buildNetwork;
}

export type NetworkContextValue = {
  profile: NetworkProfile;
  /** The currently active network. Convenience mirror of profile.network. */
  network: Network;
  /**
   * Bumped on every successful switch. IdentityContext (and any session-holding
   * context) watches this to WIPE derived keys/balances on a network change.
   */
  networkEpoch: number;
  /**
   * True while a switch is unsafe (fund-safety): a mounted flow is in-flight OR a
   * persisted burn-but-not-resolved CCTP cursor — deposit-in, bid burn, OR return —
   * exists for ANY funder (even signed-out). Switching disconnect()s and wipes ALL
   * resume cursors (pmp.*), so this blocks it.
   */
  switchBlocked: boolean;
  /**
   * Whether the runtime network switch is available at all. DEV-only: prod builds
   * point every network at the same Starknet RPC/prover/indexer upstream (no
   * per-network OHTTP infra), so the switch is fenced off and the toggle hidden.
   */
  switchEnabled: boolean;
  /**
   * Switch the active network. Returns false (no-op) when a flow is in-flight or
   * when `n` is already active. On success: aligns bridge-core's active config,
   * persists the choice, FULLY disconnects the wallet, and bumps networkEpoch
   * (session wipe). The caller (NavBar) drives the confirm dialog BEFORE calling.
   */
  setNetwork: (n: Network) => boolean;
};

const NetworkContext = createContext<NetworkContextValue | null>(null);

export function NetworkProvider({ children }: { children: ReactNode }) {
  const { disconnect } = useWallet();
  const { anyInFlight } = useInFlight();

  const [network, setNetworkState] = useState<Network>(() => {
    const n = initialNetwork();
    // Align bridge-core's active config to the persisted/default network at mount
    // so the very first flow read sees the right network (idempotent for default).
    // ROBUST RESTORE (Bugbot MEDIUM "Persisted network crashes mount"): a stale
    // persisted network whose per-network env is unresolved makes configFor(n)
    // throw here — which would crash the whole app on first render until someone
    // manually clears localStorage. Guard it: on failure, fall back to the
    // build-time default AND repair the bad persisted value so the app always
    // mounts (and a reload doesn't re-crash). We do NOT silently swallow — warn in
    // dev so a genuine misconfig is still visible.
    try {
      setActiveNetwork(n);
      return n;
    } catch (err) {
      if (n !== buildNetwork) {
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch {
          // Non-fatal — persistence is best-effort.
        }
        if (import.meta.env.DEV) {
          console.warn(
            `[NetworkContext] persisted network '${n}' failed to activate (likely ` +
              `unresolved per-network env); falling back to '${buildNetwork}' and ` +
              `clearing the persisted value.`,
            err,
          );
        }
        // The default network's config was already built (and fail-fast validated)
        // at bridge-core module load, so this alignment is safe.
        setActiveNetwork(buildNetwork);
        return buildNetwork;
      }
      // Even the build-time default failed — a genuine misconfig of the default
      // network's required env. Nothing to fall back to; re-throw (fail loud).
      throw err;
    }
  });
  const [networkEpoch, setNetworkEpoch] = useState(0);

  // FUND-SAFETY (Bugbot HIGH — "Switch guard skips burn cursors"): a persisted
  // burn-but-not-resolved CCTP cursor — a deposit-in (pmp.inflightDeposit), a bid
  // burn (pmp.inflightBurn), OR a return (pmp.inflightReturn) — is an in-flight
  // transfer that MUST block the switch even when NO flow is mounted and NO wallet
  // is connected — the toggle lives in the always-present NavBar. anyInFlight only
  // reflects MOUNTED flows (MoveIntoPool's setFlowInFlight), so we OR in a funder-
  // AGNOSTIC read of ALL THREE persisted cursor maps (hasAnyInflightTransfer; any
  // funder, no address needed). The earlier hasAnyInflightDeposit missed the burn/
  // return cursors, yet the switch's disconnect()→clearDeviceIdentity() wipes ALL
  // pmp.* — so a switch could strand a burn/return leg. Recomputed each render
  // (cheap synchronous localStorage reads) so a reload that lands signed-out with a
  // stranded cursor still disables the toggle.
  const hasStrandedTransfer = hasAnyInflightTransfer();
  const switchBlocked = anyInFlight || hasStrandedTransfer;

  const setNetwork = useCallback(
    (n: Network): boolean => {
      // PROD FENCE (Bugbot MEDIUM): the runtime switch is DEV-only — prod points
      // both networks at the same Starknet upstream. No-op so callers never reach
      // the throwing setActiveNetwork (belt-and-braces; the toggle is also hidden).
      if (!isNetworkSwitchEnabled()) return false;
      // FUND-SAFETY: never switch mid-flow. A CCTP burn/mint or resumable transfer
      // in progress would strand funds on the old network. Re-read ALL persisted
      // cursors (deposit/burn/return) at call time (authoritative — this is the
      // primitive that reaches disconnect()), independent of the memoized
      // render-time switchBlocked.
      if (anyInFlight || hasAnyInflightTransfer()) return false;
      if (n === network) return false;
      // Swap the framework-agnostic active config first, then the React state.
      setActiveNetwork(n);
      try {
        localStorage.setItem(STORAGE_KEY, n);
      } catch {
        // Non-fatal — persistence is best-effort.
      }
      setNetworkState(n);
      // FULL DISCONNECT: drop the EVM connection AND (via the epoch bump) the
      // derived session/identity/balances. User re-connects + re-derives.
      disconnect();
      setNetworkEpoch((e) => e + 1);
      return true;
    },
    [anyInFlight, network, disconnect],
  );

  const value = useMemo<NetworkContextValue>(
    () => ({
      profile: PROFILES[network],
      network,
      networkEpoch,
      switchBlocked,
      switchEnabled: isNetworkSwitchEnabled(),
      setNetwork,
    }),
    [network, networkEpoch, switchBlocked, setNetwork],
  );

  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}

export function useNetwork(): NetworkContextValue {
  const ctx = useContext(NetworkContext);
  if (!ctx) throw new Error('useNetwork must be used within NetworkProvider');
  return ctx;
}
