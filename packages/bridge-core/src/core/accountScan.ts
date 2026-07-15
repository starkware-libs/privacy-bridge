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

// Walk account indices from 0, collecting every consumed one, stopping after
// `gapLimit` consecutive empties (or `maxIndices`). Pure: all I/O is in `probe`,
// so this is fully unit-testable without RPC.
export async function gapLimitScan(
  probe: AccountProbe,
  opts: { gapLimit?: number; maxIndices?: number } = {},
): Promise<ScannedAccount[]> {
  const rawGapLimit = opts.gapLimit ?? DEFAULT_GAP_LIMIT;
  // gapLimit is meant to tolerate N consecutive empties before stopping. A
  // non-positive value would make the loop condition (`consecutiveEmpty <
  // gapLimit`) false BEFORE index 0 is ever probed, silently skipping the scan
  // entirely. Normalise to "probe at least once" — the smallest meaningful gap
  // tolerance is 1 (stop immediately after the first empty).
  const gapLimit = rawGapLimit > 0 ? rawGapLimit : 1;
  const maxIndices = Math.min(opts.maxIndices ?? MAX_SCAN_INDICES, MAX_SCAN_INDICES);
  const found: ScannedAccount[] = [];
  let consecutiveEmpty = 0;
  for (let accountIndex = 0; accountIndex < maxIndices && consecutiveEmpty < gapLimit; accountIndex++) {
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

// Injectable resolver: given a signature + accountIndex, returns the deposit
// wallet address. Trading code provides:
// `(sig, idx) => deriveDepositWallet(getEoaWalletClient(sig, idx))`
// Tests provide a deterministic stub.
export type DepositWalletResolver = (signature: string, accountIndex: number) => Promise<string>;

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
    isDepositWalletDeployed?: DepositWalletDeployedProbe;
  } = {},
): Promise<ScannedAccount[]> {
  const client = getPolygonPublicClient();
  const isDeployedProbe = opts.isDepositWalletDeployed;
  const probe: AccountProbe = async (accountIndex) => {
    const { address } = derivePolygonEoa(signature, accountIndex);
    const depositWallet = await resolveDepositWallet(signature, accountIndex);
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
  args: { evmAddress: string; signature: string; resolveDepositWallet: DepositWalletResolver },
  scan?: (
    signature: string,
    resolveDepositWallet: DepositWalletResolver,
    opts?: { gapLimit?: number; maxIndices?: number },
  ) => Promise<ScannedAccount[]>,
): Promise<DerivedAccountRecord[]> {
  const { evmAddress, signature, resolveDepositWallet } = args;
  const doScan = scan ?? scanAccountEoas;
  if (!evmAddress) return [];
  const scanned = await doScan(signature, resolveDepositWallet);
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
  if (scanned.length > 0) {
    const highest = scanned.reduce((max, a) => Math.max(max, a.accountIndex), -1);
    seedAccountIndex(evmAddress, highest + 1);
  }
  return readDerivedAccounts(evmAddress);
}
