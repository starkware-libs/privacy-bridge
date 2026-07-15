/**
 * Move Into Pool flow: EVM wallet → CCTP burn → Starknet privacy pool.
 * Calls the moveIntoPool orchestrator (bridge-core) via the WC provider — it
 * funds (CCTP deposit-in), deploys, registers, and DEPOSITS into the pool.
 *
 * Amount semantics (mirrors MoveFromPool): the amount field is the NET the
 * user wants credited into the pool. The CCTP burn uses the GROSS
 * (estimate.plan.fundMicro = net + CCTP fee, plus the shared estimate's
 * swap-slippage reserve / cushion) so that after CCTP's forwarding-fee
 * deduction, the pool receives (at least) the labeled net.
 *
 * SUCCESS IS NOT ACCEPTANCE — but the discriminator is the orchestrator's own
 * `deposited` flag (true iff depositToPool ran THIS run), NOT a balance-delta read.
 * A delta read races the indexer and fails open on a failed discovery call, so it
 * could mislabel a REAL landed deposit as a no-op (Bugbot HIGH #239). We keep the
 * pre/post read ONLY to choose the DISPLAYED amount (measured delta if positive,
 * else depositedNetWei); it can never turn a real deposit into the no-op notice.
 *
 * LIVE-VERIFICATION BOUNDARY: the cross-chain CCTP burn → attest → mint →
 * depositToPool can only be confirmed against live CCTP + pool infra. Everything
 * before the burn is verifiable offline; the mint step requires the relay.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  moveIntoPool,
  hasInflightDeposit,
  config,
  deriveStarknetAccount,
  deriveStarknetPrivateKey,
  deriveViewingKey,
  discoverPrivateBalanceForAddress,
  humanizeError,
  EVM_CCTP_SOURCES,
} from '@starkware-libs/starknet-privacy-bridge';
import type { EthereumProvider } from '@starkware-libs/starknet-privacy-bridge/react';
import {
  useWallet,
  useBridgeFundingEstimate,
} from '@starkware-libs/starknet-privacy-bridge/react';
import { useIdentity } from '../IdentityContext';
import { useNetwork } from '../NetworkContext';
import { useInFlight } from '../InFlightContext';
import { useBridgeResume, isPendingPoolDeposit } from '../useBridgeResume';
import { USDC_DECIMALS, parseUsdcAmount } from '../amount';
import { styles } from './styles';
import { SourceChainPicker } from './SourceChainPicker';
import { ResumeBanner } from './ResumeBanner';

type FlowStatus =
  | { phase: 'idle' }
  | { phase: 'signing' }
  | { phase: 'running'; message: string }
  | { phase: 'done'; netAmountHuman: string; deposited: boolean }
  | { phase: 'error'; message: string };

export function MoveIntoPool() {
  const { address: evmAddress, getProvider, chainId, isConnected } = useWallet();
  const { getSignature, snAddress, deriveIdentity, deriveStatus } = useIdentity();
  const { profile, networkEpoch } = useNetwork();

  const { setFlowInFlight } = useInFlight();

  const [amountInput, setAmountInput] = useState('');
  const [status, setStatus] = useState<FlowStatus>({ phase: 'idle' });
  // Run-generation counter (BUG-1 class): moveIntoPool is a long async leg awaited
  // INSIDE handleSubmit, so its terminal setStatus fires from a still-running closure
  // that can resolve AFTER an A→B account switch. App.tsx renders <MoveIntoPool/> with
  // NO key, so an A→null→B identity flip does NOT remount it — status survives. Without
  // a gate, a stale run repaints A's deposited amount / step under B's identity header
  // (a same-user display glitch, but the exact asymmetry MoveFromPool was hardened for).
  // handleSubmit captures runGenRef.current at start; the genuine-switch effect below
  // bumps it, so every gated write from a superseded run becomes a FULL no-op.
  const runGenRef = useRef(0);

  // Source-chain picker: seeded to the wallet's current chain if it is a supported
  // CCTP source, else falls back to config.cctp.defaultEvmSourceChainId.
  const [sourceChainId, setSourceChainId] = useState<number>(config.cctp.defaultEvmSourceChainId);
  // Set the instant the user changes the picker; the seed-from-wallet effect below
  // must never clobber a manual pick with a late `eth_chainId` reply.
  const userPickedRef = useRef(false);
  useEffect(() => {
    const provider = getProvider();
    if (!provider) return;
    let cancelled = false;
    provider
      .request({ method: 'eth_chainId' })
      .then((hex) => {
        if (cancelled) return; // superseded — never apply.
        if (userPickedRef.current) return; // user already picked — don't clobber.
        const chainId = Number(hex as string);
        setSourceChainId(
          EVM_CCTP_SOURCES[chainId] !== undefined ? chainId : config.cctp.defaultEvmSourceChainId,
        );
      })
      .catch(() => {
        // Tolerate failures (e.g. no wallet connected) — keep the default.
      });
    return () => {
      cancelled = true;
    };
    // getProvider is a stable useCallback; re-run on a late wallet connect AND on a
    // wallet-driven chain switch (chainId/isConnected), mirroring DepositModal — so
    // a MetaMask network change without a manual pick re-seeds the picker (#198).
  }, [getProvider, evmAddress, chainId, isConnected]);

  // Reset the picker on a testnet↔mainnet swap (networkEpoch bump): EVM_CCTP_SOURCES
  // is network-scoped, so a chain id picked on the old network (e.g. a testnet chain)
  // is no longer a valid source after the swap — it would show a broken value and
  // throw "unsupported CCTP source" at submit. Fall back to the new network's default
  // and clear the manual-pick flag so the seed effect can re-seed (#198 / Bugbot).
  useEffect(() => {
    userPickedRef.current = false;
    setSourceChainId(config.cctp.defaultEvmSourceChainId);
  }, [networkEpoch]);

  // The supported CCTP sources for the picker + the currently-selected one (for the
  // header). EVM_CCTP_SOURCES is network-scoped, so this tracks the active network.
  const sourceOptions = Object.values(EVM_CCTP_SOURCES).map((s) => ({
    chainId: s.chainId,
    chainName: s.chainName,
  }));
  const selectedSource = EVM_CCTP_SOURCES[sourceChainId];

  const amountWei = parseUsdcAmount(amountInput);
  const estimate = useBridgeFundingEstimate(amountWei, USDC_DECIMALS, sourceChainId);

  // Resume/recovery: detect an interrupted INTO-pool transfer (pool-deposit /
  // cctp-mint-in / return-to-pool) for this identity and auto-continue it instead of
  // showing the normal action. needsSignature is false for these, so it self-resumes;
  // the into-pool composite structurally needs the EVM provider even though no NEW
  // signature is requested (moveIntoPool resolves the funder through it).
  const resume = useBridgeResume({
    direction: 'into-pool',
    snAddress: snAddress ?? undefined,
    evmAddress: evmAddress ?? undefined,
    epoch: networkEpoch,
    getSignature,
    getProvider: () => {
      try {
        return getProvider();
      } catch {
        return undefined;
      }
    },
  });

  const handleSubmit = useCallback(async () => {
    if (!evmAddress) return;
    // Capture this run's generation. Gate EVERY shared-state write below on it so a run
    // superseded by an account/network switch mid-flight is a FULL no-op (BUG-1).
    const runGen = runGenRef.current;
    const commit = (next: FlowStatus) => {
      if (runGenRef.current === runGen) setStatus(next);
    };
    // Require the estimate to be ready so we have the gross burn amount
    // (mirrors MoveFromPool: never burn the bare typed net).
    if (estimate.status !== 'ready') {
      commit({ phase: 'error', message: 'Enter a valid amount.' });
      return;
    }
    // grossAmount is what gets burned via CCTP (net + fee + reserve/cushion).
    // fundFromMetaMask mints `grossAmount - maxFee` on Starknet, so the pool
    // receives (at least) the labeled net. Single source of truth: estimate.plan.
    const grossAmount = estimate.plan.fundMicro;

    commit({ phase: 'signing' });

    let sig: string;
    try {
      sig = await getSignature();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Signature rejected.';
      commit({ phase: 'error', message });
      return;
    }

    const pk = deriveStarknetPrivateKey(sig);
    const { address: snRecipient } = deriveStarknetAccount(pk, config.ozClassHash);
    // Read-only capability (can discover notes, can't move funds) — used to measure the
    // in-pool balance before/after so success is gated on a real deposit, not acceptance.
    const viewingKey = deriveViewingKey(sig);

    // Trigger identity (for display), non-blocking — we already have the sig above.
    if (deriveStatus.status === 'idle') void deriveIdentity();

    let provider: EthereumProvider | undefined;
    try {
      provider = getProvider();
    } catch {
      commit({ phase: 'error', message: 'Could not reach the wallet provider.' });
      return;
    }
    if (!provider) {
      commit({ phase: 'error', message: 'Wallet provider unavailable.' });
      return;
    }

    commit({ phase: 'running', message: 'Starting bridge…' });
    // NOTE: the in-flight guard below keys off the CCTP deposit cursor (written by
    // fundFromMetaMask inside moveIntoPool). The separate pool-deposit-cursor window
    // (burn landed, pool deposit not yet confirmed) is a known small gap — follow-up.
    try {
      // Pre-read the in-pool balance ONLY to pick the displayed amount (measured delta
      // if positive). It must NOT gate success — that is `deposited` below.
      const before = await discoverPrivateBalanceForAddress({ snAddress: snRecipient, viewingKey }).catch(
        () => null,
      );
      const { depositedNetWei, deposited } = await moveIntoPool({
        signature: sig as `0x${string}`,
        funding: 'metamask', // DELIBERATE: match the EVM-wallet/CCTP UX (not config.depositFunding, which defaults to 'treasury').
        // Burn the GROSS (net + fee + reserve) — matches "Bridge reserve" shown in the UI.
        amountWei: grossAmount,
        provider,
        sourceChainId,
        onStep: (step, stepStatus, detail) => {
          if (stepStatus === 'error') return; // authoritative error rides the throw
          const label = step.charAt(0).toUpperCase() + step.slice(1);
          commit({ phase: 'running', message: detail ? `${label}: ${detail}` : `${label}…` });
        },
      });
      // Post-read the balance ONLY to prefer the MEASURED delta as the displayed amount.
      // If either read failed/lagged, fall back to depositedNetWei — a failed read must
      // never suppress the "Deposited" confirmation when `deposited` is true (Bugbot HIGH
      // #239: success is gated on the orchestrator's `deposited`, not on a racy delta).
      const after = await discoverPrivateBalanceForAddress({ snAddress: snRecipient, viewingKey }).catch(
        () => null,
      );
      const delta = before != null && after != null ? after - before : null;
      const shownWei = delta != null && delta > 0n ? delta : depositedNetWei;
      commit({
        phase: 'done',
        // Display-only: deposited total shown to the nearest cent (2 dp).
        netAmountHuman: (Number(shownWei) / 10 ** USDC_DECIMALS).toFixed(2),
        deposited,
      });
    } catch (err) {
      // A run superseded by an account/network switch must be a FULL no-op — never
      // repaint the old identity's Continue affordance or error under the new one.
      if (runGenRef.current !== runGen) return;
      // Backstop: a pending pool-deposit cursor was detected mid-submit. bridge-core
      // failed CLOSED (rather than silently depositing the leftover) — convert it into
      // the Continue affordance by re-reading the cursors, not a raw error.
      if (isPendingPoolDeposit(err)) {
        commit({ phase: 'idle' });
        resume.recheck();
        return;
      }
      // Humanize known SDK/RPC/relayer signatures (e.g. a transient AVNU code-156
      // gateway error) into actionable copy instead of a raw dump; unknown errors fall
      // through to their sanitized text.
      const message = err instanceof Error ? humanizeError(err) : 'Bridge failed.';
      commit({ phase: 'error', message });
    }
  }, [
    evmAddress,
    getSignature,
    estimate,
    getProvider,
    sourceChainId,
    deriveStatus.status,
    deriveIdentity,
    resume,
  ]);

  // Cross-account / network safety (BUG-1 class): a run's status belongs to the account
  // + network that started it. On a GENUINE switch — a real account switch (a previously-
  // derived non-null identity → a DIFFERENT non-null identity) or a network switch
  // (networkEpoch bump) — bump the run generation so an in-flight moveIntoPool can never
  // repaint the prior account's deposited amount / step, and reset the visible status to
  // idle. Mirrors MoveFromPool's reset effect: do NOT reset on the FIRST null→derived
  // derive (deriveIdentity flips snAddress null→derived AFTER a submit that only called
  // getSignature) nor on a derived→null disconnect — neither is a switch to another
  // account. Anchor only on REAL identities so disconnect→reconnect-as-other still resets.
  const prevSnAddressRef = useRef(snAddress);
  const prevNetworkEpochRef = useRef(networkEpoch);
  useEffect(() => {
    const prevSn = prevSnAddressRef.current;
    const networkSwitched = prevNetworkEpochRef.current !== networkEpoch;
    const identitySwitched = prevSn != null && snAddress != null && prevSn !== snAddress;
    if (snAddress != null) prevSnAddressRef.current = snAddress;
    prevNetworkEpochRef.current = networkEpoch;
    if (!networkSwitched && !identitySwitched) return;
    // Supersede any in-flight run so its terminal writes become a full no-op, then
    // clear the stale display back to idle (the normal form for the new identity).
    runGenRef.current += 1;
    setStatus((s) => (s.phase === 'idle' ? s : { phase: 'idle' }));
  }, [snAddress, networkEpoch]);

  const isRunning = status.phase === 'signing' || status.phase === 'running';
  // FUND-SAFETY (MEDIUM-1): a network switch must be blocked not only while THIS
  // component is actively signing/running, but also whenever a PERSISTED CCTP
  // deposit cursor survives for the connected funder — a burn-but-not-yet-minted
  // transfer that outlives a reload (fundFromMetaMask persists it after the burn,
  // before attest/mint). Without this, a reload lands here in `idle`, reports NOT
  // in-flight, re-enables the toggle, and a switch would resume the mint against
  // the WRONG-network transmitter/domain (misrouted/stuck funds). We OR the live
  // run state with the persisted-cursor read, re-checking on mount, whenever the
  // funder changes, and after each flow settles (a successful mint clears the
  // cursor → flips back to not-in-flight). Clears on unmount.
  const hasPersistedDeposit = evmAddress ? hasInflightDeposit(evmAddress) : false;
  // Also block a network switch while a resumable transfer is DETECTED or resuming —
  // this covers the pool-deposit-cursor window (burn landed, deposit not yet confirmed)
  // that hasInflightDeposit alone does not, closing the gap noted above.
  const hasResumable = resume.status !== null || resume.resuming;
  useEffect(() => {
    setFlowInFlight('moveIntoPool', isRunning || hasPersistedDeposit || hasResumable);
    return () => setFlowInFlight('moveIntoPool', false);
  }, [isRunning, hasPersistedDeposit, hasResumable, setFlowInFlight]);
  // Also require estimate.status === 'ready' so submit is only active once we
  // have the gross burn amount (mirrors MoveFromPool).
  const canSubmit = !isRunning && estimate.status === 'ready' && !!evmAddress;

  return (
    <div style={styles.card}>
      <div style={styles.cardTitle}>Move Into Pool</div>
      <p style={{ ...styles.muted, marginBottom: '0.75rem' }}>
        Source: <strong>{selectedSource?.chainName ?? profile.polygonChain}</strong>
        {selectedSource ? ` (chainId ${selectedSource.chainId})` : ''} → Starknet privacy pool
      </p>

      {/* SN address display */}
      {snAddress && (
        <div style={{ ...styles.muted, fontFamily: 'monospace', marginBottom: '0.75rem', wordBreak: 'break-all' }}>
          Starknet pool account: {snAddress}
        </div>
      )}

      {/* Resume/recovery: an interrupted transfer for this identity HIDES the normal
          action and continues the stuck one. needsSignature is false today, so it
          auto-resumes; a manual Continue is the fallback if auto-resume errors (and
          the affordance a future needsSignature===true phase would use). */}
      {resume.status ? (
        <ResumeBanner resume={resume} />
      ) : (
        <>
      {/* Persistent confirmation that a RESUMED transfer finished — so "done" is
          visually distinct from "nothing was pending" (the blank form). Gated to idle
          so it hides the moment a new deposit starts; cleared by the hook on an
          identity/network change. */}
      {resume.completed && status.phase === 'idle' && (
        <div style={{ ...styles.statusBox('success'), marginBottom: '0.75rem' }}>
          ✓ Interrupted deposit completed — your funds are now in the pool.
        </div>
      )}
      <label style={styles.label}>Amount (USDC)</label>
      <input
        style={styles.input}
        type="number"
        min="0"
        step="0.01"
        value={amountInput}
        onChange={(e) => setAmountInput(e.target.value)}
        placeholder="e.g. 1.00"
        disabled={isRunning}
      />

      {/* Source-chain picker (CCTP burn origin) — custom dropdown so each chain shows
          its brand icon (a native <select> can't render per-option icons). */}
      <label style={styles.label}>Source chain</label>
      <SourceChainPicker
        value={sourceChainId}
        options={sourceOptions}
        disabled={isRunning}
        onChange={(id) => {
          userPickedRef.current = true;
          setSourceChainId(id);
        }}
      />
      <p style={styles.muted}>You pay a small network fee on the selected chain.</p>

      {/* Funding estimate */}
      {estimate.status === 'loading' && (
        <p style={styles.muted}>Estimating bridge reserve…</p>
      )}
      {estimate.status === 'ready' && (
        <div style={{ marginBottom: '0.5rem' }}>
          <div style={styles.estimateRow}>
            <span>Bridge reserve</span>
            <span>{estimate.fundHuman.toFixed(2)} USDC</span>
          </div>
          <div style={styles.estimateRow}>
            <span>CCTP fee</span>
            <span>~{estimate.feeHuman.toFixed(6)} USDC</span>
          </div>
          {estimate.belowFloor && (
            <p style={{ ...styles.muted, color: '#f59e0b' }}>
              Amount below CCTP fee floor — increase the amount.
            </p>
          )}
        </div>
      )}
      {estimate.status === 'error' && (
        <p style={{ ...styles.muted, color: '#ef4444' }}>Estimate error: {estimate.message}</p>
      )}

      <button
        onClick={() => void handleSubmit()}
        disabled={!canSubmit}
        style={canSubmit ? styles.primaryBtn : styles.disabledBtn}
      >
        {status.phase === 'signing'
          ? 'Waiting for signature…'
          : status.phase === 'running'
            ? 'Bridging…'
            : 'Move Into Pool'}
      </button>

      {/* Status feedback */}
      {status.phase === 'running' && (
        <div style={styles.statusBox('info')}>{status.message}</div>
      )}
      {status.phase === 'done' &&
        (status.deposited ? (
          <div style={styles.statusBox('success')}>
            Deposited {status.netAmountHuman} USDC into the pool.
          </div>
        ) : (
          <div style={styles.statusBox('info')}>
            Already deposited in a previous attempt — nothing new was moved.
          </div>
        ))}
      {status.phase === 'error' && (
        <div style={styles.statusBox('error')}>{status.message}</div>
      )}
        </>
      )}
    </div>
  );
}
