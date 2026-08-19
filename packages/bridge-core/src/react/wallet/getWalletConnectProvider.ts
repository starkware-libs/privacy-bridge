// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// WalletConnect v2 (Reown) lazy-singleton provider for the bridge-core wallet
// layer. WC is ONE of the wallet paths — it coexists with injected EIP-6963
// extensions (see injectedProvider.ts). registerWalletConnect() inserts the WC
// provider into the shared discovery registry as a single synthetic entry
// (rdns 'walletconnect') so it flows through the same picker → selectProvider →
// signMessage path as the injected wallets. WC uses its BUILT-IN modal
// (showQrModal) for the QR/mobile flow — no custom QR UI / no extra dep.
//
// Feature opt-in: config.walletConnectProjectId must be set (free, from
// cloud.reown.com — the app supplies it via injected config). When unset,
// getWalletConnectProvider() returns null and no WC entry is added to the picker;
// tests mock this module so they never need a real projectId / relay.
//
// The WC EthereumProvider requires an explicit connect() call before any
// request() — WalletProvider gates all pre-session request() calls on whether a
// session exists.

import { config } from '../../core/config.js';
import type { EthereumProvider } from './signMessage.js';
import { registerProvider, unregisterProvider } from './injectedProvider.js';

// The WC EthereumProvider exposes connect(), disconnect(), and session beyond
// EIP-1193. We use these for the session lifecycle gates in WalletProvider.
// `session` mirrors the WC SDK getter (undefined = no active pairing).
export type WcProvider = EthereumProvider & {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  session?: unknown;
};

// The chains the standalone app supports. Ethereum + Sepolia + Polygon + Amoy so
// the runtime testnet/mainnet toggle works WITHOUT re-pairing the WC session.
// Only chain 1 is REQUIRED (every WC wallet supports Ethereum mainnet, so pairing
// never fails on the required set); the rest are optional, enabled on the session
// when the wallet supports them.
// Typed as non-empty tuples — WC's EthereumProviderOptions requires
// `optionalChains` to be ArrayOneOrMore<number> (at least one known element).
const REQUIRED_CHAINS: [number, ...number[]] = [1];
const OPTIONAL_CHAINS: [number, ...number[]] = [1, 11155111, 137, 80002];

// Per-chain RPC the WC SDK uses for read calls. Polygon (137) and Amoy (80002)
// read from bridge-core config when its `polygon` entry matches that chain id (so
// a configured override flows through); the other chains + the non-matching
// Polygon variant fall back to public RPCs.
function buildRpcMap(): Record<number, string> {
  const map: Record<number, string> = {
    1: 'https://ethereum-rpc.publicnode.com',
    11155111: 'https://ethereum-sepolia-rpc.publicnode.com',
    137: 'https://polygon-bor-rpc.publicnode.com',
    80002: 'https://rpc-amoy.polygon.technology',
  };
  // Prefer the configured Polygon RPC for whichever Polygon chain config targets
  // (mainnet 137 or testnet Amoy 80002), so a POLYGON_RPC_URL override wins.
  if (config.polygon.chainId === 137 || config.polygon.chainId === 80002) {
    map[config.polygon.chainId] = config.polygon.rpcUrl;
  }
  return map;
}

// Module-level singleton: init happens at most once per page load. Subsequent
// calls (StrictMode double-mount, repeated connect touches) reuse the same
// instance without re-initialising the relay connection.
let providerPromise: Promise<WcProvider | null> | null = null;

export function getWalletConnectProvider(): Promise<WcProvider | null> {
  if (providerPromise) return providerPromise;
  // On failure (bad projectId, relay unreachable, dynamic-import error) RESET the
  // singleton so a later attempt can re-init, rather than locking every caller to
  // a permanently-rejected promise until a full page reload.
  providerPromise = initProvider().catch((err) => {
    providerPromise = null;
    throw err;
  });
  return providerPromise;
}

async function initProvider(): Promise<WcProvider | null> {
  // DEV/TEST-ONLY E2E seam (off by default; gated by the injected config.e2eWallet
  // flag). When set, return a synthetic in-memory EIP-1193 provider instead of the
  // real WC relay so chrome-MCP automation can drive connect→sign without a
  // QR/phone. e2eTestProvider stays behind a dynamic import so it lives in its own
  // lazy chunk that a normal build never fetches (config.e2eWallet unset); the inner
  // isE2EWalletEnabled() call is kept for defense in depth. See e2eTestProvider.ts.
  if (config.e2eWallet) {
    const { isE2EWalletEnabled, createE2ETestProvider } = await import('./e2eTestProvider.js');
    if (isE2EWalletEnabled()) {
      return createE2ETestProvider();
    }
  }

  const projectId = config.walletConnectProjectId;
  if (!projectId) return null;

  // Dynamic import keeps WC and its modal out of the entry chunk — it only loads
  // when the wallet layer first asks for the provider, not at page parse.
  const { EthereumProvider: WcEthereumProvider } = await import(
    '@walletconnect/ethereum-provider'
  );

  const provider = await WcEthereumProvider.init({
    projectId,
    // Ethereum mainnet is the only REQUIRED chain so pairing never fails on the
    // required set; the standalone app's testnet/mainnet toggle is served from the
    // optional set without re-pairing.
    chains: REQUIRED_CHAINS,
    optionalChains: OPTIONAL_CHAINS,
    rpcMap: buildRpcMap(),
    showQrModal: true, // use WC's built-in modal — no custom QR UI / no extra dep
    metadata: {
      name: 'Polymarket Privacy',
      description: 'Private swaps on Polymarket via the starknet-privacy pool',
      url: typeof window !== 'undefined' ? window.location.origin : '',
      icons:
        typeof window !== 'undefined' ? [`${window.location.origin}/favicon.ico`] : [],
    },
  });

  // Cast to our local EthereumProvider surface. The WC EthereumProvider already
  // implements request/on/removeListener and exposes `isWalletConnect` (a getter
  // returning true) and `session` (undefined until paired).
  return provider as unknown as WcProvider;
}

// Inline data-URI SVG: the WalletConnect mark (two overlapping arcs on blue).
// Self-contained — no external URL — so it works offline and passes the strict
// CSP. Kept intentionally small.
const WC_ICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
      '<rect width="64" height="64" rx="12" fill="#3B99FC"/>' +
      '<path d="M18 26c7.7-7.7 20.3-7.7 28 0l.9.9-4 4-.9-.9' +
      'c-5.3-5.3-13.9-5.3-19.2 0l-1 1-4-4 1-1z' +
      'M54 35.3l3.6 3.5-17.6 17.6-4-4L36 52l3.6-3.6 3.5 3.5' +
      'L54 35.3zM10 35.3L26.4 52l-3.5 3.5L10 42.6' +
      'l-3.5 3.5-4-4L10 35.3z" fill="#fff"/>' +
      '</svg>',
  );

// The rdns of the synthetic WalletConnect entry in the shared registry. MUST stay
// in sync with SYNTHETIC_PROVIDER_RDNS in injectedProvider.ts (so WC never counts
// toward the injected-global ambiguity guard).
export const WALLETCONNECT_RDNS = 'walletconnect';

// Register the WC provider into the EIP-6963 discovery registry (the same map
// that selectProvider + getDiscoveredProviders read from), so the picker shows it
// and provider selection routes through the right instance. Best-effort: a WC
// init failure (bad projectId, relay/import error) must never throw an unhandled
// rejection or break the picker — the app works fine without WC (injected wallets
// are unaffected; no WC entry is added). Idempotent (registerProvider is keyed by
// rdns), so StrictMode double-mount / repeated calls are safe.
export async function registerWalletConnect(): Promise<void> {
  try {
    const provider = await getWalletConnectProvider();
    if (!provider) return;
    registerProvider({
      info: {
        uuid: WALLETCONNECT_RDNS,
        name: 'WalletConnect',
        rdns: WALLETCONNECT_RDNS,
        icon: WC_ICON,
      },
      provider,
    });
  } catch {
    // WC unavailable this session — leave the picker to injected wallets only.
  }
}

// Best-effort session teardown: disconnects the WC relay so a stale `wc@2:*`
// localStorage session can't silently rehydrate on the next visit. Swallows all
// errors — never throws (called from the fire-and-forget disconnect() path).
export async function disconnectWalletConnect(): Promise<void> {
  try {
    const provider = await getWalletConnectProvider();
    // Only disconnect if a live session exists; a session-less provider has
    // nothing to tear down and calling disconnect() on it may throw.
    if (provider?.session) {
      await provider.disconnect();
    }
  } catch {
    // Swallow — best-effort only.
  }
}

// FUND-SAFETY (Bugbot MEDIUM — "WC config stale after switch"): the singleton
// above is built ONCE per page load, baking buildRpcMap()'s Polygon RPC from the
// config active at THAT moment. A runtime network switch (setActiveNetwork) flips
// the live config Proxy, but the already-built WC provider keeps the OLD network's
// rpcMap — so a WC reconnect after the switch would read Polygon over the wrong
// network's RPC. On switch, tear down the session AND NULL the singleton so the
// NEXT getWalletConnectProvider() re-inits and rebuilds the rpcMap from the now-
// active config. Best-effort; never throws (called from the switch/disconnect path).
export async function resetWalletConnectProvider(): Promise<void> {
  await disconnectWalletConnect();
  // Drop the memoized instance: the next getWalletConnectProvider() re-runs
  // initProvider(), which calls buildRpcMap() against the current config.
  providerPromise = null;
  // #234: also drop the stale entry from the shared EIP-6963 discovery registry —
  // otherwise the picker keeps listing WalletConnect as available even though
  // selecting it would route through this now-dropped instance. registerWalletConnect()
  // re-adds it the next time a caller resolves the provider.
  unregisterProvider(WALLETCONNECT_RDNS);
}
