// EIP-6963 injected (browser-extension) wallet discovery + selection for the
// bridge-core wallet layer. Ported from the pre-split apps/web/src/wallet/ethereum.ts
// (removed in 48d0b66) so the MetaMask/Rabby/… EXTENSION connects directly, while
// WalletConnect keeps working — both flow through ONE registry + picker.
//
// This module owns ONLY discovery + provider resolution. The EIP-1193 request
// helpers (signMessage with its signer-binding guard, switchChain) live in
// signMessage.ts; we reuse its EthereumProvider interface rather than redefining it.

import type { EthereumProvider } from './signMessage';

// EIP-6963 provider metadata an extension announces about itself.
export interface EIP6963ProviderInfo {
  uuid: string;
  name: string;
  rdns: string;
  icon: string;
}

// The { info, provider } pair carried in an `eip6963:announceProvider` event.
export interface EIP6963ProviderDetail {
  info: EIP6963ProviderInfo;
  provider: EthereumProvider;
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
  interface WindowEventMap {
    'eip6963:announceProvider': CustomEvent<EIP6963ProviderDetail>;
  }
}

// --- EIP-6963 multi-wallet discovery + selection -------------------------------
// Why: with several extensions installed (e.g. MetaMask + Phantom), the last one
// to load wins `window.ethereum`. EIP-6963 lets each wallet ANNOUNCE itself so
// the user can pick; every request must then go to the PICKED provider, not the
// raw window.ethereum global. Discovery state is module-level so the provider
// helpers and the React context share one source of truth.

// rdns -> announced detail. Keyed by rdns (stable per wallet); we also index
// uuid -> rdns so selection accepts either identifier.
const discovered = new Map<string, EIP6963ProviderDetail>();
const uuidToRdns = new Map<string, string>();
let selectedRdns: string | null = null;
let announceListener: ((e: WindowEventMap['eip6963:announceProvider']) => void) | null = null;

function onAnnounce(event: WindowEventMap['eip6963:announceProvider']) {
  const detail = event.detail;
  if (!detail?.info?.rdns || !detail.provider) return;
  discovered.set(detail.info.rdns, detail);
  uuidToRdns.set(detail.info.uuid, detail.info.rdns);
}

// Start listening for announcements and ask any present wallets to (re-)announce.
// Idempotent: registers the listener once. Call from the React provider on mount.
export function discoverProviders(): void {
  if (typeof window === 'undefined') return;
  if (!announceListener) {
    announceListener = onAnnounce;
    window.addEventListener('eip6963:announceProvider', announceListener);
  }
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

// Register a provider that is NOT an injected EIP-6963 extension (e.g.
// WalletConnect) into the SAME discovery registry, so it flows through the
// picker → selectProvider → getEthereumProvider path identically. Mirrors
// onAnnounce; keyed by rdns so re-registration is idempotent.
export function registerProvider(detail: EIP6963ProviderDetail): void {
  if (!detail?.info?.rdns || !detail.provider) return;
  discovered.set(detail.info.rdns, detail);
  uuidToRdns.set(detail.info.uuid, detail.info.rdns);
}

// Counterpart to registerProvider (#234): drop a synthetic entry (WalletConnect)
// from the shared registry. Without this, resetting/tearing down the WC provider
// (e.g. on a network switch) leaves a STALE entry in `discovered` — the picker
// keeps showing WalletConnect as available even though selecting it would
// re-init against the dropped instance. Also clears the reverse uuid index. A
// missing/unknown rdns is a no-op (idempotent, mirrors registerProvider).
export function unregisterProvider(rdns: string): void {
  const detail = discovered.get(rdns);
  if (!detail) return;
  discovered.delete(rdns);
  if (uuidToRdns.get(detail.info.uuid) === rdns) uuidToRdns.delete(detail.info.uuid);
  if (selectedRdns === rdns) selectedRdns = null;
}

// Snapshot of the providers discovered so far (for the wallet picker).
export function getDiscoveredProviders(): EIP6963ProviderDetail[] {
  return Array.from(discovered.values());
}

// rdns values of SYNTHETIC discovery entries — providers we register ourselves
// that do NOT inject into `window.ethereum` and so never contend for it. Keep in
// sync with the `info.rdns` used at the registerProvider call site
// (getWalletConnectProvider.ts's registerWalletConnect).
const SYNTHETIC_PROVIDER_RDNS = new Set<string>(['walletconnect']);

// True for a registry entry we register ourselves rather than one an extension injected.
// Exported so callers don't re-hardcode the list: restoring a REMEMBERED wallet pick
// (WalletProvider) must skip synthetic entries — pinning one would reroute a bare
// connect()/sign away from the injected global while giving nothing back, since a WC
// session is never silently resumable.
export function isSyntheticProviderRdns(rdns: string): boolean {
  return SYNTHETIC_PROVIDER_RDNS.has(rdns);
}

// Count of discovered providers that genuinely CONTEND for the `window.ethereum`
// global — i.e. real injected extensions. The ambiguity the lifecycle guards
// protect against is two injected wallets racing for that global (MetaMask +
// Phantom): only then is a bare-global silent read unattributable. Synthetic
// entries (WalletConnect) live only in our registry and never touch the global,
// so they must NOT count toward that ambiguity — counting them over-fires the
// guard (WC + one injected wallet => count 2 while the global is unambiguous).
export function injectedProviderCount(): number {
  return getDiscoveredProviders().filter((d) => !SYNTHETIC_PROVIDER_RDNS.has(d.info.rdns)).length;
}

// A WalletConnect provider with no live session. WC throws "call connect()
// before request()" until a session is opened, so the WalletProvider gates skip
// every pre-connect request() (silent eth_accounts, eth_chainId, listener bind)
// for one. `session` is set by the WC SDK once pairing completes.
export function isSessionlessWalletConnect(provider: EthereumProvider | undefined): boolean {
  if (!provider?.isWalletConnect) return false;
  return !(provider as EthereumProvider & { session?: unknown }).session;
}

// Pick the provider all subsequent requests route through. Accepts an rdns or a
// uuid; unknown identifiers are a no-op (keep the prior selection / fallback).
export function selectProvider(rdnsOrUuid: string): EIP6963ProviderDetail | undefined {
  const rdns = discovered.has(rdnsOrUuid) ? rdnsOrUuid : uuidToRdns.get(rdnsOrUuid);
  if (!rdns || !discovered.has(rdns)) return undefined;
  selectedRdns = rdns;
  return discovered.get(rdns);
}

function getSelectedProviderDetail(): EIP6963ProviderDetail | undefined {
  return selectedRdns ? discovered.get(selectedRdns) : undefined;
}

// Drop ONLY the module-level pin (the user's provider pick), keeping the
// discovered registry intact — the wallets are still installed. disconnect() /
// "Forget device" must call this: clearing the React selectedRdns state alone
// leaves this module pin set, so getEthereumProvider() would keep PREFERRING the
// previously-picked provider and a bare connect()/sign could route to the PREVIOUS
// wallet while the UI shows no selection (the wrong-wallet-routing class PR #124
// guarded). After this, getEthereumProvider() falls back to the normal (unpinned)
// resolution and the ambiguous-multi guard holds.
export function clearSelectedProvider(): void {
  selectedRdns = null;
}

// Test seam: clear discovery + selection between cases.
export function resetProviderDiscovery(): void {
  if (announceListener && typeof window !== 'undefined') {
    window.removeEventListener('eip6963:announceProvider', announceListener);
  }
  announceListener = null;
  discovered.clear();
  uuidToRdns.clear();
  selectedRdns = null;
}

// The provider every request should use, in priority order:
//   1. The provider the user PICKED (selectProvider) — PINNING: once selected,
//      this returns THAT provider before ANY fallback (the load-bearing guarantee
//      that a foreign extension can't hijack the signer — PR #124).
//   2. The bare window.ethereum global (the single-injected-wallet / E2E path).
//   3. The SOLE discovered provider when neither of the above applies — this is
//      the "sole WC entry" case: WalletConnect is the only registered provider,
//      nothing is injected into window.ethereum, and bare connect() must reach it.
//      Only used when EXACTLY ONE provider is discovered, so it can never mask the
//      ambiguous-multi hazard (which requires 2+ injected providers, guarded
//      separately via injectedProviderCount()).
export function getEthereumProvider(): EthereumProvider | undefined {
  const selected = getSelectedProviderDetail()?.provider;
  if (selected) return selected;
  const global = typeof window !== 'undefined' ? window.ethereum : undefined;
  if (global) return global;
  const all = getDiscoveredProviders();
  return all.length === 1 ? all[0].provider : undefined;
}

export function hasMetaMask(): boolean {
  if (typeof window !== 'undefined' && window.ethereum?.isMetaMask) return true;
  // An injected wallet may have lost the window.ethereum race; trust EIP-6963.
  return getDiscoveredProviders().some((d) => d.info.rdns === 'io.metamask');
}

export async function requestAccounts(provider: EthereumProvider): Promise<string[]> {
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('No accounts returned');
  }
  return accounts as string[];
}
