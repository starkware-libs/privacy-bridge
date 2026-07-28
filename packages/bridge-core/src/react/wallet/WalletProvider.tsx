import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  clearSelectedProvider,
  discoverProviders,
  getDiscoveredProviders,
  getEthereumProvider,
  hasMetaMask,
  injectedProviderCount,
  isSessionlessWalletConnect,
  requestAccounts,
  selectProvider,
  type EIP6963ProviderInfo,
} from './injectedProvider';
import { clearDeviceIdentity } from './device-store';
import {
  addressesEqual,
  clearWalletSession,
  readWalletSession,
  writeWalletSession,
} from './session-store';
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
  //
  // RESTORE (session-store.ts): "affirmative action THIS visit" made every page
  // refresh a re-click. The affirmative action is now scoped to the DEVICE+ACCOUNT
  // instead: a session the user entered here is recorded (public address + wallet
  // rdns, TTL-bounded) and re-entered on load — but ONLY after the wallet itself
  // re-confirms the SAME account through the SAME pinned wallet. A session we never
  // entered (e.g. a WC session the SDK rehydrated on its own) still gets the
  // strict gate: canResume, never auto-enter. `sessionRestored` tells consumers the
  // entry came from storage rather than a click, so nothing that needs a user
  // GESTURE (a `personal_sign` prompt) fires unsolicited on page load.
  const [authorizedAddress, setAuthorizedAddress] = useState<string | null>(null);
  const [sessionEntered, setSessionEntered] = useState(false);
  const [sessionRestored, setSessionRestored] = useState(false);
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
  // Once-per-mount guard for the restore effect below. Set SYNCHRONOUSLY before the
  // `eth_accounts` await so a re-render (or StrictMode's double-invoke) can't issue a
  // second read; the "still waiting for the wallet to announce" early-returns
  // deliberately leave it unset so the effect can retry when discovery changes.
  const restoreAttemptedRef = useRef(false);
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
  // True once the announce window below has closed, i.e. every installed extension
  // that was going to announce has. `injectedProviderCount()` is 0 at mount even
  // with two wallets installed, so any decision that leans on it being ACCURATE
  // (the restore effect's bare-global branch) must wait for this.
  const [discoverySettled, setDiscoverySettled] = useState(false);

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
      if (++passes >= 6) {
        clearInterval(interval);
        setDiscoverySettled(true);
      }
    }, 250);
    return () => {
      clearInterval(interval);
      window.removeEventListener('eip6963:announceProvider', refresh as EventListener);
    };
  }, []);

  // RESTORE the session this device explicitly entered, so a page refresh keeps the
  // wallet connected instead of dropping to "Resume session". Keyed on discovery +
  // the selection because EIP-6963 announcements (and WalletConnect's registration)
  // land asynchronously AFTER mount: the effect re-runs as wallets appear and only
  // proceeds once the recorded wallet is actually resolvable.
  //
  // The ORDER below is load-bearing; each step fails CLOSED:
  //   1. no recorded session          → nothing to restore (the strict gate holds).
  //   2. re-PIN the recorded wallet BEFORE touching any provider. Resolving
  //      `getEthereumProvider()` first would fall back to the bare window.ethereum
  //      global — whichever extension won the injection race — so a restore could
  //      enter (and later SIGN) through a wallet the user never picked, the
  //      wrong-wallet class PR #124 closed. If the recorded wallet hasn't announced
  //      (or is uninstalled) we WAIT, never fall back.
  //   3. the wallet re-confirms the account: `eth_accounts` must still answer the
  //      SAME address. A locked wallet / revoked permission answers `[]`; a switched
  //      account answers a different address. Neither restores — entering against
  //      another account would rehydrate the wrong identity.
  useEffect(() => {
    if (restoreAttemptedRef.current || sessionEnteredRef.current) return;
    const saved = readWalletSession();
    if (!saved) {
      restoreAttemptedRef.current = true;
      return;
    }
    if (saved.rdns) {
      if (selectedRdns !== saved.rdns) {
        // Pin it if it has announced; otherwise wait for the next discovery change.
        // Persist the registry's CANONICAL rdns, not the stored string — selectProvider
        // also resolves a uuid, and holding a uuid in `selectedRdns` would miss the
        // picker's highlight and re-persist the uuid on the next resume.
        const pinned = selectProvider(saved.rdns);
        if (pinned) setSelectedRdns(pinned.info.rdns);
        return;
      }
    } else {
      // Recorded against an unambiguous lone `window.ethereum`. `injectedProviderCount()`
      // reads 0 until wallets announce, so deciding now would restore against whichever
      // extension won the injection race — and once `sessionEntered` is true the silent
      // read's ambiguity guard is a permanent no-op (see there), so a transient
      // ambiguity would become a COMMITTED wrong-wallet session. Wait for the announce
      // window, then refuse if the global turns out to be contended (mirrors the silent
      // read and resumeSession). The record survives: a later visit where it is
      // unambiguous again can still restore.
      if (!discoverySettled) return;
      if (injectedProviderCount() > 1) {
        restoreAttemptedRef.current = true;
        return;
      }
    }
    const provider = getEthereumProvider();
    // Nothing resolvable yet, or a WC provider whose session hasn't rehydrated (it
    // throws on request() before connect()) — wait for discovery to change.
    if (!provider || isSessionlessWalletConnect(provider)) return;
    restoreAttemptedRef.current = true;
    // Snapshot the connect-attempt token: disconnect()/closeLoginModal() bump it, and a
    // restore resolving after either must not resurrect the session (the same
    // invalidation connect() uses — the restore is the other async writer of
    // sessionEntered, so it needs it too).
    const attempt = connectAttemptRef.current;
    void (async () => {
      let accounts: string[];
      try {
        accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
      } catch {
        // Provider error (dead port, transient RPC): don't restore, and do NOT drop
        // the record — a failed read is not evidence the wallet deauthorized us.
        // Release the once-guard so a later discovery change can retry.
        restoreAttemptedRef.current = false;
        return;
      }
      // Validate against the PROVIDER, not against "did a dep change". A dep change is
      // not staleness — `discoverySettled` flips at a fixed 1.5s and WalletConnect
      // registers whenever its dynamic import lands, so a read merely slower than that
      // (an MV3-suspended extension takes seconds) is still a perfectly good answer from
      // the same wallet. Cancelling on the dep change instead lost the restore for the
      // whole page load. What DOES invalidate the answer is the pin moving underneath it,
      // so compare provider identity and release the once-guard so the re-run can retry
      // against whatever is pinned now.
      if (getEthereumProvider() !== provider) {
        restoreAttemptedRef.current = false;
        return;
      }
      // Re-check the session at RESOLVE time: entering one through the ALREADY-pinned
      // wallet (connect('io.metamask'), or resumeSession()) changes none of this effect's
      // deps, so nothing else would stop a late restore from overwriting the clicked
      // session's address AND flipping sessionRestored true on it — which suppresses the
      // consumer's auto-derive, i.e. connected-but-keyless with no prompt. The attempt
      // token covers disconnect()/closeLoginModal() the same way it does for connect().
      if (sessionEnteredRef.current || connectAttemptRef.current !== attempt) return;
      const next = accounts?.[0] ?? null;
      if (next === null) {
        // Locked wallet / revoked permission — indistinguishable here, so don't restore.
        // KEEP the record: this is a fresh load with no session, the gate re-runs from
        // scratch next time, and a lock is transient. (Once a session IS live, an
        // `accountsChanged → []` clears it — see the listener effect.)
        return;
      }
      if (!addressesEqual(next, saved.address)) {
        // The wallet moved to a different account: forget the session so it can't keep
        // resurrecting, and fall back to the Connect/Resume gate. Entering here would
        // rehydrate the wrong identity.
        clearWalletSession();
        return;
      }
      setAuthorizedAddress(next);
      setSessionEntered(true);
      setSessionRestored(true);
      // UPGRADE a bare-global record to a pinned one when — and only when — the wallet we
      // just read from IS a discovered provider (compare the provider OBJECT, never "the
      // sole discovered entry": a wallet can announce while a different, non-announcing one
      // owns the global, and recording that rdns would re-point the session at the wrong
      // wallet). Without this, a record made through the no-picker resume stays on the
      // weaker branch forever and pays the announce-window wait on every load.
      const rdns =
        saved.rdns ?? getDiscoveredProviders().find((d) => d.provider === provider)?.info.rdns ?? null;
      // Pin the module too, not just the React state, so later requests route explicitly
      // instead of via the global. Resolves to the same object we just read from.
      if (rdns !== null && rdns !== selectedRdns) {
        selectProvider(rdns);
        setSelectedRdns(rdns);
      }
      // Slide the TTL: an actively-used device stays connected, an abandoned one ages out.
      writeWalletSession({ address: next, rdns });
      void readChainId(provider);
    })();
  }, [providers, selectedRdns, discoverySettled, readChainId]);

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
    if (isSessionlessWalletConnect(provider)) {
      setAuthorizedAddress(null);
      return;
    }
    // Guard against a stale in-flight read: if more wallets announce (the count
    // changes) while an eth_accounts read off the bare global is still pending,
    // this effect re-runs and `cancelled` drops the now-ambiguous result instead
    // of letting it overwrite the guard's null.
    let cancelled = false;
    // `cancelled` only covers a re-run/unmount; the pre-session check at the top of
    // this effect was evaluated at RUN time, so a read still in flight when the
    // session is entered (by connect() against a lone global, or by the restore
    // effect — neither changes this effect's deps, so no cleanup runs) would resolve
    // afterwards and clobber the entered address: to null → `address` null with
    // canResume ALSO false, a dead state with neither dashboard nor Resume CTA; or to
    // a different account → a silent identity re-key. Re-check at RESOLVE time.
    const stillPreSession = () => !cancelled && !sessionEnteredRef.current;
    void (async () => {
      try {
        const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
        if (stillPreSession()) setAuthorizedAddress(accounts[0] ?? null);
      } catch {
        if (stillPreSession()) setAuthorizedAddress(null);
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
      if (next === null) {
        setSessionEntered(false);
        // Forget the recorded session — a wallet-side revocation must not be resurrected
        // by the next page load. A LOCK reports the same empty array, so this deliberately
        // also forgets on a lock (one extra click) rather than guess: we fail closed on the
        // case we can't distinguish. Only while a session is LIVE, though: pre-session this
        // effect binds to the bare global, so a locked squatter extension must not wipe a
        // record belonging to a different wallet.
        if (sessionEnteredRef.current) clearWalletSession();
        return;
      }
      // Switched account: re-point the record at it (else the next load finds a
      // mismatch and drops the session), and stop reporting the session as restored —
      // the switch is a fresh wallet-side action, so consumers may prompt again.
      if (sessionEnteredRef.current) {
        setSessionRestored(false);
        writeWalletSession({ address: next, rdns: selectedRdns });
      }
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
      setSessionRestored(false);
      setChainId(null);
      clearWalletSession();
    };
    // EIP-1193 `disconnect` (#233): an injected provider becoming unavailable
    // (network disconnect, extension-side lock/reset) — without this listener
    // the SPA keeps showing a live session against a dead provider.
    const onDisconnect = () => {
      setAuthorizedAddress(null);
      setSessionEntered(false);
      setSessionRestored(false);
      setChainId(null);
      clearWalletSession();
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
        setSessionRestored(false);
        // Record the entered session so a refresh doesn't demand this click again.
        // Inside the isCurrent() guard on purpose: an ABANDONED attempt (WM-1) must
        // not persist a session the user cancelled.
        if (accounts[0]) writeWalletSession({ address: accounts[0], rdns: resolvedRdns });
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
    setSessionRestored(false);
    setError(null);
    // Same as connect(): record the entered session so the next load restores it.
    writeWalletSession({ address: authorizedAddress, rdns: selectedRdns });
    const provider = getEthereumProvider();
    if (provider) void readChainId(provider);
  }, [authorizedAddress, selectedRdns, openLoginModal, readChainId]);

  // Disconnect / "Forget this device": end the session AND wipe the persisted
  // pmp.* state (identity, derived accounts, indices, in-flight cursors) so the next visit
  // starts clean — no residual private metadata. The wallet authorization itself
  // is the user's to revoke in their wallet; we drop our copy. For WC sessions we
  // also tear down the relay session (best-effort) so the wc@2:* localStorage
  // entry can't silently rehydrate on the next visit.
  const disconnect = useCallback(() => {
    // Same invalidation as closeLoginModal: any in-flight connect() must not
    // resurrect the session after the user explicitly disconnected. (WM-1.)
    connectAttemptRef.current += 1;
    clearDeviceIdentity();
    // Explicit as well as via clearDeviceIdentity's key list: leaving the recorded
    // session behind would make "Forget this device" a no-op — the next load would
    // silently re-enter the session the user just forgot.
    clearWalletSession();
    setSessionEntered(false);
    setSessionRestored(false);
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
      sessionRestored,
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
      sessionRestored,
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
