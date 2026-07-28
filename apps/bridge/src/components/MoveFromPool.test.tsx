// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MoveFromPool } from './MoveFromPool';

// Two findings pinned here:
//   - Bugbot HIGH (gross vs net): MoveFromPool must burn the GROSS
//     estimate.plan.fundMicro ("Total to withdraw"), not the net amountWei.
//   - Finding 1+2 (fund-stranding + wrong-fee display): the CCTP forwarding fee
//     must be QUOTED for the CHOSEN destination and passed to bridgeOutToWallet as
//     max_fee (else Circle's Forwarding Service can't cover destination gas on a
//     non-Polygon chain → funds burn on Starknet but never mint). The SAME quote
//     (estimate.plan.quote.maxFee) drives both the display and the burn — a single
//     source of truth threaded through the estimate hook's destChainId.

const bridgeOutToWallet = vi.fn().mockResolvedValue({
  burnTxHash: '0xburn',
  mintRecipient: '0xdest',
});

// Live delivery tracker (item-1 UX): after the burn, MoveFromPool polls Circle's
// Forwarding Service via waitForForwardedMint until the destination mint lands.
// Default = pending forever (stays "delivering") so the fee/gross tests don't race a
// resolution; the tracker test overrides it with a resolved forwardTxHash.
type ForwardOpts = { expectedMintRecipient: string; expectedDestinationDomain?: number };
const waitForForwardedMint = vi.fn<
  (burnTx: string, opts: ForwardOpts) => Promise<{ forwardTxHash: string }>
>(() => new Promise<{ forwardTxHash: string }>(() => {}));

const NET_AMOUNT_MICRO = 1_000_000n; // 1.00 USDC — what the user types
const GROSS_FUND_MICRO = 1_050_000n; // net + CCTP fee + reserve — must be the burn amount

// Destination-aware forwarding-fee quote: DIFFERENT per chain, proving the estimate
// (and therefore the max_fee passed to the burn) is quoted for the SELECTED chain,
// not the default Polygon route.
const FEE_BY_CHAIN: Record<number, bigint> = {
  80002: 12_000n, // Polygon Amoy
  84532: 55_000n, // Base Sepolia (a NON-Polygon pick)
};

// Records the args every useBridgeFundingEstimate call receives so a test can assert
// the chosen destChainId is threaded into the quote (Finding 2 — driver behavior).
const estimateSpy = vi.fn();

// Mutable network epoch so a test can simulate an identity/network change WITHIN a
// session — a re-detect that surfaces a stuck from-pool transfer while the amount +
// destination fields are STILL populated (the double-burn scenario Bugbot flagged).
const net = { epoch: 0 };

// Resume/recovery engine (Phase 2). Default: nothing in flight → normal action. The
// router DEFERS from-pool phases (NOT_YET_RESUMABLE); the test drives that path.
const getBridgeTransferStatus = vi.fn().mockReturnValue(null);
const resumeBridgeTransfer = vi.fn();

vi.mock('@starkware-libs/starknet-privacy-bridge', () => ({
  bridgeOutToWallet: (...args: unknown[]) => bridgeOutToWallet(...args),
  isAnonymizerConfigured: () => true,
  getBridgeTransferStatus: (...args: unknown[]) => getBridgeTransferStatus(...args),
  // The resume hook now detects via the async chain-aware reader (#433); delegate to the
  // same sync spy so existing mockReturnValue/mockReturnValueOnce keep driving detection.
  getBridgeTransferStatusAsync: (...args: unknown[]) =>
    Promise.resolve(getBridgeTransferStatus(...args)),
  resumeBridgeTransfer: (...args: unknown[]) => resumeBridgeTransfer(...args),
  waitForForwardedMint: (burnTx: string, opts: ForwardOpts) => waitForForwardedMint(burnTx, opts),
  config: { cctp: { defaultDestChainId: 80002 } },
  // `domain` is the CCTP destination domain the tracker threads into
  // waitForForwardedMint's fund-safety gate (Polygon = 7, Base = 6).
  EVM_CCTP_DESTINATIONS: {
    80002: { chainId: 80002, chainName: 'Polygon Amoy', domain: 7 },
    84532: { chainId: 84532, chainName: 'Base Sepolia', domain: 6 },
  },
}));

vi.mock('@starkware-libs/starknet-privacy-bridge/react', () => ({
  useWallet: () => ({ address: '0xEvmAddress0000000000000000000000000000' }),
  useBridgeFundingEstimate: (
    bet: bigint | null,
    decimals: number,
    sourceChainId: number | undefined,
    opts?: { destChainId?: number },
  ) => {
    estimateSpy(bet, decimals, sourceChainId, opts);
    // Quote is keyed on the CHOSEN destChainId — the whole point of Finding 2.
    const destChainId = opts?.destChainId ?? 80002;
    const maxFee = FEE_BY_CHAIN[destChainId] ?? 0n;
    return {
      status: 'ready',
      // `quote.finalityThreshold` is the CCTP tier THIS fee was quoted for (Fast=1000
      // on the bridge app). MoveFromPool threads it to bridgeOutToWallet as
      // quotedFinalityThreshold so the burn-boundary guard can fail closed on a mismatch.
      plan: {
        fundMicro: GROSS_FUND_MICRO,
        betMicro: NET_AMOUNT_MICRO,
        quote: { maxFee, finalityThreshold: 1000 },
      },
      betHuman: 1.0,
      fundHuman: 1.05,
      reserveHuman: 0.05,
      feeHuman: Number(maxFee) / 1e6,
      projectedOrderHuman: 1.0,
      belowFloor: false,
    };
  },
}));

// Mutable identity so a test can simulate async identity derivation (deriveIdentity)
// flipping snAddress null→derived AFTER a burn was submitted, and a genuine account
// switch between two DISTINCT derived addresses.
const identity: { snAddress: string | null } = { snAddress: null };
vi.mock('../IdentityContext', () => ({
  useIdentity: () => ({ getSignature: vi.fn().mockResolvedValue('0xsig'), snAddress: identity.snAddress }),
}));

vi.mock('../NetworkContext', () => ({
  useNetwork: () => ({
    profile: { network: 'testnet', starknetChain: 'Starknet Sepolia', polygonChain: 'Polygon Amoy', polygonChainId: 80002 },
    networkEpoch: net.epoch,
  }),
}));

// Hoisted so tests can assert the in-flight signal across renders (a fresh vi.fn()
// per render would lose the call history). Mirrors the module-level spy pattern used
// for bridgeOutToWallet/estimateSpy above.
const setFlowInFlight = vi.fn();
vi.mock('../InFlightContext', () => ({
  useInFlight: () => ({ anyInFlight: false, setFlowInFlight }),
}));

async function fillAndSubmit(): Promise<void> {
  fireEvent.change(screen.getByPlaceholderText('e.g. 1.00'), { target: { value: '1.00' } });
  fireEvent.change(screen.getByPlaceholderText('0x…'), {
    target: { value: '0x1111111111111111111111111111111111111111' },
  });
  fireEvent.click(screen.getByRole('button', { name: /move from pool/i }));
}

describe('MoveFromPool', () => {
  beforeEach(() => {
    net.epoch = 0;
    identity.snAddress = null;
    bridgeOutToWallet.mockClear();
    setFlowInFlight.mockClear();
    estimateSpy.mockClear();
    getBridgeTransferStatus.mockReset().mockReturnValue(null);
    resumeBridgeTransfer.mockReset();
    waitForForwardedMint
      .mockReset()
      .mockImplementation(() => new Promise<{ forwardTxHash: string }>(() => {}));
  });

  it('burns the GROSS fundMicro ("Total to withdraw"), not the net amountWei', async () => {
    render(<MoveFromPool />);
    await fillAndSubmit();

    await waitFor(() => expect(bridgeOutToWallet).toHaveBeenCalledTimes(1));
    const call = bridgeOutToWallet.mock.calls[0][0];

    // Must burn the GROSS total shown to the user, not the net.
    expect(call.amount).toBe(GROSS_FUND_MICRO);
    expect(call.amount).not.toBe(NET_AMOUNT_MICRO);
  });

  it('passes a NON-zero maxFee quoted for the DEFAULT (Polygon) destination', async () => {
    render(<MoveFromPool />);
    await fillAndSubmit();

    await waitFor(() => expect(bridgeOutToWallet).toHaveBeenCalledTimes(1));
    const call = bridgeOutToWallet.mock.calls[0][0];

    // Fund-stranding guard: max_fee must be the quoted fee, never 0, so Circle's
    // Forwarding Service can cover destination gas.
    expect(call.maxFee).toBe(FEE_BY_CHAIN[80002]);
    expect(call.maxFee).not.toBe(0n);
    expect(call.destChainId).toBe(80002);
    // Fee/finality single source of truth: the quoted tier is threaded to the burn so
    // bridgeOutToWallet can fail closed on a mismatch (tier-mismatch stranding guard).
    expect(call.quotedFinalityThreshold).toBe(1000);
  });

  it('quotes the fee for the CHOSEN non-Polygon destination and passes THAT as maxFee', async () => {
    render(<MoveFromPool />);

    // Pick Base Sepolia (a non-Polygon destination) in the picker.
    fireEvent.click(screen.getByRole('button', { name: /destination chain:/i }));
    fireEvent.click(screen.getByRole('option', { name: /base sepolia/i }));

    await fillAndSubmit();

    await waitFor(() => expect(bridgeOutToWallet).toHaveBeenCalledTimes(1));
    const call = bridgeOutToWallet.mock.calls[0][0];

    // The burn's max_fee is Base's quote — NOT Polygon's (would under-cover Base gas
    // and strand the mint).
    expect(call.destChainId).toBe(84532);
    expect(call.maxFee).toBe(FEE_BY_CHAIN[84532]);
    expect(call.maxFee).not.toBe(FEE_BY_CHAIN[80002]);
  });

  it('threads the chosen destChainId into the funding estimate (single source of truth for display + fee)', async () => {
    render(<MoveFromPool />);
    fireEvent.change(screen.getByPlaceholderText('e.g. 1.00'), { target: { value: '1.00' } });

    // Default pick → estimate quoted for Polygon (80002).
    await waitFor(() =>
      expect(estimateSpy.mock.calls.some((c) => c[3]?.destChainId === 80002)).toBe(true),
    );

    // Switch to Base → estimate re-quoted for 84532.
    fireEvent.click(screen.getByRole('button', { name: /destination chain:/i }));
    fireEvent.click(screen.getByRole('option', { name: /base sepolia/i }));

    await waitFor(() =>
      expect(estimateSpy.mock.calls.some((c) => c[3]?.destChainId === 84532)).toBe(true),
    );
  });

  // ── Live delivery tracker (item-1 UX) ────────────────────────────────────────

  // After the burn, the "Done!" copy overstated completion (funds are NOT yet at the
  // destination — Circle's Forwarding Service still has to attest + mint). The tracker
  // polls waitForForwardedMint and only shows "Delivered" once the forward lands.
  // RED before the fix (waitForForwardedMint never called; static "done" shown);
  // GREEN after (called with the destination + its CCTP domain, then "Delivered").
  it('polls the forwarded mint after the burn and shows Delivered once it lands', async () => {
    waitForForwardedMint.mockResolvedValueOnce({ forwardTxHash: '0xforward' });

    render(<MoveFromPool />);
    await fillAndSubmit();

    // The tracker polls Circle for THIS burn, gated on the destination recipient + its
    // CCTP domain (the A1 fund-safety gate) — never a scary "done" the instant we burn.
    await waitFor(() => expect(waitForForwardedMint).toHaveBeenCalledTimes(1));
    const [burnTx, opts] = waitForForwardedMint.mock.calls[0];
    expect(burnTx).toBe('0xburn');
    expect(opts.expectedMintRecipient).toBe('0x1111111111111111111111111111111111111111');
    expect(opts.expectedDestinationDomain).toBe(7); // Polygon Amoy (default pick)

    // Once Circle reports the forward, the UI flips to a truthful "Delivered".
    await waitFor(() => expect(screen.getByText(/delivered/i)).toBeTruthy());
    expect(screen.getByText(/0xforward/)).toBeTruthy();
  });

  // ── Dead-button after delivery (user-reported) ───────────────────────────────
  // A `delivered` state keeps the form frozen (isBusy) so a stray click can't silently
  // re-burn — but with no explicit reset the Submit button is a DEAD END: the only way
  // to send again was to switch account or reload. This pins the "Start another transfer"
  // escape hatch. RED before the fix: no such button → getByRole throws. GREEN after:
  // the button resets to idle, re-enabling the form so a SECOND transfer can be composed.
  it('offers "Start another transfer" after delivery, resetting to idle so a new burn can run', async () => {
    waitForForwardedMint.mockResolvedValueOnce({ forwardTxHash: '0xforward' });

    render(<MoveFromPool />);
    await fillAndSubmit();
    await waitFor(() => expect(bridgeOutToWallet).toHaveBeenCalledTimes(1));

    // Terminal `delivered`: the primary Submit is disabled (no silent re-burn).
    await waitFor(() => expect(screen.getByText(/^Delivered/i)).toBeTruthy());
    const submitBtn = screen.getByRole('button', { name: /move from pool/i }) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);

    // The escape hatch returns the form to idle (delivery box gone, Submit re-enabled).
    fireEvent.click(screen.getByRole('button', { name: /start another transfer/i }));
    await waitFor(() => expect(screen.queryByText(/^Delivered/i)).toBeNull());
    const submitAgain = screen.getByRole('button', { name: /move from pool/i }) as HTMLButtonElement;
    expect(submitAgain.disabled).toBe(false);

    // And the flow is genuinely usable again — a fresh submit starts a SECOND burn.
    fireEvent.click(submitAgain);
    await waitFor(() => expect(bridgeOutToWallet).toHaveBeenCalledTimes(2));
  });

  // ── Delivering = BUSY / in-flight (Bugbot HIGH + MEDIUM) ─────────────────────
  // The `delivering` phase means the burn is SUBMITTED and Circle is still forwarding
  // the mint. The pre-fix `isRunning`/`canSubmit` excluded `delivering`, so the Submit
  // button stayed ENABLED (→ a second bridgeOutToWallet = double pool withdrawal) and
  // the in-flight guard read FALSE (→ a network switch mid-forward). These pin both.

  // (HIGH) Second burn while delivering. waitForForwardedMint stays pending → status
  // parks at `delivering`. RED before the fix: canSubmit ignores `delivering` → button
  // enabled → a second click re-burns (2 calls). GREEN after: button disabled →
  // the second click is a no-op (still 1 call).
  it('during delivering, Submit is disabled and a second click does NOT start a second burn', async () => {
    render(<MoveFromPool />);
    await fillAndSubmit();

    await waitFor(() => expect(bridgeOutToWallet).toHaveBeenCalledTimes(1));
    // Parked in `delivering` (burn submitted; Circle still forwarding the mint).
    await waitFor(() => expect(screen.getByText(/on the way, not yet delivered/i)).toBeTruthy());

    const btn = screen.getByRole('button', { name: /move from pool/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    // A second click must NOT re-burn while the first forward is in flight.
    fireEvent.click(btn);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(bridgeOutToWallet).toHaveBeenCalledTimes(1);
  });

  // (MEDIUM) Delivering omits in-flight guard. RED before the fix: the delivering
  // transition fires setFlowInFlight('moveFromPool', false) (burn "done") → a network
  // switch is allowed while the mint is still forwarding. GREEN after: the LATEST
  // in-flight call for the flow is TRUE throughout `delivering`.
  it("sets in-flight TRUE during delivering (network switch stays blocked while the mint forwards)", async () => {
    render(<MoveFromPool />);
    await fillAndSubmit();

    await waitFor(() => expect(bridgeOutToWallet).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/on the way, not yet delivered/i)).toBeTruthy());

    // The most recent in-flight signal for this flow must be TRUE (a burn is outstanding).
    await waitFor(() => {
      const calls = setFlowInFlight.mock.calls.filter(([k]) => k === 'moveFromPool');
      expect(calls[calls.length - 1]?.[1]).toBe(true);
    });
  });

  // ── Delivery tracker survives the first identity derive (Bugbot HIGH) ────────
  // A burn submit (getSignature) does NOT set snAddress — only async identity derivation
  // does. If the user submits BEFORE derivation finishes, snAddress later flips
  // null→derived. The cross-account reset effect must IGNORE that first derive, else it
  // drops the in-flight delivery tracker (and its in-flight guard) while Circle is still
  // forwarding the burn — untracking a live burn. RED before the fix (unconditional
  // reset on snAddress change → tracker gone); GREEN after (tracker survives).
  const DERIVED_A = '0xDerivedAddressAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const DERIVED_B = '0xDerivedAddressBBBBBBBBBBBBBBBBBBBBBBBBBB';

  it('keeps the delivery tracker across the FIRST null→derived identity derive', async () => {
    identity.snAddress = null;
    const { rerender } = render(<MoveFromPool />);
    await fillAndSubmit();

    await waitFor(() => expect(bridgeOutToWallet).toHaveBeenCalledTimes(1));
    // Parked in `delivering` (waitForForwardedMint stays pending).
    await waitFor(() => expect(screen.getByText(/on the way, not yet delivered/i)).toBeTruthy());

    // Identity derivation completes AFTER the burn: snAddress flips null → derived.
    identity.snAddress = DERIVED_A;
    rerender(<MoveFromPool />);

    // The in-flight delivery MUST survive the first derive — not reset to the idle form.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByText(/on the way, not yet delivered/i)).toBeTruthy();
  });

  it('resets the delivery tracker on a GENUINE account switch (distinct non-null snAddress)', async () => {
    // Start already derived (address A), submit a burn, then switch to a DIFFERENT
    // derived identity (address B) — a real cross-account change that must drop the
    // prior account's tracker (privacy reset preserved).
    identity.snAddress = DERIVED_A;
    const { rerender } = render(<MoveFromPool />);
    await fillAndSubmit();

    await waitFor(() => expect(bridgeOutToWallet).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/on the way, not yet delivered/i)).toBeTruthy());

    identity.snAddress = DERIVED_B;
    rerender(<MoveFromPool />);

    // A genuine switch resets to idle — the tracker is gone and the normal form returns.
    await waitFor(() =>
      expect(screen.queryByText(/on the way, not yet delivered/i)).toBeNull(),
    );
    expect(screen.getByPlaceholderText('e.g. 1.00')).toBeTruthy();
  });

  // ── BUG-1: a run superseded MID-FLIGHT must be a FULL no-op on shared UI ──────
  // The genuine-switch test above switches AFTER the burn resolved (status already
  // `delivering`), which the status-only reset catches. The real BUG-1 gap is a switch
  // WHILE bridgeOutToWallet is still in flight (status `running`): when the burn later
  // resolves, its trailing setStatus paints THIS run's burn tx + destination under the
  // NEW account — a cross-account leak. Without the run-generation guard that write
  // lands; with it, the superseded run is a FULL no-op. RED before the runGen guard,
  // GREEN after.
  it("does NOT repaint a stale run's burn under an account switched to mid-flight (BUG-1)", async () => {
    // Defer the burn so the A→B switch lands while status is still `running`.
    let releaseBurn: (v: { burnTxHash: string; mintRecipient: string }) => void = () => {};
    bridgeOutToWallet.mockImplementationOnce(
      () =>
        new Promise<{ burnTxHash: string; mintRecipient: string }>((resolve) => {
          releaseBurn = resolve;
        }),
    );

    identity.snAddress = DERIVED_A;
    const { rerender } = render(<MoveFromPool />);
    await fillAndSubmit();

    // The burn is in flight — status is `running` (NOT yet delivering).
    await waitFor(() => expect(bridgeOutToWallet).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/starting bridge-out/i)).toBeTruthy());

    // A genuine account switch A→B happens BEFORE the burn resolves.
    identity.snAddress = DERIVED_B;
    rerender(<MoveFromPool />);

    // Now the superseded run (account A) resolves — it must not touch shared UI state.
    await act(async () => {
      releaseBurn({
        burnTxHash: '0xAAAstaleBurn',
        mintRecipient: '0x1111111111111111111111111111111111111111',
      });
      await new Promise((r) => setTimeout(r, 20));
    });

    // Account A's burn tx must NOT be painted under account B, and no delivering box.
    expect(screen.queryByText(/0xAAAstaleBurn/)).toBeNull();
    expect(screen.queryByText(/on the way, not yet delivered/i)).toBeNull();
  });

  it('survives a disconnect (derived→null) but resets when reconnecting as a DIFFERENT account', async () => {
    // Delivering under account A, then a disconnect (snAddress→null) must NOT drop the
    // in-flight tracker (same user; a reconnect should keep it). But reconnecting as a
    // DIFFERENT account (B) is a real cross-account change → reset, so the anchor must
    // survive the null gap (never overwritten to null on disconnect).
    identity.snAddress = DERIVED_A;
    const { rerender } = render(<MoveFromPool />);
    await fillAndSubmit();

    await waitFor(() => expect(bridgeOutToWallet).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/on the way, not yet delivered/i)).toBeTruthy());

    // Disconnect → snAddress null. Tracker survives.
    identity.snAddress = null;
    rerender(<MoveFromPool />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByText(/on the way, not yet delivered/i)).toBeTruthy();

    // Reconnect as a DIFFERENT account → reset (prior account's transfer must not show).
    identity.snAddress = DERIVED_B;
    rerender(<MoveFromPool />);
    await waitFor(() =>
      expect(screen.queryByText(/on the way, not yet delivered/i)).toBeNull(),
    );
  });

  // ── Resume / recovery (Phase 2) ──────────────────────────────────────────────

  const FROM_POOL_STATUS = {
    direction: 'from-pool' as const,
    phase: 'cash-out' as const,
    needsSignature: false,
    amountWei: 1_000_000n,
    account: { evmAddress: '0xEvmAddress0000000000000000000000000000' },
  };

  // (c) A detected from-pool transfer is routed through the SDK router, which DEFERS it
  // (NOT_YET_RESUMABLE). The hook DISMISSES the deferred status (fail-closed — it does
  // NOT auto-continue) and the panel falls back to its normal bridgeOutToWallet submit
  // form, rather than a raw error or a stuck spinner. Proven by: resumeBridgeTransfer is
  // called with the from-pool status, then the normal form reappears and a fresh MANUAL
  // submit reaches bridgeOutToWallet.
  it('routes a detected from-pool transfer to the existing from-pool path (defer → normal submit)', async () => {
    // Detected once at mount; after the deferred fallback + recheck the cursor is gone
    // (the app has no cursor-resume for from-pool), so the normal form returns.
    getBridgeTransferStatus.mockReturnValueOnce(FROM_POOL_STATUS).mockReturnValue(null);
    const notYet = Object.assign(new Error('not yet resumable'), {
      code: 'NOT_YET_RESUMABLE',
      phase: 'cash-out',
    });
    resumeBridgeTransfer.mockRejectedValue(notYet);

    render(<MoveFromPool />);

    // The router is consulted with the from-pool status (auto-continue).
    await waitFor(() => expect(resumeBridgeTransfer).toHaveBeenCalledTimes(1));
    expect(resumeBridgeTransfer.mock.calls[0][0].status.direction).toBe('from-pool');

    // Falls back to the existing submit form — the normal action is usable again.
    await waitFor(() => expect(screen.getByRole('button', { name: /move from pool/i })).toBeTruthy());
    await fillAndSubmit();
    await waitFor(() => expect(bridgeOutToWallet).toHaveBeenCalledTimes(1));
  });

  // (d) DOUBLE-BURN GUARD (Bugbot HIGH). The pre-fix wiring passed the resume hook an
  // `onDeferred` that did `void handleSubmit()`, so a DEFERRED from-pool detection would
  // AUTO-invoke bridgeOutToWallet — a fresh pool burn. Detection can fire on an identity/
  // network change WITHIN a session with the amount + destination fields STILL populated
  // (not only after a reload with empty fields), so the deferred path could start a
  // SECOND burn while an earlier withdrawal is in flight. This proves the fix: a deferred
  // from-pool resume DISMISSES to the normal form and NEVER auto-calls bridgeOutToWallet.
  // RED before the fix (populated fields → onDeferred → handleSubmit → 1 burn); GREEN
  // after (0 burns; user must re-submit manually).
  it('does NOT auto-burn when a from-pool resume defers after a within-session re-detect', async () => {
    // Nothing in flight at mount → the normal form. The user fills a REAL amount + a
    // VALID destination (so a stray handleSubmit would reach bridgeOutToWallet, not
    // early-return on validation).
    const { rerender } = render(<MoveFromPool />);
    fireEvent.change(screen.getByPlaceholderText('e.g. 1.00'), { target: { value: '1.00' } });
    fireEvent.change(screen.getByPlaceholderText('0x…'), {
      target: { value: '0x1111111111111111111111111111111111111111' },
    });

    // A within-session identity/network change re-detects a stuck from-pool transfer the
    // router DEFERS (NOT_YET_RESUMABLE), then the cursor is gone (no from-pool cursor
    // exists in this app). Fields are still populated.
    getBridgeTransferStatus.mockReturnValueOnce(FROM_POOL_STATUS).mockReturnValue(null);
    const notYet = Object.assign(new Error('not yet resumable'), {
      code: 'NOT_YET_RESUMABLE',
      phase: 'cash-out',
    });
    resumeBridgeTransfer.mockRejectedValue(notYet);

    net.epoch = 1;
    rerender(<MoveFromPool />);

    // Auto-continue consults the router with the from-pool status → it defers.
    await waitFor(() => expect(resumeBridgeTransfer).toHaveBeenCalledTimes(1));
    expect(resumeBridgeTransfer.mock.calls[0][0].status.direction).toBe('from-pool');

    // The panel dismisses the deferred status and shows the normal form again.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /move from pool/i })).toBeTruthy(),
    );

    // Give any (buggy) auto-submit time to fire: getSignature + bridgeOutToWallet are
    // async but resolve within a couple microtasks.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // The fix: NO fresh burn was auto-started. The user must re-submit with explicit intent.
    expect(bridgeOutToWallet).not.toHaveBeenCalled();
  });

  it('shows the normal action (no resume) when nothing is in flight', () => {
    render(<MoveFromPool />);
    expect(getBridgeTransferStatus).toHaveBeenCalled();
    expect(resumeBridgeTransfer).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /move from pool/i })).toBeTruthy();
  });
});
