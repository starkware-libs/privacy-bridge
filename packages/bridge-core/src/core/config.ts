// Bridge config — INJECTED, framework-agnostic (no build-tool env coupling).
// This is the bridge-core portion of the config — network, Starknet RPC/prover/indexer,
// pool, anonymizer, CCTP, Polygon, AVNU, admin. Trading-specific config (CLOB,
// builder creds, CTF addresses) stays in apps/web/src/starknet/config.ts.
//
// CONFIG INJECTION (Slice X — repo-extraction readiness): bridge-core reads NO app
// build-time env. The consuming app reads its OWN env at startup and hands the
// values in via `initBridgeConfig(env)` (see initBridge.ts in each app).
// `BridgeEnv` is a plain registry — `vars` are the app env vars with their app
// prefix STRIPPED (e.g. `NETWORK`, `CHAIN_ID`, `ADMIN_ADDRESS`), plus `dev`/`prod`
// build flags. `bridgeEnvFromRecord(source, prefix)` builds one from an app env
// object. Every value stays individually overridable; the SDK owns the
// network-scoped DEFAULTS below (baked, no env needed for them).
//
// RUNTIME NETWORK SWITCH (apps/bridge only): the config is not a single load-time
// `const`. `configFor(n, env)` is a pure factory returning every per-network value;
// a runtime holder (`getActiveConfig`/`setActiveNetwork`) selects the active one,
// and `config` / `EVM_CCTP_SOURCES` are live Proxies over it so existing `config.X`
// call sites observe a swap with no rename. apps/bridge drives `setActiveNetwork`
// from its NetworkContext; apps/web (mainnet-only) never calls it. The CCTP
// burn/mint fund-safety invariant (source+dest on ONE network) is preserved:
// `evmCctpSources` is network-SELECTED, never merged (see below).
//
// rpcUrl/proverUrl/indexerUrl point at SAME-ORIGIN proxied paths in dev: the real
// upstream URLs live in the app's env and are wired into the Vite dev proxy
// (see each app's vite.config.ts). In apps/bridge these are PER-NETWORK path prefixes
// (`/rpc/testnet`, `/rpc/mainnet`, …) so BOTH networks' upstreams are reachable
// from one dev origin. These proxied paths are DEV-ONLY — in production the
// browser would reach the prover/indexer over OHTTP (see docs/threat-model.md),
// one OHTTP gateway PER network, not a same-origin proxy.

// Injected env registry. `vars` are the app's env vars with the app prefix
// stripped (string-valued); `dev`/`prod` are the build-mode flags (the app's
// dev/prod build indicators). Keeping the string vars under `vars` (separate from
// the boolean flags) keeps every `env.vars.X` read typed `string | undefined`.
export interface BridgeEnv {
  readonly dev?: boolean;
  readonly prod?: boolean;
  readonly vars: Readonly<Record<string, string | undefined>>;
}

// Build a BridgeEnv from an app env object: copy the DEV/PROD flags and every key
// that begins with `prefix` (the prefix stripped). Lives here so the SDK documents
// the expected mapping, but takes the prefix as an ARGUMENT so bridge-core never
// hard-codes the app's env-var convention (kept out of the SDK per Slice X). Apps
// call it with their own env object and prefix (e.g. the app's build-time env).
export function bridgeEnvFromRecord(
  source: Readonly<Record<string, unknown>>,
  prefix: string,
): BridgeEnv {
  const vars: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith(prefix)) continue;
    if (typeof value === 'string' || value === undefined) {
      vars[key.slice(prefix.length)] = value;
    }
  }
  return { dev: Boolean(source.DEV), prod: Boolean(source.PROD), vars };
}

// The injected env is stashed on globalThis so a module-registry reset
// (vi.resetModules in tests) recovers it in the fresh module instance without a
// re-init. Defined before `network`/`configFor` so their module-load reads resolve.
const ENV_GLOBAL_KEY = '__bridgeCoreInjectedEnv__';
type EnvGlobal = { [ENV_GLOBAL_KEY]?: BridgeEnv };
function readGlobalEnv(): BridgeEnv | null {
  return (globalThis as EnvGlobal)[ENV_GLOBAL_KEY] ?? null;
}

// Admin (gas-funder) keys must NEVER ship to production. They exist only for
// the testnet admin-funded deploy/fund path. We surface them under
// `config.admin` ONLY in a genuine development build (env.dev is
// true), hard-fail a production build that still has an admin private key
// set, and return undefined for any other (non-dev, non-prod) mode so an admin
// key can't silently leak into a previewed/deployed bundle.
// TODO(monday-item): replace admin-funded deploy/fund with the AVNU paymaster
// (SNIP-29) and remove the admin key entirely.
type AdminConfig = { address: string; privateKey: string };

function resolveAdmin(e: BridgeEnv): AdminConfig | undefined {
  const address = e.vars.ADMIN_ADDRESS ?? '';
  const privateKey = e.vars.ADMIN_PRIVATE_KEY ?? '';
  if (e.prod) {
    if (privateKey) {
      throw new Error(
        'ADMIN_PRIVATE_KEY must not be set in a production build — the admin-funded ' +
          'path is testnet/dev-only (see TODO(monday-item): AVNU paymaster).',
      );
    }
    return undefined;
  }
  // Only inline the admin key in a genuine development build. A non-prod,
  // non-dev mode (e.g. `vite build --mode preview`) must NOT silently ship the
  // key — fall through to undefined so callers hit the explicit
  // "no admin configured" error instead of a leaked treasury key.
  if (!e.dev) return undefined;
  return { address, privateKey };
}

// Target network. 'testnet' keeps every default IDENTICAL to today; 'mainnet'
// flips the network-scoped DEFAULTS (the Starknet-side CCTP destination, deposit
// token, Polygon block, the EVM source registry, and the default source chain)
// to mainnet values. Every field stays individually overridable via its own
// env var — the network only changes the fallback.
// Selecting the EVM source registry by network (not merging both) is deliberate:
// it stops a TESTNET config from burning REAL USDC if MetaMask happens to be on a
// mainnet chain (the mint would target the testnet transmitter and strand funds).
// See docs/mainnet-cutover-plan.md.
export type Network = 'testnet' | 'mainnet';

// Normalize the `NETWORK` env var — trim + lowercase, then accept the two documented
// values. Unset/empty defaults to testnet (safe production default; mainnet is opt-in).
// Any other value throws — a typo like `NETWORK=Main` used to silently fall through to
// testnet on a mainnet cutover, shipping a build wired to testnet endpoints (bug-hunt B2).
function normalizeNetwork(raw: string | undefined): Network {
  if (raw === undefined || raw === '') return 'testnet';
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'mainnet' || normalized === 'testnet') return normalized;
  throw new Error(
    `NETWORK env var must be 'mainnet' or 'testnet' (got: ${JSON.stringify(raw)}).`,
  );
}

// Parse a numeric env var — accept undefined/'' (falls back to `def`), reject any other
// non-numeric value LOUDLY instead of silently producing NaN downstream (bug-hunt B3).
// The former `Number(e.vars.X || default)` accepted a truthy garbage string ("foo") and
// let `NaN` leak into config fields feeding CCTP calldata and MetaMask chain-switches.
function envInt(raw: string | undefined, def: number, key: string): number {
  if (raw === undefined || raw === '') return def;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${key} must be a numeric string (got: ${JSON.stringify(raw)}).`);
  }
  return parsed;
}

// The BUILD-TIME default network (the `NETWORK` env var). apps/web pins to this for
// its whole lifetime; apps/bridge starts here and may swap at runtime. Set by
// `initBridgeConfig` from the injected env; recovered from the globalThis stash on a
// fresh module load (post-resetModules), else 'testnet' until init. It is a live
// binding (ESM), so importers observe the value set at init. Consumers that need the
// CURRENTLY ACTIVE network should read `getActiveConfig().network`.
export let network: Network = normalizeNetwork(readGlobalEnv()?.vars.NETWORK);

// Resolve a REQUIRED, PER-NETWORK value that has NO safe cross-network default
// (the OZ account class hash). It differs between the testnet and mainnet pool
// deployments, so a SINGLE shared env slot silently hands the SAME value to both
// networks — after a runtime switch the app would use the WRONG class hash
// (silent-wrong, not fail-loud; MEDIUM-2). Resolution order:
//   1. the per-network slot (`${base}_TESTNET` / `${base}_MAINNET`) for the network
//      being built — the correct, unambiguous source;
//   2. the legacy single `${base}` slot, for back-compat (a deploy that only sets
//      one network's value keeps working — but it is shared, so only safe when a
//      single network is targeted, e.g. apps/web's mainnet-only build);
//   3. otherwise FAIL LOUD, naming the per-network var so the operator knows which
//      slot to set — NEVER silently borrow the other network's value.
// `perNetwork`/`shared` are passed already-resolved from the injected env registry.
function requirePerNetworkEnv(
  base: string,
  n: Network,
  perNetwork: string | undefined,
  shared: string | undefined,
): string {
  const resolved = perNetwork || shared;
  if (!resolved) {
    // Same "Config error: … is not set" fail-loud shape as before (module load /
    // configFor eval), but the name points the operator at the per-network slot
    // (and its shared fallback) for the network being built — never silently borrow
    // the other network's value. `undefined` here would otherwise surface far away
    // as the cryptic "Cannot convert undefined to a BigInt" from the derive path.
    const suffix = n === 'mainnet' ? 'MAINNET' : 'TESTNET';
    throw new Error(
      `Config error: ${base}_${suffix} (or the shared ${base}) is not set for network '${n}'`,
    );
  }
  return resolved;
}

// AVNU paymaster — the PRODUCTION funding path that replaces the testnet
// admin/manager. Setting the `AVNU_PAYMASTER_API_KEY` env var turns it on for BOTH:
//   - the account DEPLOY (SNIP-29 `mode: 'sponsored'` — at deploy time the account
//     holds no STRK/USDC, so pay-in-token is impossible; see deploy.ts), and
//   - the PROVEN pool legs (register/deposit/withdraw/claim) via AVNU's PRIVATE
//     paymaster (`buildTransaction`/`executeTransaction`, PR avnu-labs/paymaster#67),
//     which carries the pool's STARK proof + proof_facts and submits from AVNU's
//     relayer — an unlinkable third party, removing the shared-manager↔account
//     linkage (the Starknet-side P0 in threat-model.md). See avnuPaymaster.ts +
//     proven-submit.ts. The pool must be whitelisted with AVNU.
//
// BUNDLE-EXPOSURE NOTICE: like the Polymarket builder creds below (and UNLIKE
// the admin private key, which has a prod hard-fail), this key IS intended for
// production and ships in the consumer's JS bundle (the app inlines its env).
// Anyone who inspects the bundle can extract it. Impact is limited to paymaster
// sponsorship-quota exhaustion (it cannot move funds; every submit still needs
// the derived account's own signature). Treat as a low-privilege, rotatable
// credential: store it in .env.local for development and supply it via the
// deploy environment (CI secret → injected at build time) for production —
// never commit to git.
type PaymasterConfig = {
  endpoint: string;
  apiKey: string;
  // Fee mode for the proven legs (default 'sponsored_private' — see resolvePaymaster):
  //   'sponsored_private' (default) — AVNU pays gas; the USER pays the pool fee from
  //     their private balance in `poolFeeToken` (→ USDC), baked into the SDK proof as a
  //     Withdraw to the forwarder. The only mode a USDC-only account can use; deposit /
  //     bridgeOut / bridgeBack all bake this fee. See open-questions.md #13.
  //   'sponsored' — AVNU's relayer is the caller and sponsors GAS, but does NOT waive
  //     the pool fee: it only fixes the fee token to STRK, so `fee_action` still comes
  //     back non-zero (validated live: a ~1-STRK withdraw). Unusable for a USDC-only
  //     account, which holds no STRK to pay it.
  feeMode: 'sponsored_private' | 'sponsored';
  // Token the user pays the pool fee in under 'sponsored_private'. Empty → consumers
  // fall back to config.depositToken.address (the deposit token, i.e. USDC), kept as
  // the single source of truth rather than duplicating the address here.
  poolFeeToken: string;
};

function resolvePaymaster(e: BridgeEnv): PaymasterConfig | undefined {
  const apiKey = e.vars.AVNU_PAYMASTER_API_KEY;
  if (!apiKey) return undefined;
  // Defaults to the AVNU mainnet paymaster. Override with the `AVNU_PAYMASTER_URL`
  // env var (e.g. https://sepolia.paymaster.avnu.fi) for testnet.
  // `||` (not `??`) so a blank `.env.local` line (empty string) falls through to the
  // default rather than yielding an empty endpoint URL (the empty-string footgun below).
  const endpoint =
    e.vars.AVNU_PAYMASTER_URL || 'https://starknet.paymaster.avnu.fi';
  // Default 'sponsored_private': AVNU's relayer pays gas; the pool fee is paid by the
  // user in `poolFeeToken` (→ USDC, the deposit token) as a withdraw baked into the
  // proof, so the deposit itself funds the fee — no separate STRK balance needed.
  // (`sponsored` would force the fee token to STRK, which a USDC-only account can't
  // pay; see open-questions.md #13 / AVNU private-transactions.md.)
  const feeMode = (e.vars.AVNU_FEE_MODE || 'sponsored_private') as
    | 'sponsored_private'
    | 'sponsored';
  const poolFeeToken = e.vars.AVNU_POOL_FEE_TOKEN ?? '';
  return { endpoint, apiKey, feeMode, poolFeeToken };
}

// An EVM chain the user can fund the pool deposit FROM, via CCTP burn-and-mint
// (MetaMask burns USDC here → it mints to the derived Starknet account). One row
// per Circle-supported source chain; adding a chain is data-only. EVM CCTP V2
// shares one TokenMessenger address across standard chains (docs/bridge-plan.md
// §3), so only the domain + USDC + RPC differ per row.
export interface EvmCctpSource {
  // EIP-155 chain id (the key the runtime looks up from MetaMask's eth_chainId).
  chainId: number;
  // CCTP source domain (Ethereum Sepolia = 0, Polygon Amoy = 7).
  domain: number;
  // TokenMessengerV2 (EVM) — depositForBurn target.
  tokenMessenger: string;
  // Native Circle USDC on this chain (6 dp).
  usdc: string;
  // Public RPC for receipt polling + the wallet_addEthereumChain fallback.
  rpcUrl: string;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  blockExplorerUrls?: string[];
  // Native-gas faucet, surfaced in the "insufficient POL/ETH for gas" pre-check
  // error so a zero-gas funder gets an actionable top-up link (mirrors the USDC
  // shortfall pointing at faucet.circle.com).
  faucetUrl?: string;
  // Network-ENFORCED minimum priority fee (tip), in gwei. Polygon chains reject a
  // submit whose `maxPriorityFeePerGas` is below their per-chain floor (Amoy: 25
  // gwei) with "gas tip cap … below minimum". The deposit-in approve/burn floors
  // the live fee estimate to at least this (depositIn.ts selectEip1559Fees), since
  // the node's suggested tip can sample a hair UNDER the floor. Omit for chains
  // with no enforced minimum (standard EIP-1559 base+tip, e.g. Ethereum).
  minPriorityFeeGwei?: number;
}

// An EVM chain the pool can bridge OUT to (pool → EVM), via CCTP burn-and-mint:
// the pool withdraws to the Anonymizer, which burns toward this chain and Circle's
// Forwarding Service mints native USDC here. One row per Circle-supported
// destination chain; adding a chain is data-only. Mirrors EvmCctpSource — the CCTP
// contracts + USDC are the SAME regardless of direction, so the rows are DERIVED
// from the source registry (see evmCctpDestinationsFor). Network-SELECTED (NOT
// merged) exactly like the source registry, preserving the fund-safety invariant.
export interface EvmCctpDest {
  // EIP-155 chain id (the user-chosen bridge-OUT destination; the key looked up).
  chainId: number;
  // CCTP destination domain appended to the Buy calldata as `dest_domain` (Polygon
  // = 7, Base = 6, Arbitrum = 3, Ethereum = 0, Optimism = 2).
  domain: number;
  // Native Circle USDC on this chain (6 dp) — where the forwarded mint lands.
  usdcAddress: string;
  // Public RPC for destination-mint balance reads.
  rpcUrl: string;
  chainName: string;
  blockExplorerUrls?: string[];
}

// Build a block-explorer transaction URL for an EVM CCTP chain config, or undefined
// when it carries no explorer base (keeps callers' links informational-only, never a
// dead href). Generic over `{ blockExplorerUrls }` so BOTH directions share it: the
// deposit-in CCTP burn on an EvmCctpSource, and a bridge-out mint on an EvmCctpDest.
// The app's own explorerTxUrl only knows Starknet + Polygon, so the SDK must resolve
// arbitrary EVM source/dest explorers (Base, Arbitrum, …) from the config here.
export function evmExplorerTxUrl(
  cfg: { blockExplorerUrls?: string[] } | undefined,
  txHash: string,
): string | undefined {
  const base = cfg?.blockExplorerUrls?.[0];
  return base ? `${base.replace(/\/+$/, '')}/tx/${txHash}` : undefined;
}

// STRK→US(D)C helper — pure, network-independent. Kept module-level (not inside
// configFor) so both the static config defaults and the live-price path share it.
// USDC-equivalent of `strkHuman` STRK at `priceUsd` $/STRK, as a plain decimal
// string (≤6 dp) so the deposit breakdown's bigint math (toRawAmount) parses it
// exactly. Falls back to '0.5' if either input is non-numeric/negative.
export function strkFeeToUsdc(strkHuman: string, priceUsd: number): string {
  const strk = Number(strkHuman);
  if (!Number.isFinite(strk) || !Number.isFinite(priceUsd) || strk <= 0 || priceUsd <= 0) {
    return '0.5';
  }
  return (Math.round(strk * priceUsd * 1e6) / 1e6).toString();
}

// The fully-resolved per-network config. Returned by configFor(n); the active one
// is exposed via the `config` Proxy. `readonly` throughout — swapping networks
// replaces the whole object, never mutates it.
export type Config = {
  network: Network;
  chainId: string;
  poolAddress: string;
  proofValidityBlocks: number;
  ozClassHash: string;
  strkToken: string;
  admin: AdminConfig | undefined;
  paymaster: PaymasterConfig | undefined;
  depositToken: {
    address: string;
    symbol: string;
    decimals: number;
    mintEntrypoint: string;
  };
  depositFunding: 'treasury' | 'metamask';
  maxDeposit: string;
  depositFeeStrk: string;
  depositFeeEstimate: string;
  deployFeeMode: 'sponsored' | 'default';
  deployFeeStrk: string;
  deployFeeEstimate: string;
  accountDenomination: string;
  maxAccountAmount: string;
  anonymizerAddress: string;
  // Inbound Anonymizer (CCTP → pool RETURN leg via privacy-compute; no sub-accounts).
  // The CCTP return burn mints here (mintRecipient + destinationCaller both = this
  // address). `0x0` until deployed (S4) — the return leg fails closed on a 0x0 address.
  inboundAnonymizerAddress: string;
  // dapp_name felt tag fed to the inbound contract's privacy_compute (FROZEN — must
  // match the deployed contract + inbound-commitment.ts RETURN_DAPP_NAME 'pmp-return').
  returnDappName: string;
  cctp: {
    snTokenMessengerMinter: string;
    snMessageTransmitter: string;
    starknetDomain: number;
    irisUrl: string;
    fast: boolean;
    defaultEvmSourceChainId: number;
    // Default bridge-OUT destination chain (pool → EVM) when the caller doesn't
    // choose one. Polygon: 137 mainnet / 80002 testnet. Must be a key of
    // evmCctpDestinations.
    defaultDestChainId: number;
  };
  // Default bridge-OUT destination projection (chainId/rpcUrl/usdc/domain of
  // `evmCctpDestinations[cctp.defaultDestChainId]`). Retained so the mainnet-only
  // Polymarket trading app (apps/web, where the trading chain is fixed to Polygon)
  // + the generic Polygon balance/WC helpers keep a stable read; it is NO LONGER an
  // independently-specified scalar — the destination registry is the source of truth.
  polygon: {
    chainId: number;
    rpcUrl: string;
    usdc: string;
    domain: number;
  };
  // Network-SELECTED CCTP source registry (NOT merged — fund-safety invariant).
  evmCctpSources: Record<number, EvmCctpSource>;
  // Network-SELECTED CCTP DESTINATION registry (pool → EVM). Same fund-safety
  // invariant (NOT merged); keyed by the SAME chainIds as evmCctpSources. Derived
  // from the source rows (identical CCTP contracts/USDC regardless of direction).
  evmCctpDestinations: Record<number, EvmCctpDest>;
  rpcUrl: string;
  proverUrl: string;
  indexerUrl: string;
  // Live STRK→USD spot-price endpoint (network-independent; strkPrice.ts). Empty
  // → strkPrice.ts falls back to its built-in default endpoint.
  strkPriceUrl: string;
  // WalletConnect (Reown) project id — opt-in for the WC-only wallet layer. Empty
  // → no WC entry is added to the picker (getWalletConnectProvider returns null).
  walletConnectProjectId: string;
  // DEV/TEST-ONLY flag: when truthy, the wallet layer returns a synthetic in-memory
  // EIP-1193 test provider (no WC relay) so E2E automation can connect→sign. Off by
  // default; never set in a normal/prod build. See e2eTestProvider.ts.
  e2eWallet: string;
};

// Pure factory: builds the whole per-network config from the injected env `e`. `n`
// selects the network-scoped defaults; individual env overrides still win.
// requirePerNetworkEnv / resolveAdmin / resolvePaymaster stay SCOPED here so a
// testnet config never surfaces mainnet admin creds and vice-versa. Defaults `e` to
// the initialized holder; setActiveNetwork calls it with the active env.
export function configFor(n: Network, e: BridgeEnv = requireEnv()): Config {
  const IS_MAINNET = n === 'mainnet';

  // EVM CCTP V2 TokenMessengerV2 — one shared address across standard EVM chains,
  // but a DIFFERENT one per network (docs/bridge-plan.md §3). Overridable for a
  // private fork via the `CCTP_EVM_TOKEN_MESSENGER` env var. `||` (not `??`) so a
  // blank env line (empty string) falls through to the network default.
  const EVM_CCTP_TOKEN_MESSENGER =
    e.vars.CCTP_EVM_TOKEN_MESSENGER ||
    (IS_MAINNET
      ? '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d' // mainnet shared TokenMessengerV2
      : '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA'); // testnet shared TokenMessengerV2

  // The "fund from MetaMask" source-chain registry. Keyed by EIP-155 chain id so
  // the deposit-in leg picks whatever chain MetaMask is currently on. Add a row to
  // support another chain (data-only). USDC addresses are CONFIRM-against-Circle
  // (Circle's CCTP page omits some testnet USDC tokens — docs/open-questions.md #1;
  // mainnet addresses sourced from Circle's USDC list — docs/mainnet-cutover-plan.md §2).
  const EVM_CCTP_SOURCES_TESTNET: Record<number, EvmCctpSource> = {
    // Polygon Amoy.
    80002: {
      chainId: 80002,
      domain: 7,
      tokenMessenger: EVM_CCTP_TOKEN_MESSENGER,
      usdc:
        e.vars.POLYGON_USDC_ADDRESS || '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
      rpcUrl: e.vars.POLYGON_RPC_URL || 'https://rpc-amoy.polygon.technology',
      chainName: 'Polygon Amoy',
      nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
      blockExplorerUrls: ['https://amoy.polygonscan.com'],
      faucetUrl: 'https://faucet.polygon.technology',
      minPriorityFeeGwei: 25, // Amoy rejects tips below 25 gwei.
    },
    // Ethereum Sepolia.
    11155111: {
      chainId: 11155111,
      domain: 0,
      tokenMessenger: EVM_CCTP_TOKEN_MESSENGER,
      usdc:
        e.vars.SEPOLIA_USDC_ADDRESS ||
        '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      rpcUrl:
        e.vars.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
      chainName: 'Ethereum Sepolia',
      nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
      blockExplorerUrls: ['https://sepolia.etherscan.io'],
      faucetUrl: 'https://sepolia-faucet.pk910.de',
    },
    // Base Sepolia (OP-stack L2 testnet). Overrides SHARE the mainnet Base env
    // vars — only one network's registry is active at a time (selected below).
    84532: {
      chainId: 84532,
      domain: 6,
      tokenMessenger: EVM_CCTP_TOKEN_MESSENGER,
      usdc:
        e.vars.BASE_USDC_ADDRESS || '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      rpcUrl: e.vars.BASE_RPC_URL || 'https://sepolia.base.org',
      chainName: 'Base Sepolia',
      nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
      blockExplorerUrls: ['https://sepolia.basescan.org'],
      faucetUrl: 'https://faucet.circle.com',
    },
    // Arbitrum Sepolia. Overrides SHARE the mainnet Arbitrum env vars.
    421614: {
      chainId: 421614,
      domain: 3,
      tokenMessenger: EVM_CCTP_TOKEN_MESSENGER,
      usdc:
        e.vars.ARBITRUM_USDC_ADDRESS ||
        '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
      rpcUrl:
        e.vars.ARBITRUM_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc',
      chainName: 'Arbitrum Sepolia',
      nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
      blockExplorerUrls: ['https://sepolia.arbiscan.io'],
      faucetUrl: 'https://faucet.circle.com',
    },
    // OP Sepolia (Optimism testnet). Overrides SHARE the mainnet Optimism env vars.
    11155420: {
      chainId: 11155420,
      domain: 2,
      tokenMessenger: EVM_CCTP_TOKEN_MESSENGER,
      usdc:
        e.vars.OPTIMISM_USDC_ADDRESS ||
        '0x5fD84259d66Cd46123540766Be93DFE6D43130D7',
      rpcUrl: e.vars.OPTIMISM_RPC_URL || 'https://sepolia.optimism.io',
      chainName: 'OP Sepolia',
      nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
      blockExplorerUrls: ['https://sepolia-optimism.etherscan.io'],
      faucetUrl: 'https://faucet.circle.com',
    },
  };

  // Mainnet source chains (active only when network=mainnet). No faucetUrl —
  // mainnet has no faucet, so the "insufficient gas" pre-check just omits the link.
  // USDC + domains: docs/mainnet-cutover-plan.md §2 (CONFIRM against Circle).
  const EVM_CCTP_SOURCES_MAINNET: Record<number, EvmCctpSource> = {
    // Polygon PoS.
    137: {
      chainId: 137,
      domain: 7,
      tokenMessenger: EVM_CCTP_TOKEN_MESSENGER,
      usdc:
        e.vars.POLYGON_USDC_ADDRESS || '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      rpcUrl: e.vars.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com',
      chainName: 'Polygon',
      nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
      blockExplorerUrls: ['https://polygonscan.com'],
      minPriorityFeeGwei: 25, // Polygon PoS rejects tips below 25 gwei.
    },
    // Ethereum.
    1: {
      chainId: 1,
      domain: 0,
      tokenMessenger: EVM_CCTP_TOKEN_MESSENGER,
      usdc:
        e.vars.ETHEREUM_USDC_ADDRESS || '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      rpcUrl: e.vars.ETHEREUM_RPC_URL || 'https://ethereum-rpc.publicnode.com',
      chainName: 'Ethereum',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      blockExplorerUrls: ['https://etherscan.io'],
    },
    // Base (OP-stack L2; cheap gas, native USDC). Optional — drop the row to disable.
    8453: {
      chainId: 8453,
      domain: 6,
      tokenMessenger: EVM_CCTP_TOKEN_MESSENGER,
      usdc:
        e.vars.BASE_USDC_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      rpcUrl: e.vars.BASE_RPC_URL || 'https://mainnet.base.org',
      chainName: 'Base',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      blockExplorerUrls: ['https://basescan.org'],
    },
    // Arbitrum One (cheap gas, native USDC). Optional — drop the row to disable.
    42161: {
      chainId: 42161,
      domain: 3,
      tokenMessenger: EVM_CCTP_TOKEN_MESSENGER,
      usdc:
        e.vars.ARBITRUM_USDC_ADDRESS || '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      rpcUrl: e.vars.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
      chainName: 'Arbitrum One',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      blockExplorerUrls: ['https://arbiscan.io'],
    },
    // OP Mainnet (Optimism; OP-stack L2, cheap gas, native USDC). Optional — drop the row to disable.
    10: {
      chainId: 10,
      domain: 2,
      tokenMessenger: EVM_CCTP_TOKEN_MESSENGER,
      usdc:
        e.vars.OPTIMISM_USDC_ADDRESS || '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
      rpcUrl: e.vars.OPTIMISM_RPC_URL || 'https://mainnet.optimism.io',
      chainName: 'OP Mainnet',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      blockExplorerUrls: ['https://optimistic.etherscan.io'],
    },
  };

  // Network-SELECTED (NOT merged — the fund-safety invariant: a testnet config
  // must never carry a mainnet chain id and vice-versa).
  const evmCctpSources = IS_MAINNET ? EVM_CCTP_SOURCES_MAINNET : EVM_CCTP_SOURCES_TESTNET;

  // Bridge-OUT DESTINATION registry (pool → EVM). The CCTP contracts + USDC are the
  // SAME regardless of direction (docs/bridge-plan.md §3), so derive the dest rows
  // from the SAME network's source rows — this reuses the audited USDC addresses and
  // guarantees the two registries stay in lock-step (same chainIds, same network).
  const evmCctpDestinationsFor = (
    sources: Record<number, EvmCctpSource>,
  ): Record<number, EvmCctpDest> => {
    const dest: Record<number, EvmCctpDest> = {};
    for (const s of Object.values(sources)) {
      dest[s.chainId] = {
        chainId: s.chainId,
        domain: s.domain,
        usdcAddress: s.usdc,
        rpcUrl: s.rpcUrl,
        chainName: s.chainName,
        blockExplorerUrls: s.blockExplorerUrls,
      };
    }
    return dest;
  };
  const evmCctpDestinations = evmCctpDestinationsFor(evmCctpSources);
  // Default bridge-OUT destination chain (Polygon by default). Overridable via
  // CCTP_DEFAULT_DEST_CHAIN_ID; must be a key of evmCctpDestinations.
  const defaultDestChainId = envInt(
    e.vars.CCTP_DEFAULT_DEST_CHAIN_ID,
    IS_MAINNET ? 137 : 80002,
    'CCTP_DEFAULT_DEST_CHAIN_ID',
  );
  // Default-destination projection (see the `polygon` field doc on Config). Falls
  // back to the network's Polygon row if an override points at an absent chain.
  const defaultDest =
    evmCctpDestinations[defaultDestChainId] ?? evmCctpDestinations[IS_MAINNET ? 137 : 80002];

  // Pool protocol fee in STRK (human units). Defaults to 4 STRK — the pool's
  // get_fee_amount(). Override with the `DEPOSIT_FEE_ESTIMATE_STRK` env var.
  const DEPOSIT_FEE_STRK = e.vars.DEPOSIT_FEE_ESTIMATE_STRK ?? '4';
  // STRK→USD price — only the OFFLINE FALLBACK for the deposit-fee display: the live
  // price is fetched at runtime (strkPrice.ts) and used when available. This static
  // value is a rough recent figure (STRK ≈ $0.05); override with `STRK_PRICE_USD`.
  const STRK_PRICE_USD = e.vars.STRK_PRICE_USD ?? '0.05';
  // How the derived account's one-time DEPLOY fee is paid (see docs). Defaults to
  // 'sponsored' (AVNU pays; a pure deploymentData deployment authorized by the
  // deploy signature — the documented mandatory deploy path, open-questions.md #13).
  // 'default' (account pays its own deploy fee in USDC via AVNU pay-in-token) is
  // NOT usable: the pay-in-token fee is charged via a SNIP-9 `execute_from_outside`
  // transfer FROM the account, but the account is not yet deployed at deploy time,
  // so AVNU rejects it with "SNIP-9 not implemented for the account" (a chicken-and-
  // egg AVNU can't resolve for deploy+gas_token). Kept as an opt-in only for a future
  // AVNU flow that supports it; do NOT default to it.
  const DEPLOY_FEE_MODE = (e.vars.DEPLOY_FEE_MODE ?? 'sponsored') as
    | 'sponsored'
    | 'default';
  // UI estimate of the one-time deploy gas, in STRK (display only; the REAL fee is
  // AVNU's suggested_max_fee_in_gas_token at deploy time).
  const DEPLOY_FEE_STRK = e.vars.DEPLOY_FEE_ESTIMATE_STRK ?? '0.5';

  // Dev-only same-origin proxied paths. In apps/bridge these are PER-NETWORK
  // (`/rpc/testnet` vs `/rpc/mainnet`) so both networks' upstreams are reachable
  // from one dev origin; the Vite proxy maps each prefix to that network's upstream
  // env var. In prod, the app rewrites these to its OHTTP gateway (one per network).
  // apps/web is mainnet-only and its proxy still serves the bare `/rpc` path, which
  // matches `/rpc/mainnet` under the same rewrite — verify with its vite.config.
  const suffix = e.dev ? `/${n}` : '';

  return {
    network: n,
    // Starknet chain-id FELT (= constants.StarknetChainId: SN_MAIN '0x534e5f4d41494e',
    // SN_SEPOLIA '0x534e5f5345504f4c4941') — NOT the human name. Passed to the
    // starknet-privacy SDK / starknet.js, which BigInt()s it. A `CHAIN_ID` override
    // must also be the felt.
    chainId:
      e.vars.CHAIN_ID ||
      (IS_MAINNET ? '0x534e5f4d41494e' : '0x534e5f5345504f4c4941'),
    // starknet-privacy pool — public on-chain addresses, baked per-network
    // (docs/mainnet-cutover-plan.md §0/§1). Override via `PRIVACY_POOL_ADDRESS` for a fork.
    poolAddress:
      e.vars.PRIVACY_POOL_ADDRESS ||
      (IS_MAINNET
        ? '0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a' // SN mainnet pool
        : '0x254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91'), // SN Sepolia pool
    // Blocks a ZK proof stays valid. Defaulted (20) so it needn't be set per env.
    proofValidityBlocks: envInt(e.vars.PROOF_VALIDITY_BLOCKS, 20, 'PROOF_VALIDITY_BLOCKS'),
    // OZ account class hash — the class must be DECLARED on the target network for the
    // in-browser EOA deploy; we can't guarantee a baked value is declared on mainnet,
    // so this stays REQUIRED. PER-NETWORK (MEDIUM-2): the declared class hash can
    // differ between Sepolia and mainnet, so it resolves from
    // OZ_ACCOUNT_CLASS_HASH_{TESTNET,MAINNET} first, falling back to the legacy
    // shared OZ_ACCOUNT_CLASS_HASH (fails loud if neither is set; PR #117).
    ozClassHash: requirePerNetworkEnv(
      'OZ_ACCOUNT_CLASS_HASH',
      n,
      IS_MAINNET
        ? e.vars.OZ_ACCOUNT_CLASS_HASH_MAINNET
        : e.vars.OZ_ACCOUNT_CLASS_HASH_TESTNET,
      e.vars.OZ_ACCOUNT_CLASS_HASH,
    ),
    // STRK fee token — canonical, network-CONSTANT address (identical on SN mainnet and
    // Sepolia), so it has a safe default (overridable via `STRK_TOKEN_ADDRESS`).
    strkToken:
      e.vars.STRK_TOKEN_ADDRESS ||
      '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
    // DEV-ONLY admin account that funds the in-browser EOA deploy. `undefined` in
    // a production build (see resolveAdmin). Callers that need it must guard.
    admin: resolveAdmin(e),
    // AVNU paymaster (SNIP-29) — the PRODUCTION account-deploy funding path.
    paymaster: resolvePaymaster(e),
    // Token deposited into the privacy pool. Defaults to native Circle USDC (6 dp)
    // so importing this module never throws when the deposit env vars are unset.
    depositToken: {
      address:
        e.vars.DEPOSIT_TOKEN_ADDRESS ||
        (IS_MAINNET
          ? '0x033068F6539f8e6e6b131e6B2B814e6c34A5224bC66947c47DaB9dFeE93b35fb' // native USDC (SN mainnet)
          : '0x0512feAc6339Ff7889822cb5aA2a86C848e9D392bB0E3E237C008674feeD8343'), // native USDC (SN Sepolia)
      symbol: e.vars.DEPOSIT_TOKEN_SYMBOL || 'USDC',
      decimals: envInt(e.vars.DEPOSIT_TOKEN_DECIMALS, 6, 'DEPOSIT_TOKEN_DECIMALS'),
      // Mint entrypoint for testnet funding. EMPTY for native USDC (not mintable)
      // → the admin (treasury) transfers the shortfall from its faucet-funded balance.
      mintEntrypoint: e.vars.DEPOSIT_TOKEN_MINT_ENTRYPOINT ?? '',
    },
    // Where the pool-deposit USDC comes from ('treasury' | 'metamask'). DEFAULT treasury.
    depositFunding: (e.vars.DEPOSIT_FUNDING || 'treasury') as
      | 'treasury'
      | 'metamask',
    // Human-units cap on a single deposit; enforced in the UI (not on-chain).
    // Defaults to 100 USDC (#166). Fractions allowed down to the token's decimals.
    maxDeposit: e.vars.MAX_DEPOSIT || '100',
    // Pool protocol fee in STRK (default 4 = the pool's get_fee_amount()).
    depositFeeStrk: DEPOSIT_FEE_STRK,
    // The STRK pool fee expressed in the deposit token (USDC) — STATIC fallback;
    // IdentityContext recomputes it from the LIVE STRK price on mount.
    depositFeeEstimate: strkFeeToUsdc(DEPOSIT_FEE_STRK, Number(STRK_PRICE_USD)),
    // One-time account-DEPLOY fee mode (see DEPLOY_FEE_MODE above).
    deployFeeMode: DEPLOY_FEE_MODE,
    // UI estimate of the one-time deploy gas in STRK (display only).
    deployFeeStrk: DEPLOY_FEE_STRK,
    // The deploy fee expressed in the deposit token (USDC) — STATIC fallback.
    deployFeeEstimate: strkFeeToUsdc(DEPLOY_FEE_STRK, Number(STRK_PRICE_USD)),
    // Default per-account amount (human units) the UI prefills into the editable
    // funding input.
    accountDenomination: e.vars.ACCOUNT_DENOMINATION || '1',
    // Human-units cap on a single account-funding amount; enforced in the UI
    // (not on-chain), mirroring maxDeposit. Bounds the variable amount so a
    // typo can't burn the whole pool balance in one go. Defaults to 100 USDC
    // (#166).
    maxAccountAmount: e.vars.MAX_ACCOUNT_AMOUNT || '100',
    // Our Anonymizer (pool withdraw recipient ↔ CCTP) — public on-chain addresses,
    // baked per-network. Override via `ANONYMIZER_ADDRESS` for a fork.
    anonymizerAddress:
      e.vars.ANONYMIZER_ADDRESS ||
      (IS_MAINNET
        ? '0x009067f35d2cab3cb933f3d78793660402026f8fa31e041ca2cab4a8e9a49092' // SN mainnet OutboundAnonymizer — canonical, byte-identical to privacy-bridge (flat BuyParams, class 0x016c1637…; deployed 2026-07-15; retired 0x01c2f255…/class 0x137962… 9-felt)
        : '0x05b85f2ae4d47c1e661533d5832fe3e4afd4c6a9b52e54b7f873a00c9b285f4e'), // SN Sepolia OutboundAnonymizer — canonical privacy-bridge (flat BuyParams, class 0x016c1637…; deployed 2026-07-15)
    // Inbound Anonymizer (privacy-compute RETURN leg), CANONICAL bridge-anonymizers
    // build from the privacy-bridge repo: folded single-tx claim + on-chain
    // destination_caller assert + source_domain-bound commitment
    // (poseidon([poseidon([identity_key, dapp_name, source_domain]), nonce])). Both
    // networks run the SAME class 0x0533023c… — byte-identical to privacy-bridge's
    // canonical bridge_anonymizers build (scarb 2.19.1), verified class-hash match
    // (deployed 2026-07-14). Override via INBOUND_ANONYMIZER_ADDRESS.
    inboundAnonymizerAddress:
      e.vars.INBOUND_ANONYMIZER_ADDRESS ||
      (IS_MAINNET
        ? '0x03a7e7f34e530f8ec00b1ff7eaca90a136311d9da7cb17a73203f813b56c86cb' // SN mainnet — canonical (class 0x0533023c…; deployed 2026-07-14)
        : '0x00d2a07c657d8c70f6eeddb7c8125e39b0955a40a608f63ca8a88d3ebbf72117'), // SN Sepolia — canonical (class 0x0533023c…; deployed 2026-07-14)
    // FROZEN dapp tag for privacy_compute (matches inbound-commitment.ts + the contract).
    returnDappName: e.vars.RETURN_DAPP_NAME || 'pmp-return',
    // CCTP wiring. Starknet-side messenger/transmitter + domains + Iris.
    cctp: {
      // `||` (not `??`) on every env address/URL below so a blank `.env.local` line
      // (empty string) falls through to the network default (the empty-string footgun).
      snTokenMessengerMinter:
        e.vars.CCTP_TOKEN_MESSENGER ||
        (IS_MAINNET
          ? '0x07d421B9cA8aA32DF259965cDA8ACb93F7599F69209A41872AE84638B2A20F2a' // SN mainnet
          : '0x04bDdE1E09a4B09a2F95d893D94a967b7717eB85A3f6dEcA8c080Ee01fBc3370'), // SN Sepolia
      snMessageTransmitter:
        e.vars.CCTP_MESSAGE_TRANSMITTER ||
        (IS_MAINNET
          ? '0x02EBB5777B6dD8B26ea11D68Fdf1D2c85cD2099335328Be845a28c77A8AEf183' // SN mainnet
          : '0x04db7926C64f1f32a840F3Fa95cB551f3801a3600Bae87aF87807A54DCE12Fe8'), // SN Sepolia
      starknetDomain: envInt(e.vars.CCTP_STARKNET_DOMAIN, 25, 'CCTP_STARKNET_DOMAIN'),
      // Iris attestation API. Testnet sandbox by default; mainnet is iris-api.circle.com.
      irisUrl:
        e.vars.CCTP_ATTESTATION_API ||
        (IS_MAINNET ? 'https://iris-api.circle.com' : 'https://iris-api-sandbox.circle.com'),
      // Use CCTP FAST Transfer (soft-finality threshold 1000). OFF by default.
      fast: e.vars.CCTP_FAST === 'true',
      // Source chain to switch MetaMask to when it's on an UNSUPPORTED chain for the
      // deposit-in leg (must be a key of evmCctpSources). Defaults to Polygon.
      defaultEvmSourceChainId: envInt(
        e.vars.CCTP_DEFAULT_SOURCE_CHAIN_ID,
        IS_MAINNET ? 137 : 80002,
        'CCTP_DEFAULT_SOURCE_CHAIN_ID',
      ),
      // Default bridge-OUT destination chain (pool → EVM). Defaults to Polygon.
      defaultDestChainId,
    },
    // Default bridge-OUT destination projection — DERIVED from the destination
    // registry's default row (NO independent scalar), with the legacy per-field
    // env overrides still honored on top (as on main): an explicit POLYGON_* /
    // CCTP_POLYGON_DOMAIN var pins the projected value even when the active network
    // isn't mainnet (e.g. apps/web forcing Polygon 137 for explorer/URL resolution).
    // See the Config `polygon` doc.
    polygon: {
      chainId: envInt(e.vars.POLYGON_CHAIN_ID, defaultDest.chainId, 'POLYGON_CHAIN_ID'),
      rpcUrl: e.vars.POLYGON_RPC_URL || defaultDest.rpcUrl,
      usdc: e.vars.POLYGON_USDC_ADDRESS || defaultDest.usdcAddress,
      domain: envInt(e.vars.CCTP_POLYGON_DOMAIN, defaultDest.domain, 'CCTP_POLYGON_DOMAIN'),
    },
    evmCctpSources,
    evmCctpDestinations,
    // Dev-only same-origin proxied paths (production uses OHTTP, one gateway/network).
    rpcUrl: `/rpc${suffix}`,
    proverUrl: `/prover${suffix}`,
    indexerUrl: `/indexer${suffix}`,
    // Live STRK→USD price endpoint (network-independent). Empty → strkPrice.ts default.
    strkPriceUrl: e.vars.STRK_PRICE_URL || '',
    // WalletConnect (Reown) project id — opt-in for the WC-only wallet layer.
    walletConnectProjectId: e.vars.WALLETCONNECT_PROJECT_ID || '',
    // DEV/TEST-ONLY synthetic-wallet E2E seam flag (off by default).
    e2eWallet: e.vars.E2E_WALLET || '',
  };
}

// --- Injected env + runtime network holder (framework-agnostic) ------------
// bridge-core reads NO app env: the consuming app calls `initBridgeConfig(env)` at
// startup (before any config read) and bridge-core resolves everything from that.
// `injectedEnv`/`activeConfig` start null; `initBridgeConfig` sets the default
// network and eagerly builds the config so fail-fast (requirePerNetworkEnv) still
// fires at init for the default network's required vars (mirrors the old
// import-time fail-fast). apps/bridge may later swap the active network via
// setActiveNetwork; apps/web never does.
//
// The injected env is ALSO stashed on globalThis (see readGlobalEnv above) so a
// module-registry reset (vi.resetModules in tests) recovers it in the fresh module
// instance without a re-init — bridge-core config survives the reset the way the
// app's build-time env used to. Prod is unaffected (initBridge runs first; one write).
let injectedEnv: BridgeEnv | null = readGlobalEnv();
let activeConfig: Config | null = null;

// Initialize bridge-core with the app's env. MUST be called once at app startup
// (see each app's initBridge.ts), before any code reads `config`/`getActiveConfig`.
// Idempotent: a later call re-initializes from the new env (used by tests to swap
// fixtures). Eagerly builds the default-network config so a missing required var
// fails LOUD here rather than surfacing far away as a cryptic derive error.
export function initBridgeConfig(env: BridgeEnv): void {
  injectedEnv = env;
  (globalThis as EnvGlobal)[ENV_GLOBAL_KEY] = env;
  network = normalizeNetwork(env.vars.NETWORK);
  activeConfig = configFor(network, env);
}

// The injected env, or a clear error if `initBridgeConfig` has not run yet. Used as
// the default env source for configFor and the capability helpers below.
function requireEnv(): BridgeEnv {
  if (injectedEnv === null) {
    throw new Error(
      'bridge-core config accessed before initBridgeConfig(env). Call initBridgeConfig ' +
        'at app startup (see initBridge.ts) before reading config.',
    );
  }
  return injectedEnv;
}

// The currently-active config, built lazily from the injected env on first read if
// `initBridgeConfig` set the env but not the config (defensive; init always builds).
function requireActiveConfig(): Config {
  if (activeConfig === null) activeConfig = configFor(network, requireEnv());
  return activeConfig;
}

// The CURRENTLY ACTIVE, fully-resolved config. Read this (or `config` below) at
// call time — do NOT capture it in a module-level `const`, or it will read stale
// after a swap. See docs/architecture.md (Key decisions: live config).
export function getActiveConfig(): Config {
  return requireActiveConfig();
}

// PROD FENCE (Bugbot MEDIUM — "Production RPC paths ignore network"):
// rpcUrl/proverUrl/indexerUrl only get the per-network `/testnet`|`/mainnet`
// suffix in a DEV build (the Vite dev proxy fans one origin out to both networks'
// upstreams). In a PROD build there is NO per-network endpoint — every network
// resolves to the same bare `/rpc`·`/prover`·`/indexer`, which in production the
// app rewrites to a SINGLE OHTTP gateway (see docs/threat-model.md). We have not
// defined per-network prod OHTTP infra, so a runtime testnet↔mainnet swap in prod
// would flip pool/CCTP fields while still pointing Starknet RPC/prover/indexer at
// the SAME upstream — silently wrong. Until per-network prod endpoints exist, the
// runtime switch is DEV-ONLY: in a prod build setActiveNetwork accepts only the
// build-time default network (idempotent mount alignment) and REFUSES any other,
// and the UI hides the toggle (see isNetworkSwitchEnabled).
export function isNetworkSwitchEnabled(): boolean {
  return Boolean(requireEnv().dev);
}

// Swap the active network. Rebuilds the whole config from configFor(n) — never
// mutates. Idempotent. apps/bridge's NetworkContext calls this (behind a confirm
// + full disconnect + in-flight guard). apps/web must not call it.
// Prod-fenced: outside a DEV build, only the build-time default network is
// allowed (the endpoints don't vary by network in prod — see above).
export function setActiveNetwork(n: Network): void {
  if (!isNetworkSwitchEnabled() && n !== network) {
    throw new Error(
      `Runtime network switch is DEV-only: cannot switch to '${n}' in a production ` +
        `build (Starknet RPC/prover/indexer endpoints are not per-network in prod — ` +
        `they would still target the build-time '${network}' upstream). ` +
        `Deploy a '${n}' build instead.`,
    );
  }
  activeConfig = configFor(n, requireEnv());
}

// Live Proxy over the active config: every `config.X` read resolves against the
// CURRENT active config, so existing call sites observe a swap with no rename.
export const config = new Proxy({} as Config, {
  get(_t, prop: string | symbol) {
    return (requireActiveConfig() as unknown as Record<string | symbol, unknown>)[prop];
  },
  // Write-through to the active config. The old `config` was a plain (runtime-
  // mutable) object; some tests reassign `config.paymaster = …`. Preserving a
  // settable surface keeps that contract. A network swap replaces the whole
  // object, so any such override is naturally reset on the next setActiveNetwork.
  set(_t, prop: string | symbol, value: unknown) {
    (requireActiveConfig() as unknown as Record<string | symbol, unknown>)[prop] = value;
    return true;
  },
  has(_t, prop) {
    return prop in (requireActiveConfig() as object);
  },
  ownKeys() {
    return Reflect.ownKeys(requireActiveConfig() as object);
  },
  getOwnPropertyDescriptor(_t, prop) {
    return Object.getOwnPropertyDescriptor(requireActiveConfig() as object, prop);
  },
});

// Live Proxy over the active config's CCTP source registry. Bare-object consumers
// (`EVM_CCTP_SOURCES[chainId]`, `Object.values(EVM_CCTP_SOURCES)`) observe the swap.
export const EVM_CCTP_SOURCES = new Proxy({} as Record<number, EvmCctpSource>, {
  get(_t, prop: string | symbol) {
    return (requireActiveConfig().evmCctpSources as unknown as Record<string | symbol, unknown>)[
      prop
    ];
  },
  has(_t, prop) {
    return prop in requireActiveConfig().evmCctpSources;
  },
  ownKeys() {
    return Reflect.ownKeys(requireActiveConfig().evmCctpSources);
  },
  getOwnPropertyDescriptor(_t, prop) {
    return Object.getOwnPropertyDescriptor(requireActiveConfig().evmCctpSources, prop);
  },
});

// Looks up the CCTP source config for `chainId` (undefined if unsupported).
// Reads the ACTIVE config at call time, so it follows a network swap.
export function getEvmCctpSource(chainId: number): EvmCctpSource | undefined {
  return requireActiveConfig().evmCctpSources[chainId];
}

// Live Proxy over the active config's CCTP DESTINATION registry (mirrors
// EVM_CCTP_SOURCES). Bare-object consumers observe a network swap.
export const EVM_CCTP_DESTINATIONS = new Proxy({} as Record<number, EvmCctpDest>, {
  get(_t, prop: string | symbol) {
    return (requireActiveConfig().evmCctpDestinations as unknown as Record<string | symbol, unknown>)[
      prop
    ];
  },
  has(_t, prop) {
    return prop in requireActiveConfig().evmCctpDestinations;
  },
  ownKeys() {
    return Reflect.ownKeys(requireActiveConfig().evmCctpDestinations);
  },
  getOwnPropertyDescriptor(_t, prop) {
    return Object.getOwnPropertyDescriptor(requireActiveConfig().evmCctpDestinations, prop);
  },
});

// Looks up the bridge-OUT destination row for `chainId` (undefined if unsupported).
// Reads the ACTIVE config at call time, so it follows a network swap.
export function getEvmCctpDestination(chainId: number): EvmCctpDest | undefined {
  return requireActiveConfig().evmCctpDestinations[chainId];
}

// The default bridge-OUT destination row (cctp.defaultDestChainId). Throws if the
// configured default is absent from the registry — a config error that must fail
// LOUD rather than silently bridge to the wrong/undefined chain.
export function getDefaultEvmCctpDestination(): EvmCctpDest {
  const c = requireActiveConfig();
  const dest = c.evmCctpDestinations[c.cctp.defaultDestChainId];
  if (!dest) {
    throw new Error(
      `Config error: default dest chain ${c.cctp.defaultDestChainId} is not in the ` +
        `CCTP destination registry for network '${c.network}'.`,
    );
  }
  return dest;
}

// Resolve the bridge-OUT destination row for `chainId`, falling back to the default
// destination when `chainId` is undefined. Throws if a SPECIFIED chainId is
// unsupported (fail loud — never silently bridge to the wrong chain). Shared by the
// value path (bridgeOut/cashOut/return) to turn a caller's optional destChainId into
// a concrete registry row.
export function resolveEvmCctpDestination(chainId?: number): EvmCctpDest {
  if (chainId === undefined) return getDefaultEvmCctpDestination();
  const dest = getEvmCctpDestination(chainId);
  if (!dest) {
    throw new Error(
      `Unsupported bridge-out destination chain ${chainId} — not in the CCTP ` +
        `destination registry for network '${requireActiveConfig().network}'.`,
    );
  }
  return dest;
}

// True iff `chainId` is a supported EVM CCTP source under the active network
// (Slice C — replaces callers' inline `EVM_CCTP_SOURCES[chainId] !== undefined`
// check, e.g. the deposit-in source-chain picker's seed-from-wallet effect).
export function isSupportedCctpSource(chainId: number): boolean {
  return chainId in requireActiveConfig().evmCctpSources;
}

// True iff the active config has a usable Anonymizer address (baked default or
// `ANONYMIZER_ADDRESS` override). Capability check for apps that need to gate
// a flow on the Anonymizer being configured, without reading/exposing the address
// itself (Slice N — apps/bridge's MoveFromPool no longer reads `config.anonymizerAddress`
// directly). Reads the ACTIVE config, so it follows a network swap.
export function isAnonymizerConfigured(): boolean {
  return Boolean(getActiveConfig().anonymizerAddress);
}
