// FUND-SAFETY (Bugbot MEDIUM — "WC config stale after switch"): the WC provider is
// a module-level lazy singleton whose rpcMap is baked from config.polygon at init.
// A runtime network switch flips the live config, but the already-built provider
// keeps the OLD network's rpcMap. resetWalletConnectProvider() must drop the
// singleton so the NEXT getWalletConnectProvider() rebuilds the rpcMap from the
// now-active config.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ENV_VARS } from '../../../vitest.setup';

// Capture the rpcMap passed to EthereumProvider.init on each (re)init.
const initCalls: Array<Record<number, string>> = [];
const fakeProvider = { session: undefined, disconnect: vi.fn(async () => {}) };

vi.mock('@walletconnect/ethereum-provider', () => ({
  EthereumProvider: {
    init: vi.fn(async (opts: { rpcMap: Record<number, string> }) => {
      initCalls.push(opts.rpcMap);
      return fakeProvider;
    }),
  },
}));

// registerProvider is a no-op sink here — we only exercise the singleton lifecycle.
const { mockUnregisterProvider } = vi.hoisted(() => ({ mockUnregisterProvider: vi.fn() }));
vi.mock('./injectedProvider', () => ({
  registerProvider: vi.fn(),
  unregisterProvider: mockUnregisterProvider,
}));

// Config is INJECTED (Slice X). This suite needs vi.resetModules() to reset the WC
// module singleton + the mock's initCalls, which re-imports a FRESH config module
// instance — so we must initBridgeConfig on THAT instance (not the setup's). A WC
// projectId must be set or initProvider() short-circuits to null; POLYGON_CHAIN_ID
// is blanked so the per-network default applies (testnet=80002 / mainnet=137 differ).
async function loadModules() {
  vi.resetModules();
  const wc = await import('./getWalletConnectProvider');
  const config = await import('../../core/config');
  config.initBridgeConfig({
    dev: true,
    prod: false,
    vars: {
      ...TEST_ENV_VARS,
      WALLETCONNECT_PROJECT_ID: 'test-project-id',
      POLYGON_CHAIN_ID: '',
      POLYGON_RPC_URL: '',
    },
  });
  return { ...wc, ...config };
}

beforeEach(() => {
  initCalls.length = 0;
});

afterEach(() => {
  vi.resetModules();
});

describe('resetWalletConnectProvider — rebuilds rpcMap from the active network (Bugbot MEDIUM)', () => {
  it('after a network switch, a fresh WC provider targets the NEW network polygon chain', async () => {
    const { getWalletConnectProvider, resetWalletConnectProvider, setActiveNetwork } =
      await loadModules();

    // Start on testnet: rpcMap carries Amoy (80002), NOT Polygon mainnet (137).
    setActiveNetwork('testnet');
    await getWalletConnectProvider();
    expect(initCalls).toHaveLength(1);
    expect(initCalls[0]).toHaveProperty('80002');
    const testnetAmoyRpc = initCalls[0][80002];

    // WITHOUT a reset, the singleton is reused — no new init even after the switch.
    setActiveNetwork('mainnet');
    await getWalletConnectProvider();
    expect(initCalls).toHaveLength(1); // stale singleton, no rebuild — the bug.

    // RESET on switch: the next getWalletConnectProvider re-inits from the NOW-active
    // (mainnet) config, so the rpcMap carries Polygon mainnet (137).
    await resetWalletConnectProvider();
    await getWalletConnectProvider();
    expect(initCalls).toHaveLength(2);
    const mainnetMap = initCalls[1];
    expect(mainnetMap).toHaveProperty('137');
    // The mainnet map targets a DIFFERENT polygon chain than the testnet one.
    expect(mainnetMap[137]).not.toBe(testnetAmoyRpc);
    expect(mainnetMap[137]).not.toBeUndefined();

    // restore
    setActiveNetwork('testnet');
  });
});

describe('resetWalletConnectProvider — drops the stale discovery entry (#234)', () => {
  it('unregisters the WalletConnect rdns from the shared EIP-6963 registry on reset', async () => {
    mockUnregisterProvider.mockClear();
    const { getWalletConnectProvider, resetWalletConnectProvider, WALLETCONNECT_RDNS } =
      await loadModules();

    await getWalletConnectProvider();
    await resetWalletConnectProvider();

    // Pre-fix: resetWalletConnectProvider never calls unregisterProvider at all —
    // the picker keeps listing a WC entry that routes to the dropped instance.
    expect(mockUnregisterProvider).toHaveBeenCalledWith(WALLETCONNECT_RDNS);
  });
});
