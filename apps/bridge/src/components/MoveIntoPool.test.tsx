import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MoveIntoPool } from './MoveIntoPool';

// Bugbot MEDIUM finding: "Deposit-in burns net not gross" — MoveIntoPool sent the
// typed amount as the CCTP burn GROSS via fundFromMetaMask, while MoveFromPool
// treats the field as NET and burns the grossed-up estimate.plan.fundMicro. With
// CCTP forwarding fees, minted pool balance = amount - max_fee, so the user got
// LESS in the pool than the amount they typed. Fix: mirror MoveFromPool — burn the
// GROSS (estimate.plan.fundMicro), not the bare typed net (amountWei).

// The orchestrator that actually funds + deploys + registers + DEPOSITS into the pool
// (replaces the old fundFromMetaMask call, which only minted native USDC and never
// deposited). Returns the net handed to the pool.
const moveIntoPool = vi.fn().mockResolvedValue({ depositedNetWei: 1_000_000n, deposited: true });
// MEDIUM-1: the reader the component consults on mount / funder change to keep the
// network switch blocked while a persisted (burn-but-not-minted) transfer survives.
const hasInflightDeposit = vi.fn().mockReturnValue(false);
// In-pool balance reader — the component pre/post-reads it ONLY to pick the DISPLAYED
// amount (measured delta if positive). Success is gated on moveIntoPool's `deposited`
// flag, never on this racy read (Bugbot HIGH #239).
const discoverPrivateBalanceForAddress = vi.fn().mockResolvedValue(0n);
// Resume/recovery engine (Phase 2 wiring). Default: nothing in flight → normal action.
const getBridgeTransferStatus = vi.fn().mockReturnValue(null);
const resumeBridgeTransfer = vi
  .fn()
  .mockResolvedValue({ completed: true, amountWei: 1_000_000n });

const NET_AMOUNT_MICRO = 1_000_000n; // 1.00 USDC — what the user types
const GROSS_FUND_MICRO = 1_050_000n; // net + CCTP fee + reserve — must be the burn amount

vi.mock('@starkware-libs/starknet-privacy-bridge', () => ({
  moveIntoPool: (...args: unknown[]) => moveIntoPool(...args),
  hasInflightDeposit: (...args: unknown[]) => hasInflightDeposit(...args),
  discoverPrivateBalanceForAddress: (...args: unknown[]) =>
    discoverPrivateBalanceForAddress(...args),
  getBridgeTransferStatus: (...args: unknown[]) => getBridgeTransferStatus(...args),
  // The resume hook now detects via the async chain-aware reader (#433); delegate to the
  // same sync spy so existing mockReturnValue/mockReturnValueOnce keep driving detection.
  getBridgeTransferStatusAsync: (...args: unknown[]) =>
    Promise.resolve(getBridgeTransferStatus(...args)),
  resumeBridgeTransfer: (...args: unknown[]) => resumeBridgeTransfer(...args),
  deriveViewingKey: () => 7n,
  config: { ozClassHash: '0xclasshash', cctp: { defaultEvmSourceChainId: 80002 } },
  deriveStarknetAccount: () => ({ address: '0xsnRecipient', publicKey: '0x0' }),
  deriveStarknetPrivateKey: () => 'pk',
  // Passthrough mirror of the real humanizeError for unknown errors (falls through to the
  // message unchanged) — the component now routes its error copy through it (#305 Error B).
  humanizeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  EVM_CCTP_SOURCES: {
    80002: { chainId: 80002, chainName: 'Polygon Amoy' },
    84532: { chainId: 84532, chainName: 'Base Sepolia' },
  },
}));

// Capturing spy so tests can assert the picked sourceChainId is threaded into the
// funding estimate (#198: the fee must be quoted for the picked EVM→Starknet route).
const bridgeFundingEstimate = vi.fn((..._args: unknown[]) => ({
  status: 'ready',
  plan: { fundMicro: GROSS_FUND_MICRO, betMicro: NET_AMOUNT_MICRO },
  betHuman: 1.0,
  fundHuman: 1.05,
  reserveHuman: 0.05,
  feeHuman: 0.01,
  projectedOrderHuman: 1.0,
  belowFloor: false,
}));
// Mutable so a test can bump it (a testnet↔mainnet swap) and re-render.
let currentNetworkEpoch = 0;

vi.mock('@starkware-libs/starknet-privacy-bridge/react', () => ({
  useWallet: () => ({
    address: '0xEvmAddress0000000000000000000000000000',
    // A non-source wallet reply so the seed effect falls back to the default; the
    // default-pick test asserts that. chainId/isConnected are read by the seed
    // effect's deps (#198 — re-seed on a wallet-driven chain switch).
    getProvider: () => ({ request: vi.fn().mockResolvedValue(undefined) }),
    chainId: 80002,
    isConnected: true,
  }),
  useBridgeFundingEstimate: (...args: unknown[]) => bridgeFundingEstimate(...args),
}));

// Mutable identity so a test can simulate a genuine A→B account switch WITHIN a session
// (the display snAddress flips), driving the cross-account run-generation guard.
const identity: { snAddress: string | null } = { snAddress: null };
vi.mock('../IdentityContext', () => ({
  useIdentity: () => ({
    getSignature: vi.fn().mockResolvedValue('0xsig'),
    snAddress: identity.snAddress,
    viewingKey: 7n,
    deriveIdentity: vi.fn(),
    deriveStatus: { status: 'idle' },
  }),
}));

vi.mock('../NetworkContext', () => ({
  useNetwork: () => ({
    profile: {
      network: 'testnet',
      starknetChain: 'Starknet Sepolia',
      polygonChain: 'Polygon Amoy',
      polygonChainId: 80002,
    },
    networkEpoch: currentNetworkEpoch,
  }),
}));

const setFlowInFlight = vi.fn();
vi.mock('../InFlightContext', () => ({
  useInFlight: () => ({ anyInFlight: false, setFlowInFlight }),
}));

describe('MoveIntoPool', () => {
  beforeEach(() => {
    moveIntoPool.mockClear().mockResolvedValue({ depositedNetWei: 1_000_000n, deposited: true });
    hasInflightDeposit.mockReset().mockReturnValue(false);
    discoverPrivateBalanceForAddress.mockReset().mockResolvedValue(0n);
    getBridgeTransferStatus.mockReset().mockReturnValue(null);
    resumeBridgeTransfer.mockReset().mockResolvedValue({ completed: true, amountWei: 1_000_000n });
    setFlowInFlight.mockClear();
    bridgeFundingEstimate.mockClear();
    currentNetworkEpoch = 0;
    identity.snAddress = null;
  });

  it('calls moveIntoPool with funding:metamask and the GROSS fundMicro (not the bare typed net)', async () => {
    render(<MoveIntoPool />);

    fireEvent.change(screen.getByPlaceholderText('e.g. 1.00'), { target: { value: '1.00' } });
    fireEvent.click(screen.getByRole('button', { name: /move into pool/i }));

    await waitFor(() => expect(moveIntoPool).toHaveBeenCalledTimes(1));
    const call = moveIntoPool.mock.calls[0][0];

    // Deposits INTO the pool via the EVM-wallet/CCTP path (not the treasury default).
    expect(call.funding).toBe('metamask');
    // Must burn the GROSS shown in the "Bridge reserve" row, not the bare net.
    expect(call.amountWei).toBe(GROSS_FUND_MICRO);
    expect(call.amountWei).not.toBe(NET_AMOUNT_MICRO);
  });

  it('renders the fresh-deposit confirmation with the MEASURED delta on a positive delta', async () => {
    // before=0, after=1_000_000 → delta=+1.000000; deposited === true (real deposit).
    discoverPrivateBalanceForAddress.mockResolvedValueOnce(0n).mockResolvedValueOnce(1_000_000n);
    moveIntoPool.mockResolvedValueOnce({ depositedNetWei: 1_000_000n, deposited: true });
    render(<MoveIntoPool />);

    fireEvent.change(screen.getByPlaceholderText('e.g. 1.00'), { target: { value: '1.00' } });
    fireEvent.click(screen.getByRole('button', { name: /move into pool/i }));

    await waitFor(() => expect(screen.getByText(/deposited .* into the pool/i)).toBeTruthy());
    // Shown amount is the measured delta (1.00, to the nearest cent), not the gross reserve (1.05).
    expect(screen.getByText(/deposited 1\.00 usdc into the pool/i)).toBeTruthy();
    expect(screen.queryByText(/nothing new was moved/i)).toBeNull();
  });

  // PINS THE BUGBOT HIGH (#239): a REAL landed deposit (deposited === true) must render
  // the green "Deposited" copy EVEN IF the balance read fails or lags (null/unchanged
  // delta). The old code gated success on the delta, so an indexer lag or a failed
  // discovery read mislabeled a genuine deposit as the neutral "nothing moved" no-op.
  it('renders "Deposited" for a real deposit even when the balance read returns null/unchanged', async () => {
    // Both discovery reads fail (fail-open to null); yet the deposit truly landed.
    discoverPrivateBalanceForAddress.mockRejectedValue(new Error('indexer down'));
    moveIntoPool.mockResolvedValueOnce({ depositedNetWei: 1_000_000n, deposited: true });
    render(<MoveIntoPool />);

    fireEvent.change(screen.getByPlaceholderText('e.g. 1.00'), { target: { value: '1.00' } });
    fireEvent.click(screen.getByRole('button', { name: /move into pool/i }));

    await waitFor(() => expect(screen.getByText(/deposited .* into the pool/i)).toBeTruthy());
    // Falls back to depositedNetWei (1.00, to the nearest cent) since no delta was measurable.
    expect(screen.getByText(/deposited 1\.00 usdc into the pool/i)).toBeTruthy();
    // A landed deposit is NEVER shown as a no-op.
    expect(screen.queryByText(/nothing new was moved/i)).toBeNull();
  });

  // The ONLY true no-op: the orchestrator's resume short-circuit (deposited === false)
  // — a prior run's deposit already landed, nothing new was moved THIS run.
  it('renders the neutral no-op notice only when deposited === false', async () => {
    discoverPrivateBalanceForAddress.mockResolvedValue(1_000_000n);
    moveIntoPool.mockResolvedValueOnce({ depositedNetWei: 1_000_000n, deposited: false });
    render(<MoveIntoPool />);

    fireEvent.change(screen.getByPlaceholderText('e.g. 1.00'), { target: { value: '1.00' } });
    fireEvent.click(screen.getByRole('button', { name: /move into pool/i }));

    await waitFor(() => expect(screen.getByText(/nothing new was moved/i)).toBeTruthy());
    expect(screen.queryByText(/deposited .* into the pool/i)).toBeNull();
  });

  it('shows the error box and no "done" when moveIntoPool rejects', async () => {
    moveIntoPool.mockRejectedValueOnce(new Error('bridge blew up'));
    render(<MoveIntoPool />);

    fireEvent.change(screen.getByPlaceholderText('e.g. 1.00'), { target: { value: '1.00' } });
    fireEvent.click(screen.getByRole('button', { name: /move into pool/i }));

    await waitFor(() => expect(screen.getByText(/bridge blew up/i)).toBeTruthy());
    expect(screen.queryByText(/into the pool/i)).toBeNull();
    expect(screen.queryByText(/nothing new was moved/i)).toBeNull();
  });

  // MEDIUM-1 (fund-safety): a persisted burn-but-not-minted deposit cursor is an
  // in-flight CCTP transfer that survives a reload. On mount (idle, nothing
  // running) the component must read the cursor for the connected funder and
  // report IN-FLIGHT, so NetworkContext blocks the switch. RED before the
  // hasInflightDeposit mount-read wiring; GREEN after.
  it('reports in-flight on mount when a persisted deposit cursor exists (blocks the switch)', () => {
    hasInflightDeposit.mockReturnValue(true);
    render(<MoveIntoPool />);
    expect(hasInflightDeposit).toHaveBeenCalledWith('0xEvmAddress0000000000000000000000000000');
    // Nothing is actively running, yet the flow reports itself in-flight.
    expect(setFlowInFlight).toHaveBeenCalledWith('moveIntoPool', true);
    expect(
      setFlowInFlight.mock.calls.some((c) => c[0] === 'moveIntoPool' && c[1] === false),
    ).toBe(false);
  });

  it('does NOT report in-flight on mount when there is no persisted cursor', () => {
    hasInflightDeposit.mockReturnValue(false);
    render(<MoveIntoPool />);
    expect(setFlowInFlight).toHaveBeenCalledWith('moveIntoPool', false);
    expect(
      setFlowInFlight.mock.calls.some((c) => c[0] === 'moveIntoPool' && c[1] === true),
    ).toBe(false);
  });

  // #191: source-chain picker (a custom icon dropdown — a native <select> can't render
  // per-option icons). The trigger's accessible name reflects the selected chain, and
  // picking an option forwards its chainId to fundFromMetaMask so the CCTP burn
  // originates on the chosen chain.
  const openPicker = () =>
    fireEvent.click(screen.getByRole('button', { name: /source chain:/i }));

  it('defaults the source-chain picker to config.cctp.defaultEvmSourceChainId', () => {
    render(<MoveIntoPool />);
    // Default 80002 = Polygon Amoy (per the mocked EVM_CCTP_SOURCES).
    expect(screen.getByRole('button', { name: /source chain: polygon amoy/i })).toBeTruthy();
  });

  it('forwards the picked source chain to moveIntoPool as sourceChainId', async () => {
    render(<MoveIntoPool />);

    openPicker();
    fireEvent.click(screen.getByRole('option', { name: /base sepolia/i }));
    fireEvent.change(screen.getByPlaceholderText('e.g. 1.00'), { target: { value: '1.00' } });
    fireEvent.click(screen.getByRole('button', { name: /move into pool/i }));

    await waitFor(() => expect(moveIntoPool).toHaveBeenCalledTimes(1));
    const call = moveIntoPool.mock.calls[0][0];
    expect(call.sourceChainId).toBe(84532); // Base Sepolia — the picked option
  });

  // #198 (Bugbot MEDIUM "Bridge reserve ignores source chain"): the picked chain must
  // flow into useBridgeFundingEstimate so the fee/gross is quoted for that EVM→Starknet
  // route, not the default. RED before threading sourceChainId into the hook.
  it('quotes the funding estimate for the picked source chain (3rd arg = sourceChainId)', () => {
    render(<MoveIntoPool />);
    // Seeds to the default first (3rd positional arg is the source chain id).
    expect(bridgeFundingEstimate.mock.calls.at(-1)?.[2]).toBe(80002);
    openPicker();
    fireEvent.click(screen.getByRole('option', { name: /base sepolia/i }));
    // After the pick, the estimate is re-quoted for the chosen chain.
    expect(bridgeFundingEstimate.mock.calls.at(-1)?.[2]).toBe(84532);
  });

  // #198 (Bugbot LOW "Picker stale after network swap"): a chain picked on the old
  // network must reset on a networkEpoch bump — EVM_CCTP_SOURCES is network-scoped, so
  // a stale testnet chain id would be an unsupported source after switching. RED before
  // the networkEpoch reset effect.
  it('resets the picker to the default when the network epoch bumps', () => {
    const { rerender } = render(<MoveIntoPool />);
    openPicker();
    fireEvent.click(screen.getByRole('option', { name: /base sepolia/i }));
    expect(screen.getByRole('button', { name: /source chain: base sepolia/i })).toBeTruthy();

    // Simulate a testnet↔mainnet swap: bump the epoch and re-render.
    act(() => {
      currentNetworkEpoch = 1;
    });
    rerender(<MoveIntoPool />);
    expect(screen.getByRole('button', { name: /source chain: polygon amoy/i })).toBeTruthy();
  });

  // ── Resume / recovery (Phase 2) ──────────────────────────────────────────────

  const IN_POOL_STATUS = {
    direction: 'into-pool' as const,
    phase: 'pool-deposit' as const,
    needsSignature: false,
    amountWei: 1_000_000n,
    account: { snAddress: '0xsnRecipient', evmAddress: '0xEvmAddress0000000000000000000000000000' },
  };

  // (a) A detected in-flight transfer HIDES the normal action and shows the Continue /
  // resume affordance instead — so a stale cursor can never be silently mis-completed.
  // The into-pool deposit is NOT auto-fired: it waits for an explicit Continue click.
  it('hides the normal action and shows the Continue affordance when a transfer is detected', async () => {
    getBridgeTransferStatus.mockReturnValue(IN_POOL_STATUS);
    render(<MoveIntoPool />);

    // Detection is async now (may fall back to an on-chain read) → await the notice.
    expect(await screen.findByText(/interrupted transfer detected/i)).toBeTruthy();
    // Normal primary action + amount input are gone; the deposit-specific Continue shows.
    expect(screen.queryByRole('button', { name: /^move into pool$/i })).toBeNull();
    expect(screen.queryByPlaceholderText('e.g. 1.00')).toBeNull();
    expect(screen.getByRole('button', { name: /continue deposit/i })).toBeTruthy();
    // The into-pool deposit must NOT auto-fire — it waits for the click.
    await new Promise((r) => setTimeout(r, 20));
    expect(resumeBridgeTransfer).not.toHaveBeenCalled();
  });

  // (b) An explicit Continue click resumes the detected deposit ONCE, with the identity
  // signature + the EVM provider (the into-pool composite needs it).
  it('resumes a detected deposit on an explicit Continue click with the right args', async () => {
    getBridgeTransferStatus.mockReturnValue(IN_POOL_STATUS);
    render(<MoveIntoPool />);

    const btn = await screen.findByRole('button', { name: /continue deposit/i });
    fireEvent.click(btn);

    await waitFor(() => expect(resumeBridgeTransfer).toHaveBeenCalledTimes(1));
    const call = resumeBridgeTransfer.mock.calls[0][0];
    expect(call.status.phase).toBe('pool-deposit');
    expect(call.signature).toBe('0xsig');
    // The provider is threaded through even though NO new signature is requested.
    expect(call.provider).toBeTruthy();
  });

  // (d) A PENDING_POOL_DEPOSIT thrown by moveIntoPool on a FRESH submit must surface the
  // Continue affordance (the SDK fails closed rather than depositing the leftover), NOT
  // a raw error box.
  it('converts a PENDING_POOL_DEPOSIT from moveIntoPool into the Continue affordance', async () => {
    // Nothing in flight at mount → normal form; the cursor becomes visible only after
    // the fail-closed throw triggers a recheck.
    getBridgeTransferStatus.mockReturnValueOnce(null).mockReturnValue(IN_POOL_STATUS);
    const pending = Object.assign(new Error('pending pool deposit not-a-user-error'), {
      code: 'PENDING_POOL_DEPOSIT',
      pendingNetWei: 1_000_000n,
    });
    moveIntoPool.mockRejectedValueOnce(pending);
    render(<MoveIntoPool />);

    fireEvent.change(screen.getByPlaceholderText('e.g. 1.00'), { target: { value: '1.00' } });
    fireEvent.click(screen.getByRole('button', { name: /move into pool/i }));

    await waitFor(() => expect(screen.getByText(/interrupted transfer detected/i)).toBeTruthy());
    // The raw PENDING error text is NEVER shown as an error box.
    expect(screen.queryByText(/pending pool deposit not-a-user-error/i)).toBeNull();
  });

  // (e) No in-flight status ⇒ the normal action shows and a fresh submit works, and the
  // resume engine was consulted for this identity.
  it('shows the normal action and runs a fresh submit when nothing is in flight', async () => {
    render(<MoveIntoPool />);
    expect(getBridgeTransferStatus).toHaveBeenCalled();
    expect(resumeBridgeTransfer).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /move into pool/i })).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('e.g. 1.00'), { target: { value: '1.00' } });
    fireEvent.click(screen.getByRole('button', { name: /move into pool/i }));
    await waitFor(() => expect(moveIntoPool).toHaveBeenCalledTimes(1));
  });

  // ── Cross-account run-generation guard (BUG-1 parity with MoveFromPool) ──────
  // moveIntoPool is awaited INSIDE handleSubmit; App.tsx renders <MoveIntoPool/> with no
  // key, so an A→B account switch does NOT remount it. A run started under A that resolves
  // AFTER the switch must be a FULL no-op on shared UI state — it must NOT repaint A's
  // deposited amount / step under B's identity. RED before the run-generation gate (the
  // stale terminal setStatus repaints "Deposited … into the pool"); GREEN after (gated →
  // status stays idle / normal form for B).
  const DERIVED_A = '0xDerivedAddressAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const DERIVED_B = '0xDerivedAddressBBBBBBBBBBBBBBBBBBBBBBBBBB';

  it('does NOT repaint the old deposit result after an A→B account switch mid-run', async () => {
    identity.snAddress = DERIVED_A;
    // Hold moveIntoPool pending so we can switch identity BEFORE it resolves.
    let resolveMove: (v: { depositedNetWei: bigint; deposited: boolean }) => void = () => {};
    moveIntoPool.mockImplementationOnce(
      () => new Promise((res) => { resolveMove = res; }),
    );

    const { rerender } = render(<MoveIntoPool />);
    fireEvent.change(screen.getByPlaceholderText('e.g. 1.00'), { target: { value: '1.00' } });
    fireEvent.click(screen.getByRole('button', { name: /move into pool/i }));

    // The run reached the (pending) moveIntoPool leg under identity A.
    await waitFor(() => expect(moveIntoPool).toHaveBeenCalledTimes(1));

    // A GENUINE account switch A→B (no remount — status survives).
    identity.snAddress = DERIVED_B;
    rerender(<MoveIntoPool />);

    // Now the stale run resolves — its terminal write must be gated out.
    await act(async () => {
      resolveMove({ depositedNetWei: 1_000_000n, deposited: true });
      await new Promise((r) => setTimeout(r, 20));
    });

    // The old run must NOT repaint A's deposited amount under B.
    expect(screen.queryByText(/into the pool/i)).toBeNull();
    expect(screen.queryByText(/nothing new was moved/i)).toBeNull();
    // The normal form for the (new) identity is shown — status reset to idle.
    expect(screen.getByRole('button', { name: /move into pool/i })).toBeTruthy();
  });

  it('still reaches "Deposited" for a normal same-identity deposit (no over-gating)', async () => {
    // Same identity throughout (A) — the guard must NOT suppress a legitimate result.
    identity.snAddress = DERIVED_A;
    discoverPrivateBalanceForAddress.mockResolvedValueOnce(0n).mockResolvedValueOnce(1_000_000n);
    moveIntoPool.mockResolvedValueOnce({ depositedNetWei: 1_000_000n, deposited: true });
    render(<MoveIntoPool />);

    fireEvent.change(screen.getByPlaceholderText('e.g. 1.00'), { target: { value: '1.00' } });
    fireEvent.click(screen.getByRole('button', { name: /move into pool/i }));

    await waitFor(() => expect(screen.getByText(/deposited 1\.00 usdc into the pool/i)).toBeTruthy());
  });
});
