/**
 * Minimal identity context for apps/bridge.
 *
 * Derives the Starknet account address from the wallet signature (in-memory only
 * — the raw signature is never logged or persisted). The signature is cached in
 * memory per-session: prompts personal_sign exactly once per tab/address unless
 * the user rejects or the address changes.
 *
 * NEVER log/persist the raw signature or the derived private key (code-style.md).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  BRIDGE_IDENTITY_SIGN_MESSAGE,
  deriveStarknetAccount,
  deriveStarknetPrivateKey,
  deriveViewingKey,
} from '@polymarket-privacy/bridge-core';
import { config } from '@polymarket-privacy/bridge-core';
import { useWallet } from '@polymarket-privacy/bridge-core/react';
import { useNetwork } from './NetworkContext';
import { useInFlight } from './InFlightContext';

export type DeriveStatus =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'error'; message: string }
  | { status: 'ready' };

export type IdentityContextValue = {
  /** Derived Starknet account address (null until signed). */
  snAddress: string | null;
  /**
   * Pool viewing key derived from the signature (null until signed). In-memory
   * only — a read-only capability (discovers notes, can't move funds). Wiped
   * alongside snAddress on address/network change. Consumers (usePrivateBalance)
   * read it here so nothing outside this context touches the raw signature.
   */
  viewingKey: bigint | null;
  deriveStatus: DeriveStatus;
  /** Prompt personal_sign and derive keys (idempotent). */
  deriveIdentity: () => Promise<void>;
  /**
   * Returns the cached signature, prompting personal_sign at most once.
   * Used by flow components that need the raw signature for bridge-core calls.
   * NEVER log/persist what this returns.
   */
  getSignature: () => Promise<string>;
};

const IdentityContext = createContext<IdentityContextValue | null>(null);

export function IdentityProvider({ children }: { children: ReactNode }) {
  const { address: evmAddress, signMessage, requireWallet } = useWallet();
  // A network switch fully disconnects (evmAddress → null) AND bumps networkEpoch.
  // We key the session-wipe effect on BOTH so the derived identity is cleared even
  // if a test/harness swaps the network without a real disconnect propagating.
  const { networkEpoch } = useNetwork();
  const { setFlowInFlight } = useInFlight();

  const [snAddress, setSnAddress] = useState<string | null>(null);
  // Viewing key mirrors snAddress: derived from the same signature, exposed on
  // the context (in-memory only, never persisted), wiped in the same reset.
  const [viewingKey, setViewingKey] = useState<bigint | null>(null);
  const [deriveStatus, setDeriveStatus] = useState<DeriveStatus>({ status: 'idle' });

  // In-memory signature cache. Cleared on unmount / address change.
  // Raw string — never logged, never persisted.
  const sigRef = useRef<string | null>(null);
  // In-flight sign promise: coalesces concurrent callers onto one personal_sign.
  const inflight = useRef<Promise<string> | null>(null);
  // The EVM address for which we cached the signature (detect account changes).
  const sigForAddress = useRef<string | null>(null);
  // Always-current address, readable from within an in-flight async closure
  // (evmAddress itself is a captured const per-render/per-callback-identity, so
  // comparing against it from inside the same closure would always be equal).
  const currentAddress = useRef<string | null>(evmAddress);
  useEffect(() => {
    currentAddress.current = evmAddress;
  }, [evmAddress]);
  // Always-current networkEpoch mirror, same rationale as currentAddress: a
  // deriveIdentity closure captures networkEpoch at call time, so comparing
  // against it from inside that same closure would always be equal. A network
  // switch bumps networkEpoch (and disconnects, wiping device identity) — a
  // derive that started before the switch must detect the bump and bail out of
  // its terminal writes, or it republishes snAddress/ready onto the freshly-
  // wiped, now-different-network identity (issue #193).
  const currentEpoch = useRef<number>(networkEpoch);
  useEffect(() => {
    currentEpoch.current = networkEpoch;
  }, [networkEpoch]);
  // Monotonic generation token for the in-flight registration. The reset effect
  // can force deriveStatus back to idle WHILE an earlier derive is still awaiting
  // personal_sign, so SessionEffect starts a SECOND derive — two runs overlap.
  // The in-flight flag is a single boolean per id, so the FIRST run to reach its
  // finally would clear the guard even though the second run is still pending
  // (a network switch could then proceed mid-derive). Each run bumps this token
  // and clears the flag ONLY if it is still the latest, so the newest run owns
  // the flag and clears it in its own finally (Bugbot: "Overlapping derive
  // clears switch guard"; boolean-vs-counter trap in code-style.md).
  const deriveGenRef = useRef(0);

  // Reset identity state whenever the connected EVM address changes (including
  // disconnect → evmAddress becomes null) OR the network is switched. This ensures
  // SessionEffect's auto-derive re-runs for the new account/network instead of
  // displaying stale keys — and on a network switch the derived SN account is wiped
  // (it is network-specific: ozClassHash/poolAddress differ).
  // Guard: do not reset while a derive for the CURRENT address is in-flight —
  // that is handled by the sigForAddress stale-cache check in getSignature.
  useEffect(() => {
    // Wipe signature cache so the next call to getSignature re-signs for the new address.
    sigRef.current = null;
    inflight.current = null;
    sigForAddress.current = null;
    // Reset displayed identity state back to idle for the new address/network.
    setSnAddress(null);
    setViewingKey(null);
    setDeriveStatus({ status: 'idle' });
  }, [evmAddress, networkEpoch]);

  const getSignature = useCallback(async (): Promise<string> => {
    if (!requireWallet()) throw new Error('Wallet not connected.');
    if (!evmAddress) throw new Error('No wallet address.');

    // Stale cache: address changed.
    if (sigForAddress.current !== evmAddress) {
      sigRef.current = null;
      inflight.current = null;
      sigForAddress.current = null;
    }

    if (sigRef.current) return sigRef.current;
    if (inflight.current) return inflight.current;

    // Coalesce: single personal_sign popup.
    const msg = BRIDGE_IDENTITY_SIGN_MESSAGE;
    const sign = async (): Promise<string> => {
      const sig = await signMessage(msg);
      // Cache in-memory only. Never write to localStorage or log.
      sigRef.current = sig;
      sigForAddress.current = evmAddress;
      inflight.current = null;
      return sig;
    };
    inflight.current = sign();
    return inflight.current;
  }, [evmAddress, signMessage, requireWallet]);

  const deriveIdentity = useCallback(async () => {
    if (deriveStatus.status === 'pending') return;
    // Capture the address AND network epoch this derive is FOR. getSignature()
    // awaits the wallet popup, which can take arbitrarily long — if the
    // connected address changes (or disconnects) OR the network is switched
    // while we're waiting, the reset effect above already cleared
    // snAddress/deriveStatus back to idle for the new account/network. Without
    // this guard, a signature that resolves late for the OLD address/network
    // would still land here and stomp the fresh idle state with the stale
    // derived SN address (Bugbot: "Stale derive after wallet switch" / #193
    // "Stale derive after network switch").
    const requestedFor = evmAddress;
    const requestedEpoch = networkEpoch;
    const stale = (): boolean =>
      currentAddress.current !== requestedFor || currentEpoch.current !== requestedEpoch;
    setDeriveStatus({ status: 'pending' });
    // FUND-SAFETY: block a network switch while a derive is pending, mirroring
    // how MoveIntoPool/MoveFromPool register their CCTP legs (InFlightContext).
    // A switch mid-derive would disconnect + wipe device identity out from under
    // this run. Take ownership of the flag with a fresh generation token so an
    // OLDER overlapping run that finishes first cannot drop it (see deriveGenRef).
    const myGen = ++deriveGenRef.current;
    setFlowInFlight('deriveIdentity', true);
    try {
      const sig = await getSignature();
      if (stale()) return; // stale — address or network changed mid-sign.
      const pk = deriveStarknetPrivateKey(sig);
      const { address } = deriveStarknetAccount(pk, config.ozClassHash);
      // Viewing key from the same signature (in-memory only — read-only note
      // discovery capability, never persisted; never log the signature).
      const vk = deriveViewingKey(sig);
      if (stale()) return; // re-check post-derive for safety.
      setSnAddress(address);
      setViewingKey(vk);
      setDeriveStatus({ status: 'ready' });
    } catch (err) {
      if (stale()) return; // stale — don't surface a stale error either.
      const message = err instanceof Error ? err.message : 'Failed to derive identity.';
      setDeriveStatus({ status: 'error', message });
    } finally {
      // Clear the in-flight flag ONLY if this run is still the latest. An older
      // overlapping run that finishes first must NOT drop the guard — the newer
      // run (which bumped deriveGenRef) owns it and clears it in its own finally.
      if (deriveGenRef.current === myGen) setFlowInFlight('deriveIdentity', false);
    }
  }, [deriveStatus.status, getSignature, evmAddress, networkEpoch, setFlowInFlight]);

  const value = useMemo<IdentityContextValue>(
    () => ({ snAddress, viewingKey, deriveStatus, deriveIdentity, getSignature }),
    [snAddress, viewingKey, deriveStatus, deriveIdentity, getSignature],
  );

  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>;
}

export function useIdentity(): IdentityContextValue {
  const ctx = useContext(IdentityContext);
  if (!ctx) throw new Error('useIdentity must be used within IdentityProvider');
  return ctx;
}
