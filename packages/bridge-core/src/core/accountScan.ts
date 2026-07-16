import { derivePolygonEoa } from '../derivation/index';
import { getPolygonPublicClient, readUsdcBalance, POLYGON_USDC_DECIMALS } from './polygonClient';
import {
  upsertDerivedAccount,
  readDerivedAccounts,
  seedAccountIndex,
  type DerivedAccountRecord,
} from './account-store';
import { formatTokenAmount } from './discover';

// A per-account index that showed on-chain activity (its deposit wallet — the
// CCTP mint recipient + order maker — holds USDC; `eoaAddress` is the owning
// signer).
export interface ScannedAccount {
  accountIndex: number;
  eoaAddress: string;
  depositWallet: string;
  usdcBalanceWei: bigint;
}

// Probe one index: resolve a ScannedAccount if the index was consumed, else null.
export type AccountProbe = (accountIndex: number) => Promise<ScannedAccount | null>;

// BIP-44-style discovery: scan past contiguous accounts tolerating gaps up to
// this many.
export const DEFAULT_GAP_LIMIT = 20;
// Hard cap so an adversarial / runaway scan can't spin forever (mirrors
// account-store.ts's own bounds).
export const MAX_SCAN_INDICES = 1024;

// Walk account indices from `startIndex` (default 0), collecting every consumed
// one, stopping after `gapLimit` consecutive empties (or `maxIndices`). Pure:
// all I/O is in `probe`, so this is fully unit-testable without RPC.
//
// `startIndex > 0` is a fast-path for callers whose LOCAL index counter is
// authoritative (a normal same-device session): indices [0, startIndex) are
// treated as already-consumed and NOT re-probed, so the forward walk begins at
// `startIndex` with a fresh consecutive-empty counter. This skips the ~27s
// from-0 re-confirmation on every first-buy-of-session.
//
// FUND-SAFETY (anti-reuse): starting from the cached counter is still safe
// against reuse — even a reuse on ANOTHER device lands at an index >= the local
// cache (indices are only ever handed out forward), so it sits at or beyond
// `startIndex` and is still probed by the forward walk. We only skip
// re-confirming indices the local counter already claims as used; we never skip
// the forward scan. `startIndex` 0/undefined = the full from-0 recovery walk
// (wiped-storage recovery, Sell-tab discoverPositions), byte-for-byte unchanged.
export async function gapLimitScan(
  probe: AccountProbe,
  opts: { gapLimit?: number; maxIndices?: number; startIndex?: number } = {},
): Promise<ScannedAccount[]> {
  const rawGapLimit = opts.gapLimit ?? DEFAULT_GAP_LIMIT;
  // gapLimit is meant to tolerate N consecutive empties before stopping. A
  // non-positive value would make the loop condition (`consecutiveEmpty <
  // gapLimit`) false BEFORE index 0 is ever probed, silently skipping the scan
  // entirely. Normalise to "probe at least once" — the smallest meaningful gap
  // tolerance is 1 (stop immediately after the first empty).
  const gapLimit = rawGapLimit > 0 ? rawGapLimit : 1;
  const maxIndices = Math.min(opts.maxIndices ?? MAX_SCAN_INDICES, MAX_SCAN_INDICES);
  // `maxIndices` stays an ABSOLUTE cap on the index, so a large cached
  // startIndex can never push the walk past the hard bound.
  const startIndex = Number.isInteger(opts.startIndex) && opts.startIndex! > 0 ? opts.startIndex! : 0;
  const found: ScannedAccount[] = [];
  let consecutiveEmpty = 0;
  for (let accountIndex = startIndex; accountIndex < maxIndices && consecutiveEmpty < gapLimit; accountIndex++) {
    const hit = await probe(accountIndex);
    if (hit) {
      found.push(hit);
      consecutiveEmpty = 0;
    } else {
      consecutiveEmpty++;
    }
  }
  return found;
}

// Injectable resolver: given a signature + accountIndex + channel, returns the deposit
// wallet address. Trading code provides:
// `(sig, idx, channel) => deriveDepositWallet(getEoaWalletClient(sig, idx, channel))`
// The `channel` MUST feed the EOA derivation so the resolved deposit wallet matches the
// channel EOA derived alongside it (below) — a channel-blind resolver would return the
// DEFAULT wallet and the scan would read the wrong wallet's balance. undefined = default
// channel; a pre-channel 2-arg resolver still satisfies this (extra arg ignored).
// Tests provide a deterministic stub.
export type DepositWalletResolver = (
  signature: string,
  accountIndex: number,
  channel?: string,
) => Promise<string>;

// Injectable "has this CREATE2 deposit wallet ever been deployed?" probe. A
// CREATE2 deposit wallet is counterfactual until it first acts (trade / approve
// / burn), so deployed bytecode is durable proof the wallet was USED even after
// its funds have been fully spent or returned (a contract wallet can only move
// its ERC-20 funds by executing, which requires deployment). Trading code
// provides `isDepositWalletDeployed` (apps/web/src/polymarket/relayer.ts); the
// bridge app doesn't have a Polymarket deploy notion so it may omit this.
export type DepositWalletDeployedProbe = (address: string) => Promise<boolean>;

// Reconstruct the consumed per-account index set from CHAIN (no dependence on
// the local index counter): for each index, derive the per-account EOA + its
// deposit wallet and probe the DEPOSIT WALLET's USDC balance (where the CCTP
// mint lands). A non-zero balance proves the index was consumed and the mint
// landed; a pre-redirect account may still hold USDC on the bare EOA, so fall
// back to it. When `isDepositWalletDeployed` is supplied (the STRONG
// used-detector — the cross-browser reuse guard, code-style.md "bid-index
// cross-browser reuse"), an index whose deposit wallet is deployed but drained
// is also USED with balance 0 — funds-present ⇒ balance signal and funds-gone
// ⇒ deployed signal, together covering every used deposit wallet. Omit the
// probe for the RECOVERY use case (surface only recoverable funds). Signature
// stays in-memory; only public addresses are surfaced. Stops via the gap-limit
// walker (DEFAULT_GAP_LIMIT consecutive empties).
export async function scanAccountEoas(
  signature: string,
  resolveDepositWallet: DepositWalletResolver,
  opts: {
    gapLimit?: number;
    maxIndices?: number;
    startIndex?: number;
    isDepositWalletDeployed?: DepositWalletDeployedProbe;
    // The account CHANNEL to scan (see account-store) — derives EOAs in THIS channel's
    // keyspace and is passed to `resolveDepositWallet` so its CREATE2 wallet matches the
    // EOA derived here. undefined = default channel.
    channel?: string;
  } = {},
): Promise<ScannedAccount[]> {
  const client = getPolygonPublicClient();
  const isDeployedProbe = opts.isDepositWalletDeployed;
  const probe: AccountProbe = async (accountIndex) => {
    const { address } = derivePolygonEoa(signature, accountIndex, opts.channel);
    const depositWallet = await resolveDepositWallet(signature, accountIndex, opts.channel);
    const walletBal = await readUsdcBalance(client, depositWallet as `0x${string}`);
    if (walletBal > 0n) {
      return { accountIndex, eoaAddress: address, depositWallet, usdcBalanceWei: walletBal };
    }
    // Strong used-detector: a drained-but-deployed deposit wallet is still USED.
    if (isDeployedProbe && (await isDeployedProbe(depositWallet))) {
      return { accountIndex, eoaAddress: address, depositWallet, usdcBalanceWei: 0n };
    }
    const eoaBal = await readUsdcBalance(client, address as `0x${string}`);
    return eoaBal > 0n
      ? { accountIndex, eoaAddress: address, depositWallet, usdcBalanceWei: eoaBal }
      : null;
  };
  return gapLimitScan(probe, opts);
}

// Rebuild the derived-account history for `evmAddress` from the wallet
// SIGNATURE + chain alone — works on a fresh browser (a full localStorage
// wipe). Upserts each discovered account with its REAL on-chain amount and the
// `minted` lifecycle (USDC funded on the per-account deposit wallet), recording
// that wallet as `funder`. Returns the list newest-first. PRIVACY: this queries
// N derived wallets through one RPC, linking them at that endpoint — see
// docs/threat-model.md.
export async function scanDerivedAccounts(
  args: {
    evmAddress: string;
    signature: string;
    resolveDepositWallet: DepositWalletResolver;
    // The caller's authoritative local next-index (e.g. `peekNextBidIndex`).
    // Skips re-probing indices [0, startIndex) the local counter already claims
    // as used — the whole point of the fast-path (see `gapLimitScan`). Defaults
    // to 0 (the full from-0 recovery walk) so the wiped-storage recovery path
    // and Sell-tab discoverPositions callers are unaffected.
    startIndex?: number;
  },
  scan?: (
    signature: string,
    resolveDepositWallet: DepositWalletResolver,
    opts?: { gapLimit?: number; maxIndices?: number; startIndex?: number },
  ) => Promise<ScannedAccount[]>,
): Promise<DerivedAccountRecord[]> {
  const { evmAddress, signature, resolveDepositWallet } = args;
  const startIndex = Number.isInteger(args.startIndex) && args.startIndex! > 0 ? args.startIndex! : 0;
  const doScan = scan ?? scanAccountEoas;
  if (!evmAddress) return [];
  const scanned = await doScan(signature, resolveDepositWallet, { startIndex });
  for (const account of scanned) {
    upsertDerivedAccount(evmAddress, {
      accountIndex: account.accountIndex,
      amountHuman: formatTokenAmount(account.usdcBalanceWei, POLYGON_USDC_DECIMALS),
      eoaAddress: account.eoaAddress,
      funder: account.depositWallet,
      lifecycle: 'minted',
      timestamp: 0,
    });
  }
  // Belt-and-suspenders alongside the pmp.bids upserts: raise the pmp.bidIndex
  // counter to `highestUsed + 1` so a later pmp.bids prune / eviction /
  // migration can't regress `nextAccountIndex` to 0 and re-issue an already-
  // used index — the cross-browser reuse guard (code-style.md "bid-index
  // cross-browser reuse"). Mirrors apps/web/src/starknet/bidScan.ts
  // seedBidIndexFromChain.
  // Indices [0, startIndex) are treated as USED (the local counter is
  // authoritative for them), so the highest-used index is at least
  // `startIndex - 1`, raised by any forward hit. Seeding `highest + 1` keeps the
  // counter monotonic and never regresses below the caller's cache.
  const forwardHighest = scanned.reduce((max, a) => Math.max(max, a.accountIndex), -1);
  const highest = Math.max(startIndex - 1, forwardHighest);
  if (highest >= 0) {
    seedAccountIndex(evmAddress, highest + 1);
  }
  return readDerivedAccounts(evmAddress);
}
