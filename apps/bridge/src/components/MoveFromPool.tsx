// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

/**
 * Move From Pool flow: Starknet privacy pool → CCTP burn → arbitrary EVM destination.
 * Calls bridgeOutToWallet (bridge-core/bridgeOut) using the in-memory signature.
 *
 * Amount semantics: the amount field is the NET the user wants at the destination.
 * "Total to withdraw" (fundHuman) = net + CCTP fee. The pool burn uses the GROSS
 * (fundMicro) so that CCTP deductions leave exactly the labeled net at destination.
 *
 * LIVE-VERIFICATION BOUNDARY: the withdraw + CCTP burn → attest → mint
 * can only be confirmed against live CCTP infra + the SN prover.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  bridgeOutToWallet,
  isAnonymizerConfigured,
  config,
  EVM_CCTP_DESTINATIONS,
  waitForForwardedMint,
} from '@starkware-libs/starknet-privacy-bridge';
import { useWallet, useBridgeFundingEstimate } from '@starkware-libs/starknet-privacy-bridge/react';
import { useIdentity } from '../IdentityContext';
import { useNetwork } from '../NetworkContext';
import { useInFlight } from '../InFlightContext';
import { useBridgeResume } from '../useBridgeResume';
import { USDC_DECIMALS, parseUsdcAmount } from '../amount';
import { styles } from './styles';
import { SourceChainPicker } from './SourceChainPicker';
import { ResumeBanner } from './ResumeBanner';

type FlowStatus =
  | { phase: 'idle' }
  | { phase: 'signing' }
  | { phase: 'running'; message: string }
  // Burn submitted; Circle's Forwarding Service is attesting + minting to the
  // destination FOR US. `message` is the live Iris poll status; `slow` softens the
  // copy once the poll times out (the forward still completes Circle-side).
  | { phase: 'delivering'; burnTx: string; destination: string; destChainId: number; message: string; slow: boolean }
  // Forwarded mint landed — Iris reported the destination `forwardTx`.
  | { phase: 'delivered'; burnTx: string; destination: string; destChainId: number; forwardTx: string }
  | { phase: 'error'; message: string };

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// Voyager tx URL for the Starknet burn — Circle has no public per-tx CCTP status page,
// so the burn (source) explorer + the dest-chain mint explorer are the real "follow it"
// links. Network-scoped: mainnet vs Sepolia.
function snTxUrl(network: string, tx: string): string {
  const base = network === 'mainnet' ? 'https://voyager.online' : 'https://sepolia.voyager.online';
  return `${base}/tx/${tx}`;
}
// Dest-chain explorer tx URL for the forwarded mint (once Circle lands it), or null when
// the chosen destination has no configured explorer.
function evmTxUrl(dest: { blockExplorerUrls?: string[] } | undefined, tx: string): string | null {
  const base = dest?.blockExplorerUrls?.[0];
  return base ? `${base.replace(/\/+$/, '')}/tx/${tx}` : null;
}

const txLinkStyle: CSSProperties = { color: '#3b82f6', textDecoration: 'underline', wordBreak: 'break-all' };

export function MoveFromPool() {
  const { address: evmAddress } = useWallet();
  const { getSignature, snAddress } = useIdentity();
  const { profile, networkEpoch } = useNetwork();

  const { setFlowInFlight } = useInFlight();

  const [amountInput, setAmountInput] = useState('');
  const [destination, setDestination] = useState('');
  const [status, setStatus] = useState<FlowStatus>({ phase: 'idle' });

  // Run-generation counter (BUG-1 class): bridgeOutToWallet is a minutes-long prove +
  // submit. If the account/network genuinely switches WHILE it runs, its trailing
  // setStatus (the `delivering` write carrying THIS run's burn tx / destination) would
  // repaint the prior account's data under the new one — a cross-account leak the
  // status-only reset effect below cannot catch (it neutralizes delivering/delivered,
  // never a still-running run). handleSubmit captures runGenRef.current at start and
  // gates EVERY shared-state write on it; the genuine-switch effect bumps it, so a
  // superseded run becomes a FULL no-op. Mirrors MoveIntoPool's hardening.
  const runGenRef = useRef(0);

  // Destination-chain picker (CCTP mint target) — mirrors MoveIntoPool's source picker.
  // Seeded to the network's default dest chain (137 mainnet / 80002 testnet).
  const [destChainId, setDestChainId] = useState<number>(config.cctp.defaultDestChainId);
  // Reset on a testnet↔mainnet swap (networkEpoch bump): EVM_CCTP_DESTINATIONS is
  // network-scoped, so a chain id picked on the old network is no longer a valid
  // destination after the swap — fall back to the new network's default (mirrors
  // MoveIntoPool's source-picker reset).
  useEffect(() => {
    setDestChainId(config.cctp.defaultDestChainId);
  }, [networkEpoch]);

  // Supported CCTP destinations for the picker + the currently-selected row (for the
  // header). EVM_CCTP_DESTINATIONS is network-scoped, so this tracks the active network.
  const destOptions = Object.values(EVM_CCTP_DESTINATIONS).map((d) => ({
    chainId: d.chainId,
    chainName: d.chainName,
  }));
  const selectedDest = EVM_CCTP_DESTINATIONS[destChainId];

  // amountWei is the NET the user wants delivered (the "bet").
  const amountWei = parseUsdcAmount(amountInput);
  // The funding estimate gives fundMicro = net + CCTP fee (the gross burn amount)
  // and betMicro = net. Both drive the UI. The burn MUST use fundMicro (gross) so
  // the destination receives exactly the labeled net after CCTP deductions.
  //
  // Threading the CHOSEN destChainId quotes the CCTP forwarding fee for the SELECTED
  // destination's route (not the default Polygon route) — so the displayed fee/net AND
  // the gross burn amount are correct for any pick (Finding 2). The same quote
  // (estimate.plan.quote.maxFee) is passed to bridgeOutToWallet as max_fee (Finding 1),
  // making the estimate the SINGLE source of truth for both display and burn.
  const estimate = useBridgeFundingEstimate(amountWei, USDC_DECIMALS, undefined, { destChainId });

  const isValidDestination = EVM_ADDRESS_RE.test(destination);

  const handleSubmit = useCallback(async () => {
    if (!evmAddress) return;
    // Capture this run's generation. Gate EVERY shared-state write below on it so a run
    // superseded by an account/network switch mid-flight is a FULL no-op (BUG-1).
    const runGen = runGenRef.current;
    const commit = (next: FlowStatus) => {
      if (runGenRef.current === runGen) setStatus(next);
    };
    // Require estimate to be ready so we have the gross burn amount.
    if (estimate.status !== 'ready') {
      commit({ phase: 'error', message: 'Enter a valid amount.' });
      return;
    }
    // grossAmount is the total to withdraw + burn (net + CCTP fee). This is what
    // bridgeOutToWallet receives so Circle deducts fees from the gross and the
    // destination receives the labeled net. Single source of truth: estimate.plan.
    const grossAmount = estimate.plan.fundMicro;
    // The CCTP forwarding fee (max_fee) quoted for the CHOSEN destination — the SAME
    // quote that drove the displayed fee/net above. Without it, bridgeOutToWallet
    // defaults max_fee = 0 and Circle's Forwarding Service can't cover destination gas
    // on non-Polygon chains → the burn lands on Starknet but the forwarded mint never
    // arrives (Finding 1: the live fund-stranding path). Never hardcoded — always quoted.
    const maxFee = estimate.plan.quote.maxFee;
    if (!isValidDestination) {
      commit({ phase: 'error', message: 'Enter a valid 0x EVM destination address.' });
      return;
    }
    if (!isAnonymizerConfigured()) {
      commit({
        phase: 'error',
        message: 'Anonymizer contract address not configured (VITE_ANONYMIZER_ADDRESS).',
      });
      return;
    }

    commit({ phase: 'signing' });
    let sig: string;
    try {
      sig = await getSignature();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Signature rejected.';
      commit({ phase: 'error', message });
      return;
    }

    commit({ phase: 'running', message: 'Starting bridge-out…' });
    try {
      const result = await bridgeOutToWallet({
        signature: sig,
        // Burn the GROSS (net + fee) — matches "Total to withdraw" shown in the UI.
        amount: grossAmount,
        // Quoted CCTP forwarding fee for the chosen chain (same quote as the display).
        maxFee,
        // The finality tier THIS fee was quoted for. bridgeOutToWallet fails closed if
        // the burn would declare a different tier (the fee/finality mismatch that quotes
        // Fast but burns Standard → slow burn + stranding). Same single source of truth
        // as maxFee — both come from estimate.plan.quote.
        quotedFinalityThreshold: estimate.plan.quote.finalityThreshold,
        destination: destination as `0x${string}`,
        // User-chosen destination EVM chain (its CCTP domain drives the mint target).
        destChainId,
        onStatus: (msg) => commit({ phase: 'running', message: msg }),
      });
      commit({
        phase: 'delivering',
        burnTx: result.burnTxHash,
        destination,
        destChainId,
        message: 'Waiting for Circle attestation…',
        slow: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Bridge-out failed.';
      commit({ phase: 'error', message });
    }
  }, [evmAddress, estimate, isValidDestination, destination, destChainId, getSignature]);

  // Resume/recovery: detect an interrupted FROM-pool transfer for this identity.
  // bridge-core's router DEFERS the from-pool phases (cctp-mint-out / cash-out) with
  // NOT_YET_RESUMABLE; the hook then DISMISSES the detected status and falls back to the
  // normal form. It deliberately does NOT auto-continue — this path is FAIL-CLOSED
  // against a double-burn (Bugbot HIGH). MoveFromPool uses bridgeOutToWallet, which
  // persists NO resume cursor (the inflightBurn/inflightCashOut cursors are apps/web's
  // fundAccountFromPool/cashOut), so there is no from-pool transfer to "complete" here.
  // Auto-invoking handleSubmit on defer would start a SECOND pool burn while an earlier
  // withdrawal is still in flight — and detection can fire on an identity change WITHIN
  // a session with the amount/destination fields still populated, so "unreachable" is
  // not a safe guard. The user re-initiates a burn manually, with explicit intent.
  const resume = useBridgeResume({
    direction: 'from-pool',
    snAddress: snAddress ?? undefined,
    evmAddress: evmAddress ?? undefined,
    epoch: networkEpoch,
    getSignature,
  });

  // Live delivery tracker (item-1 UX): once the Starknet burn is submitted, Circle's
  // Forwarding Service mints to the destination FOR US (no tx of ours). Poll Iris so
  // the user watches "attesting → delivered" instead of a static "on the way". This is
  // FIRE-AND-FORGET-SAFE: the burn already moved the value, so a poll timeout/error only
  // softens the copy (slow=true) — it NEVER surfaces a scary error and never moves value.
  // Primitive deps (not the whole status object) so a live message update — which keeps
  // the same burnTx/dest/domain — does NOT restart the poll.
  const deliveringBurnTx = status.phase === 'delivering' ? status.burnTx : null;
  const deliveringDest = status.phase === 'delivering' ? status.destination : null;
  const deliveringDomain =
    status.phase === 'delivering' ? EVM_CCTP_DESTINATIONS[status.destChainId]?.domain : undefined;
  useEffect(() => {
    if (!deliveringBurnTx || !deliveringDest) return;
    let cancelled = false;
    void (async () => {
      try {
        const { forwardTxHash } = await waitForForwardedMint(deliveringBurnTx, {
          expectedMintRecipient: deliveringDest,
          expectedDestinationDomain: deliveringDomain,
          onStatus: (m) => setStatus((s) => (s.phase === 'delivering' ? { ...s, message: m } : s)),
        });
        if (cancelled) return;
        setStatus((s) =>
          s.phase === 'delivering'
            ? {
                phase: 'delivered',
                burnTx: s.burnTx,
                destination: s.destination,
                destChainId: s.destChainId,
                forwardTx: forwardTxHash,
              }
            : s,
        );
      } catch {
        if (cancelled) return;
        // Degrade gracefully — Circle completes the forward regardless of our poll.
        setStatus((s) =>
          s.phase === 'delivering'
            ? { ...s, slow: true, message: 'Still finalizing on Circle — the mint completes automatically.' }
            : s,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deliveringBurnTx, deliveringDest, deliveringDomain]);

  // Cross-account / network safety (BUG-1 class): a delivery tracker belongs to the
  // account + network that issued the burn. Drop it ONLY on a GENUINE change — a real
  // account SWITCH (a previously-derived non-null identity → a DIFFERENT non-null
  // identity) or a network switch (networkEpoch bump) — so a stale run can never
  // repaint a prior account's burn tx / destination.
  //
  // Crucially, do NOT reset on the FIRST null→derived identity transition. A burn
  // submit (getSignature) does NOT set snAddress; only async identity derivation
  // (deriveIdentity) does. So if the user submits a withdraw BEFORE derivation finishes,
  // snAddress later flips null→derived — an unconditional reset here would DROP the
  // delivery tracker (and its in-flight guard) while Circle is still forwarding the
  // burn, untracking a live burn (Bugbot HIGH). A derived→null (disconnect) is likewise
  // NOT a switch to another account and must not nuke an in-flight delivery.
  const prevSnAddressRef = useRef(snAddress);
  const prevNetworkEpochRef = useRef(networkEpoch);
  useEffect(() => {
    const prevSn = prevSnAddressRef.current;
    const networkSwitched = prevNetworkEpochRef.current !== networkEpoch;
    // A genuine account switch: a previously-derived (non-null) identity changed to a
    // DIFFERENT non-null identity. null→derived (initial derive) and derived→null
    // (disconnect) are NOT switches.
    const identitySwitched = prevSn != null && snAddress != null && prevSn !== snAddress;
    // Anchor only on REAL identities: never overwrite the anchor with null on a
    // disconnect, else a later reconnect as a DIFFERENT account would look like a fresh
    // null→derived and SKIP the reset — leaking the prior account's burn under the new
    // one. Keeping the last non-null anchor makes disconnect→reconnect-as-other reset.
    if (snAddress != null) prevSnAddressRef.current = snAddress;
    prevNetworkEpochRef.current = networkEpoch;
    if (!networkSwitched && !identitySwitched) return;
    // Supersede any in-flight run so its trailing terminal writes (e.g. the `delivering`
    // paint after bridgeOutToWallet resolves) become a FULL no-op — not only the already-
    // terminal delivering/delivered, but a still-running/signing run too. Then clear the
    // stale display back to idle (the normal form for the new identity).
    runGenRef.current += 1;
    setStatus((s) => (s.phase === 'idle' ? s : { phase: 'idle' }));
  }, [snAddress, networkEpoch]);

  const isRunning = status.phase === 'signing' || status.phase === 'running';
  // A burn is OUTSTANDING during `delivering`: the Starknet burn is submitted and
  // Circle's Forwarding Service is still attesting + minting to the destination FOR
  // us. Value is in motion, so this must count as in-flight (block the network toggle)
  // and as busy (block a second burn) — same fund-safety class as signing/running.
  // `delivered` is TERMINAL (the forwarded mint landed) → the burn is no longer
  // outstanding, so it does NOT block the network toggle; but Submit must still be
  // disabled from a `delivered` state so a click can't silently re-burn without an
  // explicit reset (the reset effect above returns to idle on identity/network change).
  const isDelivering = status.phase === 'delivering';
  const isBusy = isRunning || isDelivering || status.phase === 'delivered';
  // Report in-flight while signing/running/delivering (a burn is outstanding — its mint
  // is still forwarding) OR while a resumable transfer is detected/resuming, so a
  // network switch is blocked mid-CCTP (fund-safety). `delivered` is terminal and does
  // NOT block. Clears on settle (delivered/error/idle) and on unmount.
  const hasResumable = resume.status !== null || resume.resuming;
  useEffect(() => {
    setFlowInFlight('moveFromPool', isRunning || isDelivering || hasResumable);
    return () => setFlowInFlight('moveFromPool', false);
  }, [isRunning, isDelivering, hasResumable, setFlowInFlight]);
  // Submit is active only when NOT busy (no second bridgeOutToWallet while a burn is
  // unresolved, and no silent re-burn from a terminal `delivered` state) and we have
  // the gross burn amount (estimate.status === 'ready').
  const canSubmit =
    !isBusy && estimate.status === 'ready' && isValidDestination && !!evmAddress;

  // A `delivered` terminal state intentionally keeps the form frozen (isBusy) so a
  // stray click can't silently re-burn the same amount/destination. Without an explicit
  // reset the button is a DEAD END within the same identity/network — the user has to
  // switch account or reload to send again. This is that explicit reset back to idle so
  // a NEW transfer can be composed. Safe with no run-guard: `delivered` is terminal (the
  // forward already resolved), and the delivery-tracker effect above both cancels on
  // cleanup and gates every write on `s.phase === 'delivering'`, so a later burn's
  // tracker can't be repainted by a prior one.
  const startAnotherTransfer = () => {
    setStatus({ phase: 'idle' });
  };

  const mintUrl =
    status.phase === 'delivered' ? evmTxUrl(EVM_CCTP_DESTINATIONS[status.destChainId], status.forwardTx) : null;

  return (
    <div style={styles.card}>
      <div style={styles.cardTitle}>Move From Pool</div>
      <p style={{ ...styles.muted, marginBottom: '0.75rem' }}>
        Starknet privacy pool → <strong>{selectedDest?.chainName ?? `Chain ${destChainId}`}</strong>
        {selectedDest ? ` (chainId ${selectedDest.chainId})` : ''}
      </p>

      {/* Resume/recovery: an interrupted from-pool transfer HIDES the normal action
          and continues the stuck one (auto, since needsSignature is false), with a
          manual Continue fallback if auto-resume errors. */}
      {resume.status ? (
        <ResumeBanner resume={resume} />
      ) : (
        <>
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

      {/* Funding estimate */}
      {estimate.status === 'loading' && <p style={styles.muted}>Estimating…</p>}
      {estimate.status === 'ready' && (
        <div style={{ marginBottom: '0.5rem' }}>
          <div style={styles.estimateRow}>
            <span>Total to withdraw</span>
            <span>{estimate.fundHuman.toFixed(2)} USDC</span>
          </div>
          <div style={styles.estimateRow}>
            <span>Net to destination</span>
            <span>{estimate.betHuman.toFixed(2)} USDC</span>
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

      {/* Destination-chain picker (CCTP mint target) — reuses the deposit-side
          picker so each chain shows its brand icon. Orthogonal to the recipient
          address below. */}
      <label style={styles.label}>Destination chain</label>
      <SourceChainPicker
        value={destChainId}
        options={destOptions}
        disabled={isRunning}
        label="Destination chain"
        onChange={setDestChainId}
      />

      <label style={styles.label}>Destination EVM address</label>
      <input
        style={{
          ...styles.input,
          borderColor: destination && !isValidDestination ? '#ef4444' : undefined,
        }}
        type="text"
        value={destination}
        onChange={(e) => setDestination(e.target.value.trim())}
        placeholder="0x…"
        disabled={isRunning}
      />
      {destination && !isValidDestination && (
        <p style={{ ...styles.muted, color: '#ef4444', marginTop: '-0.5rem', marginBottom: '0.75rem' }}>
          Must be a 0x EVM address (42 hex chars).
        </p>
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
            : 'Move From Pool'}
      </button>

      {/* Status feedback */}
      {status.phase === 'running' && (
        <div style={styles.statusBox('info')}>{status.message}</div>
      )}
      {status.phase === 'delivering' && (
        <div style={styles.statusBox('info')}>
          <strong>Burn submitted — funds are on the way, not yet delivered.</strong>
          <br />
          {status.slow ? (
            <>
              Taking longer than usual, but nothing is lost — Circle completes the
              destination mint <em>automatically</em>. You can safely close this tab.
            </>
          ) : (
            <>
              Circle is attesting your Starknet burn, then mints to your destination{' '}
              <em>automatically</em> — no further action needed.{' '}
              <span style={styles.muted}>{status.message}</span>
            </>
          )}
          <br />
          <br />
          Destination: {status.destination}
          <br />
          Burn tx:{' '}
          <a href={snTxUrl(profile.network, status.burnTx)} target="_blank" rel="noopener noreferrer" style={txLinkStyle}>
            {status.burnTx} ↗
          </a>
          <br />
          <span style={styles.muted}>Track the burn on Voyager; the mint lands on your destination chain.</span>
        </div>
      )}
      {status.phase === 'delivered' && (
        <>
        <div style={styles.statusBox('success')}>
          <strong>Delivered — USDC minted to your destination.</strong>
          <br />
          <br />
          Destination: {status.destination}
          <br />
          Burn tx:{' '}
          <a href={snTxUrl(profile.network, status.burnTx)} target="_blank" rel="noopener noreferrer" style={txLinkStyle}>
            {status.burnTx} ↗
          </a>
          <br />
          Mint tx:{' '}
          {mintUrl ? (
            <a href={mintUrl} target="_blank" rel="noopener noreferrer" style={txLinkStyle}>
              {status.forwardTx} ↗
            </a>
          ) : (
            <span style={{ wordBreak: 'break-all' }}>{status.forwardTx}</span>
          )}
        </div>
        <button onClick={startAnotherTransfer} style={styles.primaryBtn}>
          Start another transfer
        </button>
        </>
      )}
      {status.phase === 'error' && (
        <div style={styles.statusBox('error')}>{status.message}</div>
      )}
        </>
      )}
    </div>
  );
}
