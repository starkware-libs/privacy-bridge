import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  clearSelectedProvider,
  discoverProviders,
  getDiscoveredProviders,
  getEthereumProvider,
  hasMetaMask,
  injectedProviderCount,
  isSessionlessWalletConnect,
  isSyntheticProviderRdns,
  requestAccounts,
  selectProvider,
  type EIP6963ProviderInfo,
} from './injectedProvider';
import { clearDeviceIdentity, readWalletPick, writeWalletPick } from './device-store';
import { WalletContext } from './context';
import type { WalletContextValue } from './types';
import { resetWalletConnectProvider, registerWalletConnect } from './getWalletConnectProvider';
import { signMessage as ethSignMessage, type EthereumProvider } from './signMessage';

// Parse an `eth_chainId` result (hex string like "0x89") to a decimal id.
function parseChainId(raw: unknown): number | null {
  if (typeof raw === 'string') {
    const n = Number.parseInt(raw, 16);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return null;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  // CONNECT GATE — two distinct notions, deliberately separated:
  //   authorizedAddress: the account the wallet has ALREADY granted us (from a
  //     silent `eth_accounts` on mount / rehydrated session). Known internally,
  //     but NOT exposed downstream — knowing it must not reveal any private state.
  //   sessionEntered: the user has taken an affirmative action (Connect / Resume
  //     session) THIS visit. Only then does `address` go non-null, which is the
  //     value downstream contexts rehydrate from + the private balance auto-loads
  //     against. So on load we render a signed-out / "resume" state and never
  //     silently surface a returning user's private dashboard.
  const [authorizedAddress, setAuthorizedAddress] = useState<string | null>(null);
  const [sessionEntered, setSessionEntered] = useState(false);
  // Connect-attempt token: bumped on every close/disconnect so a still-in-flight
  // connect() whose awaits resume LATER can detect it was abandoned and bail
  // instead of silently flipping authorizedAddress / sessionEntered behind a
  // closed modal. (WM-1.) connect() snapshots this at entry; after each await,
  // if the live token has moved, the mutations are skipped. setIsConnecting and
  // selectedRdns are left alone — clearing isConnecting still runs in `finally`,
  // and the user's wallet pick stays selected for the next attempt.
  const connectAttemptRef = useRef(0);
  // Mirror of sessionEntered for the silent-read effect, which deliberately does
  // NOT depend on sessionEntered (re-running it would re-issue eth_accounts and
  // could clobber the connect()-set address). Reading the latest value via a ref
  // lets the ambiguity guard apply ONLY pre-session without re-subscribing.
  const sessionEnteredRef = useRef(sessionEntered);
  sessionEnteredRef.current = sessionEntered;
  const [chainId, setChainId] = useState<number | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  // rdns of the provider connect() is currently in flight for — lets the picker
  // label only that one button "Connecting…" (#134).
  const [connectingRdns, setConnectingRdns] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const metaMaskAvailable = hasMetaMask();

  // EIP-6963 multi-wallet state: the wallets that announced themselves (for the
  // picker) and the rdns of the one the user chose. The live provider objects
  // live in the injectedProvider module; we keep only the serializable `info` here.
  const [providers, setProviders] = useState<EIP6963ProviderInfo[]>([]);
  const [selectedRdns, setSelectedRdns] = useState<string | null>(null);

  // The downstream-visible address: gated behind an entered session. Until the
  // user explicitly enters, this is null, so the contexts treat the app as
  // signed-out (no identity rehydrate, no private-balance fetch).
  const address = sessionEntered ? authorizedAddress : null;

  const readChainId = useCallback(async (provider: EthereumProvider) => {
    // A session-less WC provider throws on any request() before connect() is
    // called. The fund-account leg already falls back to switchChain when chainId
    // is null, so skipping is safe here.
    if (isSessionlessWalletConnect(provider)) return;
    try {
      setChainId(parseChainId(await provider.request({ method: 'eth_chainId' })));
    } catch {
      // Non-fatal: leave chainId null (the fund-account leg falls back to switchChain).
    }
  }, []);

  // Kick off EIP-6963 discovery on mount and keep the picker list fresh as
  // wallets announce themselves. We poll the module snapshot briefly because
  // announcements arrive asynchronously right after `requestProvider`.
  useEffect(() => {
    discoverProviders();
    // Only setState when the announced set actually changed (avoids redundant
    // renders / act noise from the safety poll below).
    const refresh = () =>
      setProviders((prev) => {
        const next = getDiscoveredProviders().map((d) => d.info);
        if (prev.length === next.length && prev.every((p, i) => p.uuid === next[i]?.uuid)) {
          return prev;
        }
        return next;
      });
    refresh();
    window.addEventListener('eip6963:announceProvider', refresh as EventListener);
    // Register WalletConnect as a synthetic EIP-6963 entry once its provider
    // initialises (async, dynamic import). The `then(refresh)` re-snapshots the
    // registry so the WC button appears in the picker without a re-mount.
    void registerWalletConnect().then(refresh).catch(() => {});
    // Safety poll: a few quick passes in case an extension announces just before
    // our listener attached. Stops itself after the window closes.
    let passes = 0;
    const interval = setInterval(() => {
      refresh();
      if (++passes >= 6) clearInterval(interval);
    }, 250);
    return () => {
      clearInterval(interval);
      window.removeEventListener('eip6963:announceProvider', refresh as EventListener);
    };
  }, []);

  // Restore the REMEMBERED wallet pick as soon as that wallet announces itself. This is
  // what makes a reload cheap for a multi-wallet user: `selectedRdns` is per-page-load
  // state, so without a remembered pick the ambiguous-multi guard below refuses the silent
  // `eth_accounts` read whenever 2+ injected wallets are installed — `canResume` stays
  // false and the user is pushed back through the picker on EVERY reload, even though
  // nothing was ever revoked. Restoring pins the provider and sets the selection, which
  // re-runs the silent read against the right wallet.
  //
  // It cannot surface a wallet popup: nothing here calls `eth_requestAccounts` — the pick
  // is a local hint that only unblocks a silent read.
  //
  // Constraints: ONCE per page load (a later explicit pick must win, and this must never
  // fight the picker); pre-session only; only for a wallet still installed (selectProvider
  // no-ops on an unknown rdns, so an uninstalled wallet just leaves the picker); never a
  // synthetic entry (see isSyntheticProviderRdns). Keyed on `providers` so it retries as
  // extensions announce asynchronously after mount.
  const walletPickRestoredRef = useRef(false);
  useEffect(() => {
    if (walletPickRestoredRef.current || sessionEnteredRef.current || selectedRdns != null) return;
    const rdns = readWalletPick();
    if (!rdns || isSyntheticProviderRdns(rdns)) return;
    const detail = selectProvider(rdns);
    if (!detail) return; // not announced (yet, or uninstalled) — retry when the list changes
    walletPickRestoredRef.current = true;
    setSelectedRdns(detail.info.rdns);
  }, [providers, selectedRdns]);

  // Silent read of the already-authorized account for the SELECTED provider, so a
  // returning user can one-click "Resume session" — without entering the session
  // (the dual-gate at `address` holds, no private state revealed). Keyed on the
  // SELECTION and the discovered COUNT (so the ambiguous-multi guard below
  // re-evaluates when wallets announce asynchronously after mount). It is a strict
  // PRE-session affair: the early return below makes it a complete no-op once a
  // session is entered (see there). Skipped for a session-less WC provider (it
  // throws on request() before connect()).
  useEffect(() => {
    // This effect exists ONLY for pre-session `canResume` detection. Once a
    // session is entered, mid-session account changes are owned by the SEPARATE
    // `accountsChanged` listener effect, so the silent read must do nothing here:
    // re-running it (it's keyed on `providers.length`, which changes when a wallet
    // like WalletConnect registers mid-session) would re-issue `eth_accounts` and
    // clobber the address `connect()` set via `eth_requestAccounts` (some providers
    // answer the two differently). A no-op once the session is entered kills the
    // entire mid-session clear/clobber class. Read via a ref so the effect does NOT
    // depend on `sessionEntered` (depending on it would itself trigger a re-read).
    if (sessionEnteredRef.current) return;
    const provider = getEthereumProvider();
    if (!provider) return;
    // Ambiguous-multi guard: several wallets announced but the user hasn't PICKED
    // one, so getEthereumProvider() would fall back to the bare window.ethereum
    // global — whichever extension won the injection race. Don't silently read an
    // account off it (we can't tell which wallet it is); leave authorizedAddress
    // null so no auto-resume happens and the picker is required. A lone injected
    // global (0 or 1 INJECTED provider) is unambiguous and keeps the existing
    // fallback (the injected-E2E path relies on this). Counts only providers that
    // contend for window.ethereum — synthetic entries (WalletConnect) don't inject
    // into the global, so WC + one injected wallet stays unambiguous.
    if (injectedProviderCount() > 1 && selectedRdns == null) {
      setAuthorizedAddress(null);
      return;
    }
    // PENDING-PICK guard. A remembered wallet that hasn't announced yet is NOT the same as
    // "no preference": extensions announce asynchronously, so an early announcer can be the
    // lone discovered provider for a moment. Reading the bare global in that window would
    // attribute ANOTHER extension's account to this visit — and for a consumer that
    // auto-resumes on `canResume`, that silently enters a session as the WRONG wallet, after
    // which `sessionEnteredRef` blocks the restore below for the rest of the load. So hold
    // off until the remembered pick resolves (the restore sets `selectedRdns`, re-running
    // this effect). If that wallet is gone for good it simply never resolves and the picker
    // is required — the correct outcome after uninstalling the wallet you last used.
    const rememberedRdns = readWalletPick();
    if (selectedRdns == null && rememberedRdns && !isSyntheticProviderRdns(rememberedRdns)) {
      setAuthorizedAddress(null);
      return;
    }
    if (isSessionlessWalletConnect(provider)) {
      setAuthorizedAddress(null);
      return;
    }
    // Guard against a stale in-flight read: if more wallets announce (the count
    // changes) while an eth_accounts read off the bare global is still pending,
    // this effect re-runs and `cancelled` drops the now-ambiguous result instead
    // of letting it overwrite the guard's null.
    let cancelled = false;
    void (async () => {
      try {
        const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
        if (!cancelled) setAuthorizedAddress(accounts[0] ?? null);
      } catch {
        if (!cancelled) setAuthorizedAddress(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedRdns, providers.length]);

  // Wallet event listeners bound to the SELECTED provider. Keyed on the selection
  // AND `sessionEntered`: the latter is what binds listeners to a WC provider once
  // `connect()` has opened its session — at WC-selection time the provider is still
  // session-less (skipped below) and `selectedRdns` doesn't change again, so without
  // the sessionEntered dependency a phone-side accountsChanged/disconnect would go
  // unnoticed. This effect never reads `eth_accounts`, so re-running it can't clobber
  // the connected address (the bug that splitting it out of the silent read avoids).
  useEffect(() => {
    const provider = getEthereumProvider();
    if (!provider || isSessionlessWalletConnect(provider)) return;

    const onAccountsChanged = (accounts: unknown) => {
      const list = accounts as string[];
      const next = list[0] ?? null;
      setAuthorizedAddress(next);
      // If the wallet drops all accounts (locked / disconnected in the wallet, or a
      // WC phone-side disconnect), end the session too — nothing left to sign in to.
      if (next === null) setSessionEntered(false);
    };
    // The wallet reports chainChanged as the new hex chain id. Track it so the
    // fund-account orchestrator can verify the Polygon leg targets the expected chain.
    const onChainChanged = (next: unknown) => {
      setChainId(parseChainId(next));
    };
    // WC relay-side session termination (phone-side disconnect / TTL expiry). End
    // the session so the app drops back to signed-out instead of holding a dead
    // connection. (Injected providers don't emit these; a no-op listener is fine.)
    const onSessionEnded = () => {
      setAuthorizedAddress(null);
      setSessionEntered(false);
      setChainId(null);
    };
    // EIP-1193 `disconnect` (#233): an injected provider becoming unavailable
    // (network disconnect, extension-side lock/reset) — without this listener
    // the SPA keeps showing a live session against a dead provider.
    const onDisconnect = () => {
      setAuthorizedAddress(null);
      setSessionEntered(false);
      setChainId(null);
    };

    provider.on('accountsChanged', onAccountsChanged);
    provider.on('chainChanged', onChainChanged);
    provider.on('session_delete', onSessionEnded);
    provider.on('session_expire', onSessionEnded);
    provider.on('disconnect', onDisconnect);
    return () => {
      provider.removeListener('accountsChanged', onAccountsChanged);
      provider.removeListener('chainChanged', onChainChanged);
      provider.removeListener('session_delete', onSessionEnded);
      provider.removeListener('session_expire', onSessionEnded);
      provider.removeListener('disconnect', onDisconnect);
    };
  }, [selectedRdns, sessionEntered]);

  const openLoginModal = useCallback(() => {
    setError(null);
    setIsModalOpen(true);
  }, []);

  const closeLoginModal = useCallback(() => {
    // Invalidate any in-flight connect(): a later resolve/reject from the wallet
    // (the user approved AFTER closing) must not enter the session or write an
    // error onto a closed modal. (WM-1.)
    connectAttemptRef.current += 1;
    setIsModalOpen(false);
    setError(null);
  }, []);

  // Explicit connect (from the modal): pick the chosen wallet, prompt for
  // accounts, and ENTER the session. This is the affirmative action that reveals
  // the connected/private UI. Passing `rdnsOrUuid` selects that provider (injected
  // or the synthetic WalletConnect entry) so ALL subsequent requests route through
  // it (the multi-wallet pinning fix); omitting it uses the current selection /
  // window.ethereum fallback.
  const connect = useCallback(
    async (rdnsOrUuid?: string) => {
      let resolvedRdns = selectedRdns;
      if (rdnsOrUuid) {
        const detail = selectProvider(rdnsOrUuid);
        if (detail) {
          resolvedRdns = detail.info.rdns;
          setSelectedRdns(detail.info.rdns);
        }
      }
      // PIN the provider BEFORE requesting accounts: selectProvider (above) has
      // set the module selection, so getEthereumProvider() now returns the picked
      // provider rather than the bare window.ethereum global.
      const provider = getEthereumProvider();
      if (!provider) {
        setError('No EVM wallet detected. Install MetaMask from metamask.io or connect via WalletConnect, then refresh.');
        return;
      }

      setIsConnecting(true);
      setConnectingRdns(resolvedRdns);
      setError(null);
      // Snapshot the attempt token. closeLoginModal/disconnect bump the live ref,
      // so a post-await mismatch means this attempt was abandoned and we must NOT
      // mutate session state. (WM-1.)
      const attempt = connectAttemptRef.current;
      const isCurrent = () => connectAttemptRef.current === attempt;

      try {
        // WC requires connect() before any request(). For a session-less WC
        // provider this opens the built-in QR modal; the user scans + approves
        // from their mobile wallet. Injected providers skip this.
        //
        // We do NOT force a wallet_switchEthereumChain over WC: the optional
        // chains in init already enable Polygon/Amoy on the session, and many
        // mobile WC wallets don't implement the switch method over the session —
        // calling it strands the connection. The connected wallet only ever
        // produces personal_sign here; the Polygon legs run on the derived
        // per-account EOA, never this wallet, so its active chain is irrelevant.
        if (isSessionlessWalletConnect(provider)) {
          await (provider as EthereumProvider & { connect(): Promise<void> }).connect();
        }

        const accounts = await requestAccounts(provider);
        // Abandoned mid-connect (modal closed / disconnect called): drop the late
        // result on the floor instead of silently entering the session.
        if (!isCurrent()) return;
        setAuthorizedAddress(accounts[0] ?? null);
        setSessionEntered(accounts[0] != null);
        // Remember the wallet for the next visit — only after the wallet actually
        // authorized us, so a rejected/abandoned attempt never leaves a pick behind.
        // Synthetic entries are skipped for the same reason the restore skips them.
        if (accounts[0] != null && resolvedRdns && !isSyntheticProviderRdns(resolvedRdns)) {
          writeWalletPick(resolvedRdns);
        }
        await readChainId(provider);
        if (!isCurrent()) return;
        setIsModalOpen(false);
      } catch (err) {
        // Same guard for the rejection path: don't write an error onto a modal the
        // user has already closed.
        if (!isCurrent()) return;
        const message = err instanceof Error ? err.message : 'Failed to connect wallet';
        // Map an explicit user-cancel (declined the prompt / closed the WC modal) to
        // a friendly message. Match the cancel INTENT precisely — a bare "closed" or
        // "rejected" would also swallow relay/network failures ("WebSocket connection
        // closed", "request rejected: …") and mislabel them as a user cancel, hiding
        // the real error.
        if (
          /user rejected|user disapproved|user closed|closed modal|modal closed|connection request reset/i.test(
            message,
          )
        ) {
          setError('Connection request was rejected.');
        } else {
          setError(message);
        }
      } finally {
        // Always clear the connecting indicator — even for an abandoned attempt,
        // so a follow-up connect()/render doesn't see a stuck spinner.
        setIsConnecting(false);
        setConnectingRdns(null);
      }
    },
    [readChainId, selectedRdns],
  );

  // Resume session: the returning-user path. The wallet has already authorized
  // an account (known silently from eth_accounts), so entering the session needs
  // no wallet prompt — just the explicit click. This is what flips the app from
  // the signed-out/"resume" state to the connected dashboard.
  const resumeSession = useCallback(() => {
    // Ambiguous-multi guard (mirrors the silent read): with several INJECTED
    // wallets announced and none picked, refuse to resume against the bare global —
    // route to the picker so the user chooses which wallet to enter against,
    // rather than silently entering whichever won the window.ethereum race.
    // Synthetic entries (WalletConnect) don't contend for the global, so they're
    // excluded from the count (see injectedProviderCount).
    if (injectedProviderCount() > 1 && selectedRdns == null) {
      openLoginModal();
      return;
    }
    if (!authorizedAddress) {
      // No silently-authorized account to resume — fall back to a full connect.
      openLoginModal();
      return;
    }
    setSessionEntered(true);
    setError(null);
    const provider = getEthereumProvider();
    if (provider) void readChainId(provider);
  }, [authorizedAddress, selectedRdns, openLoginModal, readChainId]);

  // Disconnect / "Forget this device": end the session AND wipe the persisted
  // pmp.* state (identity, derived accounts, indices, in-flight cursors, and the
  // remembered wallet pick — so the next visit asks which wallet again instead of
  // silently resolving the old one) so the next visit starts clean — no residual private
  // metadata. The wallet authorization itself
  // is the user's to revoke in their wallet; we drop our copy. For WC sessions we
  // also tear down the relay session (best-effort) so the wc@2:* localStorage
  // entry can't silently rehydrate on the next visit.
  const disconnect = useCallback(() => {
    // Same invalidation as closeLoginModal: any in-flight connect() must not
    // resurrect the session after the user explicitly disconnected. (WM-1.)
    connectAttemptRef.current += 1;
    clearDeviceIdentity();
    setSessionEntered(false);
    setAuthorizedAddress(null);
    setChainId(null);
    setError(null);
    // Keep the discovered list (wallets are still installed) but drop the chosen
    // one so the next connect re-prompts the picker. Clear BOTH the React state
    // AND the module-level pin: leaving the module pin set would make
    // getEthereumProvider() keep PREFERRING the previously-picked provider, so a
    // bare connect()/sign after disconnect could route to the PREVIOUS wallet
    // while the UI shows no selection (wrong-wallet-routing — PR #124).
    setSelectedRdns(null);
    clearSelectedProvider();
    // Best-effort WC relay teardown + singleton RESET. Fire-and-forget — swallowed
    // internally. Resetting the singleton (not just disconnecting the session) is
    // required for the runtime network switch (which disconnect()s on switch): the
    // WC provider bakes buildRpcMap()'s Polygon RPC at init, so without a reset a
    // reconnect after the switch would keep the OLD network's rpcMap (Bugbot MEDIUM
    // "WC config stale after switch"). The next connect re-inits from the now-active
    // config. Harmless for a plain sign-out (re-inits with the same config).
    void resetWalletConnectProvider();
  }, []);

  const requireWallet = useCallback(() => {
    if (address) return true;
    openLoginModal();
    return false;
  }, [address, openLoginModal]);

  const signMessage = useCallback(
    async (message: string) => {
      const provider = getEthereumProvider();
      if (!provider) {
        throw new Error('No connected wallet to sign with.');
      }
      if (!address) {
        throw new Error('No connected wallet to sign with.');
      }
      return ethSignMessage(provider, address, message);
    },
    [address],
  );

  const getProvider = useCallback(
    (): EthereumProvider | undefined => getEthereumProvider(),
    [],
  );

  const value = useMemo<WalletContextValue>(
    () => ({
      providers,
      selectedRdns,
      address,
      chainId,
      isConnecting,
      connectingRdns,
      error,
      hasMetaMask: metaMaskAvailable,
      isModalOpen,
      isConnected: address !== null,
      // A returning user the wallet has already authorized, who has NOT yet
      // entered the session this visit — the app shows a "Resume session" CTA.
      canResume: !sessionEntered && authorizedAddress !== null,
      openLoginModal,
      closeLoginModal,
      connect,
      resumeSession,
      disconnect,
      requireWallet,
      signMessage,
      getProvider,
    }),
    [
      providers,
      selectedRdns,
      address,
      chainId,
      isConnecting,
      connectingRdns,
      error,
      metaMaskAvailable,
      isModalOpen,
      sessionEntered,
      authorizedAddress,
      openLoginModal,
      closeLoginModal,
      connect,
      resumeSession,
      disconnect,
      requireWallet,
      signMessage,
      getProvider,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
