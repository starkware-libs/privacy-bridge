// One-click funding: withdraw a fixed denomination from the privacy pool to the
// Anonymizer and burn it via CCTP toward a fresh per-account Polygon EOA — in ONE
// signed pool tx (Withdraw{recipient=Anonymizer} + InvokeExternal ->
// Anonymizer.privacy_invoke). BUY path steps 1-2.
//
// Frozen shape: ../../../../docs/bridge-interface.md §4. Mirrors deposit.ts /
// register.ts patterns (createPrivateTransfers, waitForProvingBlock aging,
// createProofInvocation -> executeWithInvocation -> account.execute, STRK-fee
// seeding, invalidateProofNonceCache single-retry). privacy_invoke returns an
// empty span (nothing returns to the pool); change goes back as a private note
// via surplusTo(account).
//
// In-memory only — never log/persist the viewing key, claim_secret, account_nonce,
// or the per-account Polygon EOA private key.

import type { Account, Call, constants } from 'starknet';
import {
  createPrivateTransfers,
  IndexerDiscoveryProvider,
  type PrivateTransfersInterface,
} from '@starkware-libs/starknet-privacy-sdk';
import {
  computeClaimH,
  deriveClaimSecret,
  derivePolygonEoa,
  deriveStarknetAccount,
  deriveStarknetPrivateKey,
  deriveViewingKey,
} from '../derivation/index';
// Injectable: given a signature + accountIndex, returns the Polymarket CREATE2 deposit
// wallet address. Trading code provides:
//   (sig, idx) => deriveDepositWallet(getEoaWalletClient(sig, idx))
// Tests provide a deterministic stub.
export type ResolveDepositWalletFn = (signature: string, accountIndex: number) => Promise<string>;
import { config, resolveEvmCctpDestination } from './config';
import { u256Calldata } from './deposit';
import { getRpcProvider, makeAccount } from './provider';
import { isRevertedOrRejected, sanitizeErrorMessage, submitAndTrack } from './tx';
import { humanizeFinality } from './errorMessages';
import { fetchPoolFeeAmount, approvePoolFee } from './poolFee';
import { discoverPrivateBalance } from './discover';
import { assertStorageWritable } from './storageProbe';
import {
  submitProvenCall,
  paymasterBuildLeg,
  paymasterExecuteLeg,
  type PaymasterBuildCtx,
} from './proven-submit';
import {
  waitForProvingBlock,
  getCurrentBlock,
  isNodeLagError,
  PROVING_BLOCK_DEPTH,
} from './proving';
import { submitReusingProofOnNodeLag } from './nodeLagRetry';
import { checkProveEarlyQuiescence, proveWithImmediateFallback } from './proveEarly';
import { deriveAccountNonce } from '../derivation/index';
import { isTerminalAttestFailure, waitForBridgedMint } from './polygonMint';
import {
  assertAboveForwardFloor,
  fetchForwardMaxFee,
  resolveFinalityThreshold,
  FAST_FINALITY_THRESHOLD,
  STANDARD_FINALITY_THRESHOLD,
} from './cctpFees';
import { consumeAccountIndex } from './account-store';

// CCTP min_finality_threshold: 2000 = Standard (free, finalized); 1000 = Fast
// (paid). docs/bridge-plan.md §3, Decision 4. The default follows config.cctp.fast
// (the CCTP_FAST env) so the burn's declared finality MATCHES the fee quote (which
// also defaults to config.cctp.fast) — a hardcoded Standard default here would burn
// slow (~13-19 min) even with Fast enabled, while paying the Fast fee. Callers may
// still override explicitly.
const defaultFinalityThreshold = (): number => resolveFinalityThreshold();

// Fund-safety burn-boundary guard. The CCTP fee that SIZED the burn was quoted for a
// specific finality tier (ForwardFeeQuote.finalityThreshold). If the burn then
// DECLARES a different tier, the fee and the finality are mismatched — a fast-quoted
// fee (14 bps) on a Standard burn (or a Standard 0-fee quote on a Fast burn) strands
// or underpays the transfer. Callers thread the quote's tier as
// `quotedFinalityThreshold`; we fail closed BEFORE any irreversible on-chain work
// (proving/burn) when it disagrees with the resolved min_finality_threshold. This
// catches ANY caller — including one overriding maxFee/minFinalityThreshold by hand —
// that a static config-time check could not. No-op when the caller passes no quote.
function assertQuotedFinalityMatchesBurn(
  quotedFinalityThreshold: number | undefined,
  minFinalityThreshold: number,
): void {
  if (
    quotedFinalityThreshold !== undefined &&
    quotedFinalityThreshold !== minFinalityThreshold
  ) {
    throw new Error(
      `CCTP finality tier mismatch: the fee was quoted for finality threshold ` +
        `${quotedFinalityThreshold} but the burn declares ${minFinalityThreshold}. ` +
        `Refusing to burn — a fee quoted for a different finality tier than the burn ` +
        `strands or underpays the transfer (fund-safety; fail before funds move).`,
    );
  }
}
// sn_domain baked into H (Starknet CCTP domain). docs/bridge-interface.md §2.
const SN_DOMAIN = 25n;

// Fee-buffer reserved in the pool for the eventual PRIVATE return fee (Phase 3).
// A later return pays its AVNU pool fee as a USDC `withdraw` drawn from a
// PRE-EXISTING pool note — the returned funds can NOT fund it, because they arrive
// via the anonymizer's noteId-bound OpenNoteDeposit which the SDK's resolveNotes
// does not count toward spendable balance (only a noteId===undefined open deposit
// cancels a deficit; compiler.js:457-465, mirrored in bridgeBack.ts). So a
// bid-funding bridgeOut must LEAVE at least this much in the pool. 0.5 USDC gives
// comfortable headroom over the live return-fee quote (~0.14 mainnet / ~0.04
// testnet). cashOut / bridgeOutToWallet do NOT gate — a full exit legitimately
// drains the pool.
export const RETURN_FEE_BUFFER_WEI = 500_000n; // 0.5 USDC @ 6dp

export interface BridgeOutArgs {
  // EVM wallet signature of the app's identity sign-message — the only secret input;
  // re-derives the SN account, viewing key, and the per-account Polygon EOA.
  signature: string;
  // Non-secret per-account index (persisted in localStorage) selecting the EOA.
  accountIndex: number;
  // Per-account nonce folded into claim_secret/H (poseidon([VK_child, counter])).
  accountNonce: bigint;
  // Fixed denomination to withdraw + burn, in USDC base units (1 USDC = 1e6).
  amount: bigint;
  // CCTP finality: 2000 = Standard (default), 1000 = Fast.
  minFinalityThreshold?: number;
  // The finality tier the `maxFee` quote was computed for (ForwardFeeQuote.
  // finalityThreshold). When set, bridgeOut FAILS CLOSED before burning if it differs
  // from the resolved min_finality_threshold — a fee/finality mismatch strands funds.
  quotedFinalityThreshold?: number;
  // Per-call CCTP fee cap (0 for Standard).
  maxFee?: bigint;
  // User-chosen bridge-OUT destination EVM chain id (Polygon 137/Base 8453/…).
  // Defaults to config.cctp.defaultDestChainId. Its CCTP domain is appended to the
  // Buy calldata as the `dest_domain` felt so Circle mints on the chosen chain.
  destChainId?: number;
  // Resolves the Polymarket CREATE2 deposit wallet for (signature, accountIndex).
  // Injected by the trading layer; tests provide a stub.
  resolveDepositWallet: ResolveDepositWalletFn;
  onStatus?: (s: string) => void;
}

export interface BridgeOutResult {
  // Starknet tx hash of the withdraw+burn apply_actions (Iris polls this).
  burnTxHash: string;
  // The CCTP mint recipient: the per-account EOA's CREATE2 DEPOSIT WALLET (the CLOB
  // order maker that holds the funds) — EIP-55 0x addr. Funds land where the
  // order signs, not on the bare EOA.
  mintRecipient: string;
  // The per-account Polygon EOA that OWNS the deposit wallet and signs its orders
  // (POLY_1271) — EIP-55 0x addr. Recorded as the signer identity for the account.
  eoaAddress: string;
  // The commitment H recorded for the return leg (decimal-encoded felt).
  commitmentH: bigint;
}

// Withdraw a fixed denomination from the pool to the Anonymizer and burn it via
// CCTP toward the per-account EOA's DEPOSIT WALLET (the CLOB order maker), in ONE
// signed pool tx.
//
// Steps (BUY 1-2):
//   1. Recover SN account + viewing key + per-account Polygon EOA from the signature,
//      and derive the EOA's deposit wallet (the mint recipient).
//   2. Compute claim_secret = poseidon(VK, accountNonce) and the commitment H.
//   3. Build apply_actions: Withdraw{recipient=Anonymizer, amount=D} (the pool
//      runs Withdraw FIRST, so the Anonymizer already holds the USDC) + ONE
//      InvokeExternal -> OutboundAnonymizer.privacy_invoke(BuyParams{mint_recipient,
//      amount, max_fee, min_finality_threshold, destination_domain}); surplus back as a note.
//   4. Prove against an aged block, submit from the MANAGER (manager pays the
//      on-chain gas + STRK protocol fee; the derived account stays STRK-free).
//
// Returns the burn tx hash (Iris attestation polls it), the mint recipient
// (deposit wallet) + the owning EOA, and H (recorded on-chain for the M10
// return/claim leg).
export async function bridgeOut(args: BridgeOutArgs): Promise<BridgeOutResult> {
  const { signature, accountIndex, accountNonce, amount, resolveDepositWallet, onStatus } = args;
  const minFinalityThreshold = args.minFinalityThreshold ?? defaultFinalityThreshold();
  // Fail closed on a fee/finality tier mismatch BEFORE any on-chain work (fund-safety).
  assertQuotedFinalityMatchesBurn(args.quotedFinalityThreshold, minFinalityThreshold);
  const maxFee = args.maxFee ?? 0n;
  // Resolve the chosen destination chain → its CCTP domain (appended to the Buy
  // calldata as dest_domain). Fails loud on an unsupported chainId.
  const destDomain = resolveEvmCctpDestination(args.destChainId).domain;
  const provider = getRpcProvider();

  const anonymizer = config.anonymizerAddress;
  if (!anonymizer) {
    throw new Error('bridgeOut: anonymizer address not configured (ANONYMIZER_ADDRESS).');
  }

  // 1. Recover keys from the single signature (in-memory only).
  onStatus?.('Recovering keys…');
  const snPrivateKey = deriveStarknetPrivateKey(signature);
  const viewingKey = deriveViewingKey(signature);
  const { address: snAddress } = deriveStarknetAccount(snPrivateKey, config.ozClassHash);
  const account = makeAccount(snAddress, snPrivateKey, provider);
  // Per-account fresh Polygon EOA — the signer that OWNS the deposit wallet.
  const eoa = derivePolygonEoa(signature, accountIndex);
  // CCTP mint recipient = the EOA's CREATE2 deposit wallet (the CLOB order maker
  // that holds the funds), so the bridged USDC lands where the order signs — not
  // on the bare EOA. Pure CREATE2 (no deploy, no builder creds); minting to a
  // counterfactual address is fine, the balance sits there until it's deployed.
  // Derived BEFORE the burn so a derivation failure aborts before funds commit.
  // Independent of the STRK pool-fee read below (fetchPoolFeeAmount takes no
  // args and doesn't depend on the deposit wallet, nor vice versa) — run them
  // concurrently rather than sequentially.
  onStatus?.('Deriving deposit wallet…');
  onStatus?.('Checking pool fee…');
  onStatus?.('Checking pool balance…');
  const [depositWallet, feeAmount, poolBalance] = await Promise.all([
    resolveDepositWallet(signature, accountIndex),
    fetchPoolFeeAmount(),
    discoverPrivateBalance({ account, viewingKey }),
  ]);

  // FEE-BUFFER GATE (Phase 3). Fail closed BEFORE any on-chain work if this
  // bid-funding withdraw would leave less than RETURN_FEE_BUFFER_WEI in the pool:
  // the eventual private return pays its AVNU pool fee from a pre-existing note,
  // and draining the pool now would make that return revert at proof-build with
  // "Insufficient balance" (see the RETURN_FEE_BUFFER_WEI note above).
  if (poolBalance < amount + RETURN_FEE_BUFFER_WEI) {
    const maxSpendable = poolBalance > RETURN_FEE_BUFFER_WEI ? poolBalance - RETURN_FEE_BUFFER_WEI : 0n;
    throw new Error(
      `Bridging ${humanAmount(amount)} USDC would leave less than the required ` +
        `${humanAmount(RETURN_FEE_BUFFER_WEI)} USDC pool fee-buffer needed to pay the ` +
        `private return fee later. In-pool balance is ${humanAmount(poolBalance)} USDC; ` +
        `bridge at most ${humanAmount(maxSpendable)} USDC (or add funds to the pool first).`,
    );
  }

  // mint_recipient: 20-byte EVM address as a u256 (numeric value of the addr).
  const mintRecipient = BigInt(depositWallet);

  // 2. Per-account commitment H (recorded by privacy_invoke; consumed on M10 claim).
  // claim_secret is a one-way Poseidon child of the viewing key; never logged.
  // computeClaimH binds note_binding to claim_secret (NOT the viewing key) so the
  // on-chain claim — whose frozen signature carries only claim_secret — can
  // recompute the SAME H. The raw viewing key feeds claim_secret only and is
  // never revealed on-chain (docs/bridge-interface.md §2, threat-model.md).
  const claimSecret = deriveClaimSecret(viewingKey, accountNonce);
  const commitmentH = computeClaimH({ claimSecret, amount, snDomain: SN_DOMAIN });

  // STRK protocol fee: the MANAGER approves it up front (manager-paid submit) so
  // collect_fee() can pull it from the manager during apply_actions. Seeds the
  // proving-block wait with its block.
  let lastTxBlockNumber: number | undefined;
  if (feeAmount > 0n) {
    onStatus?.('Approving pool fee…');
    lastTxBlockNumber = await approvePoolFee(feeAmount);
  }

  const discoveryProvider = new IndexerDiscoveryProvider(config.indexerUrl, config.poolAddress);
  const transfers = createPrivateTransfers({
    account,
    viewingKeyProvider: { getViewingKey: async () => viewingKey },
    provingProvider: {
      url: config.proverUrl,
      chainId: config.chainId as constants.StarknetChainId,
    },
    discoveryProvider,
    poolContractAddress: config.poolAddress,
  });

  const burnTxHash = await proveAndSubmitBridgeOut({
    transfers,
    account,
    provider,
    anonymizer,
    viewingKey,
    amount,
    mintRecipient,
    maxFee,
    minFinalityThreshold,
    destDomain,
    lastTxBlockNumber,
    onStatus,
  });

  onStatus?.('Withdraw + burn submitted; awaiting CCTP attestation.');
  return { burnTxHash, mintRecipient: depositWallet, eoaAddress: eoa.address, commitmentH };
}

// ---------------------------------------------------------------------------
// fundAccountFromPool — compose bridgeOut + waitForBridgedMint behind ONE
// account-funding orchestrator that owns the in-flight burn resume cursor
// (Slice F, docs/bridge-sdk-refactor.md §1/§2). This replaces the hand-rolled
// burn→attest→mint state machine + cursor that lived in the app's
// account-funding context. The app now passes only signature/accountIndex/amount +
// the injected deposit-wallet resolver; the account_nonce / commitment H are
// derived INTERNALLY (bridgeOut computes H) — the app derives NO H/claim-secret.
//
// Secret hygiene (Decision 5): the raw signature is obtained lazily + in-memory
// (resolveSignature) ONLY on the fresh-burn path, and is never logged/persisted.
// The resume path never re-signs (the burn already committed; re-burning would
// double-spend), so resolveSignature is not called there.
// ---------------------------------------------------------------------------

// In-flight burn cursor (NON-SECRET, persisted; migrated verbatim from the
// app). Once the withdraw+CCTP burn lands on Starknet the funds are
// committed to CCTP and the only thing left is attest → Polygon mint. If
// attest/mint hits a transient (or the tab reloads), re-burning would
// DOUBLE-SPEND; so we persist the burn tx hash + recipient and resume from
// attest. Everything here is recomputable / non-secret (burnTxHash is public; the
// deposit wallet is the mint recipient baked into the public CCTP message; the
// EOA owns it). Cleared after a successful mint. waitForAttestation is idempotent
// on the same burnTxHash. The KEY string is unchanged (§1.1 — renaming it orphans
// in-flight burns); the index FIELD keeps its legacy name `bidIndex` on disk
// (§1.1 preserves it in cursor validators + migrate-on-read paths, and
// account-store.hasAnyInflightBurn / migrateLegacyAccounts read it), so existing
// cursors resume seamlessly across this migration.
export const INFLIGHT_BURN_KEY = 'pmp.inflightBurn';

export interface InflightBurn {
  burnTxHash: string;
  eoaAddress: string;
  // The EOA's deposit wallet — the CCTP mint recipient the attested message must
  // carry (the EOA owns it + signs its orders). Optional for back-compat: cursors
  // written before the mint was redirected to the deposit wallet lack it, and the
  // resume path surfaces a terminal error for those (no Forwarding-Service hook).
  depositWallet?: string;
  // Preserved legacy field name (§1.1) — the per-account index on disk.
  bidIndex: number;
  // The bridge-OUT destination EVM chain id the burn targeted. Persisted so a RESUME
  // resolves the mint-watch destination domain AUTHORITATIVELY from the burn's own
  // chain, never from a (possibly different) resume-time arg — mirrors returnIn.ts's
  // evmChainId. Optional for back-compat: cursors written before multichain dest
  // lack it, and the resume path falls back to the arg's domain for those.
  evmChainId?: number;
  amountHuman: string;
  // Opaque, NON-SECRET app metadata round-tripped through the cursor + result so a
  // resumed/completed funding still shows what it was for. bridge-core never
  // inspects it (keeps the SDK Polymarket-free); the app stores its market
  // selection here.
  selection?: Record<string, unknown>;
}

type InflightBurnMap = Record<string, InflightBurn>;

function readInflightBurnMap(): InflightBurnMap {
  try {
    const raw = localStorage.getItem(INFLIGHT_BURN_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as InflightBurnMap;
    return {};
  } catch {
    return {};
  }
}

// A well-formed 20-byte EVM/Polygon address: 0x + exactly 40 hex digits. Reject
// anything else BEFORE signing/submitting — the destination is baked into the CCTP
// burn as the mint recipient, so a malformed value would burn toward an unspendable
// address. (No checksum: viem/CCTP treat the address case-insensitively.) Shared by
// isValidInflightBurn below and isValidInflightCashOut further down.
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// Validate a persisted in-flight burn record before trusting it (Bundle A3). A
// corrupt/partial record (e.g. a half-written localStorage entry) would make the
// resume path poll a bad Iris URL until the 30-min attest timeout, or mint against
// a garbage recipient. Valid only if every field has the right shape; `eoaAddress`
// must be a 20-byte (40-hex) 0x EVM address — it is fed to waitForBridgedMint as
// the expected mint recipient.
export function isValidInflightBurn(value: unknown): value is InflightBurn {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.burnTxHash === 'string' &&
    /^0x[0-9a-fA-F]+$/.test(r.burnTxHash) &&
    typeof r.eoaAddress === 'string' &&
    EVM_ADDRESS_RE.test(r.eoaAddress) &&
    (r.depositWallet === undefined ||
      (typeof r.depositWallet === 'string' && EVM_ADDRESS_RE.test(r.depositWallet))) &&
    typeof r.bidIndex === 'number' &&
    Number.isInteger(r.bidIndex) &&
    r.bidIndex >= 0 &&
    (r.evmChainId === undefined ||
      (typeof r.evmChainId === 'number' && Number.isFinite(r.evmChainId))) &&
    typeof r.amountHuman === 'string' &&
    r.amountHuman.length > 0
  );
}

// Read the cursor for an EVM address, dropping (and clearing) a corrupt record so
// the caller treats it as a FRESH funding rather than resuming off garbage. Exposed
// so the app's resume banner reads the SAME validated view the orchestrator does.
export function readInflightBurn(evmAddress: string): InflightBurn | null {
  const record = readInflightBurnMap()[evmAddress.toLowerCase()] ?? null;
  if (record === null) return null;
  if (!isValidInflightBurn(record)) {
    clearInflightBurn(evmAddress);
    return null;
  }
  return record;
}

function writeInflightBurn(evmAddress: string, record: InflightBurn): void {
  try {
    const map = readInflightBurnMap();
    map[evmAddress.toLowerCase()] = record;
    localStorage.setItem(INFLIGHT_BURN_KEY, JSON.stringify(map));
  } catch {
    // Best-effort: a storage failure must not break the funding (attest/mint can
    // still complete in this run; only cross-reload resume is lost).
  }
}

function clearInflightBurn(evmAddress: string): void {
  try {
    const map = readInflightBurnMap();
    delete map[evmAddress.toLowerCase()];
    localStorage.setItem(INFLIGHT_BURN_KEY, JSON.stringify(map));
  } catch {
    // ignore.
  }
}

// Double-spend guard (Bundle A2). PRE-FLIGHT on the FRESH-burn path only: before
// we burn, prove localStorage actually accepts a write+read-back. If it can't
// (private-browsing, disabled storage, quota), the in-flight cursor we'd write
// AFTER the burn would silently vanish — a reload then can't resume and the user
// could re-burn (double-spend). Throw a TERMINAL error so we NEVER burn when we
// can't persist the resume cursor. (Never called on the resume path: it has
// already burned, so refusing to resume would strand funds.)
const STORAGE_PROBE_KEY = 'pmp.storageProbe';

// Best-effort in-flight write that REPORTS whether the cursor actually landed
// (Bundle A2). Used AFTER the burn: the burn already committed the funds to CCTP,
// so we never throw here; the caller surfaces a "don't reload" warning when the
// read-back shows the cursor didn't persist.
function writeInflightBurnVerified(evmAddress: string, record: InflightBurn): boolean {
  writeInflightBurn(evmAddress, record);
  const persisted = readInflightBurnMap()[evmAddress.toLowerCase()];
  return !!persisted && persisted.burnTxHash === record.burnTxHash;
}

// The three on-the-wire legs a UI can render as a progress tracker:
//   bridge = withdraw + CCTP burn (ONE Starknet pool tx)
//   attest = poll Circle Iris for the attestation
//   mint   = Circle's Forwarding Service mints USDC on the per-account deposit wallet
export type FundStep = 'bridge' | 'attest' | 'mint';
export type FundStepStatus = 'pending' | 'running' | 'done' | 'error';

export interface FundAccountFromPoolArgs {
  // Lazy provider of the raw wallet signature (in-memory only). Called ONCE on the
  // FRESH-burn path (to derive the account nonce + drive bridgeOut) and NEVER on
  // the resume path (no re-sign — re-burning would double-spend). The returned
  // signature is never logged or persisted.
  resolveSignature: () => Promise<string>;
  // Non-secret per-account index (peeked by the app); used on the fresh path and
  // consumed after a successful burn. Ignored on resume (the cursor is authoritative).
  accountIndex: number;
  // Amount to withdraw + burn, in deposit-token base units (1 USDC = 1e6).
  amount: bigint;
  // Connected EVM address that KEYS the resume cursor + index counter.
  evmAddress: string;
  // Resolves the Polymarket CREATE2 deposit wallet for (signature, accountIndex).
  // Injected by the trading layer; keeps bridge-core Polymarket-free.
  resolveDepositWallet: ResolveDepositWalletFn;
  // User-chosen bridge-OUT destination EVM chain id. Defaults to
  // config.cctp.defaultDestChainId. Threaded to bridgeOut (Buy calldata dest_domain)
  // and to the attest/mint leg (the forwarded mint's expected destination domain).
  destChainId?: number;
  // Per-call CCTP finality tier for the FRESH burn: true = Fast (threshold 1000,
  // ~seconds, ~0.14% protocol fee); false = Standard (threshold 2000, minutes, free).
  // Defaults to config.cctp.fast when unset. Drives BOTH the pre-burn fee quote AND the
  // burn's declared min_finality_threshold so the fee and the finality always agree. The
  // RESUME path IGNORES this — a resumed burn already committed to its original tier
  // (re-quoting/re-burning would double-spend), so the fast selection only applies fresh.
  fast?: boolean;
  // Opaque, NON-SECRET app metadata stored in the cursor + echoed in the result.
  selection?: Record<string, unknown>;
  // Fires (step,'running') before each leg and (step,'done'|'error') after; the app
  // maps these to its Step/StepStatus UI. Presentation only — no window here.
  onStep?: (step: FundStep, status: FundStepStatus, detail?: string) => void;
  // Fired once, right after a FRESH burn lands + the cursor is written (never on
  // resume — the burn is already recorded). Lets the app record its account history
  // without bridge-core knowing about that store.
  onBurned?: (info: {
    burnTxHash: string;
    eoaAddress: string;
    depositWallet: string;
    accountIndex: number;
  }) => void;
  // Deterministic-test knobs forwarded to the mint pollers.
  intervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface FundAccountFromPoolResult {
  burnTxHash: string;
  // The per-account index this funding used (fresh: the arg; resume: the cursor's).
  accountIndex: number;
  // The per-account Polygon EOA that owns the deposit wallet + signs its orders.
  eoaAddress: string;
  // The CCTP mint recipient — the EOA's deposit wallet the USDC landed on.
  depositWallet: string;
  // The commitment H recorded for the return leg (0 on a resume off a cursor that
  // predates H being surfaced; the app doesn't consume it in M2).
  commitmentH: bigint;
  // Circle's Forwarding-Service mint tx on Polygon.
  forwardTxHash: string;
  // The opaque app metadata carried through the cursor (fresh: the arg; resume: the
  // stored value).
  selection?: Record<string, unknown>;
}

// Read-only {eoaAddress, amountHuman} view of the persisted in-flight burn for an
// account, or null. For the app's resume banner. Funds are SAFE while non-null —
// the burn landed; the next funding resumes (never re-burns).
export interface InflightBurnView {
  eoaAddress: string;
  amountHuman: string;
}

export function readInflightBurnView(addr: string | null | undefined): InflightBurnView | null {
  if (!addr) return null;
  const record = readInflightBurn(addr);
  return record ? { eoaAddress: record.eoaAddress, amountHuman: record.amountHuman } : null;
}

// Human decimal string → deposit-token base units (the inverse of humanAmount). Only
// for DISPLAY of the persisted cursor amount (the resume itself re-derives from the
// burn), so a best-effort parse is enough: returns null on any malformed input rather
// than throwing.
function baseUnitsFromHuman(human: string): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(human)) return null;
  const decimals = config.depositToken.decimals;
  const [whole, frac = ''] = human.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  try {
    return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fracPadded || '0');
  } catch {
    return null;
  }
}

// Normalized read of the in-flight account-funding (from-pool → CCTP mint-out) cursor
// for the unified getBridgeTransferStatus reader. Returns the amount already committed
// (parsed from the persisted human string) + the derived Polygon EOA the funds mint to,
// or null when there is no resumable cursor. Reuses the validated reader (corrupt-drop;
// best-effort — never throws).
export function peekInflightBurn(
  evmAddress: string | null | undefined,
): { amountWei: bigint; eoaAddress: string } | null {
  if (!evmAddress) return null;
  const record = readInflightBurn(evmAddress);
  if (!record) return null;
  const amountWei = baseUnitsFromHuman(record.amountHuman);
  if (amountWei === null) return null;
  return { amountWei, eoaAddress: record.eoaAddress };
}

// Normalized read of the in-flight cash-out (Leg B, from-pool → Polygon address)
// cursor for the unified getBridgeTransferStatus reader. Returns the amount already
// committed + the destination Polygon address the funds mint to, or null when there is
// no resumable cursor. Reuses the validated reader (corrupt-drop; best-effort).
export function peekInflightCashOut(
  evmAddress: string | null | undefined,
): { amountWei: bigint; destination: string } | null {
  const record = readInflightCashOut(evmAddress);
  if (!record) return null;
  return { amountWei: BigInt(record.amount), destination: record.destination };
}

// Fund a per-account deposit wallet FROM the pool: withdraw + CCTP burn (bridgeOut)
// → attest → Circle Forwarding-Service mint (waitForBridgedMint), owning the
// pmp.inflightBurn resume cursor. Resumable:
//   - a VALID inflight cursor for this EVM address → RESUME from attest, SKIP the
//     re-sign + burn (re-burning would double-spend the pool withdrawal);
//   - else the FRESH path: pre-flight storage, quote the CCTP forwarding fee +
//     assert the amount clears the floor, sign + derive the account nonce, burn,
//     CONSUME the index, PERSIST the cursor BEFORE attest, then attest + mint.
// On success the cursor is CLEARED. On a DEMONSTRABLY-terminal attest failure
// (Iris "attestation failed" / a CCTP recipient/domain mismatch) the cursor is
// cleared (the funds will never mint here); any OTHER failure PRESERVES the cursor
// (the burn is replayable forever by its tx hash — never strand a recoverable one).
export async function fundAccountFromPool(
  args: FundAccountFromPoolArgs,
): Promise<FundAccountFromPoolResult> {
  const {
    resolveSignature,
    accountIndex,
    amount,
    evmAddress,
    resolveDepositWallet,
    destChainId,
    selection,
    onStep,
    onBurned,
  } = args;
  // Resolve the chosen destination chain up front (fail loud on an unsupported id,
  // before any sign/burn). Its domain drives the CCTP fee route + the forwarded-mint
  // destination gate. On the RESUME path the burn already committed to whatever chain
  // it targeted, so the domain here matters only for the attest/mint leg (which is
  // chain-agnostic beyond the destination-domain gate). The arg's domain is only a
  // FALLBACK — the resume branch below overrides it with the burn's PERSISTED chain so
  // a resume with a conflicting destChainId can't gate the mint-watch on the wrong
  // domain (→ "recipient/domain mismatch" + cursor clear = stranded funds).
  let destDomain = resolveEvmCctpDestination(destChainId).domain;
  const emit = (step: FundStep, status: FundStepStatus, detail?: string): void =>
    onStep?.(step, status, detail);
  // The per-call finality tier (falls back to the deployment default). Drives BOTH
  // the burn's declared finality (fresh path, below) AND the Iris poll cadence, so a
  // Fast burn is always polled on the Fast cadence even when the deployment default is
  // Standard. On resume it's reused best-effort — cadence only, never re-declares the
  // burn's finality, which the original burn already committed to.
  const fast = args.fast ?? config.cctp.fast;
  const pollKnobs = {
    // Poll Iris on the tier's cadence (Fast ~1.5s vs Standard 5s): a Fast burn attests
    // in ~10-15s, so the tighter cadence recovers latency on both the attest + the
    // forwarded-mint milestones.
    fast,
    intervalMs: args.intervalMs,
    timeoutMs: args.timeoutMs,
    sleep: args.sleep,
    random: args.random,
  };

  // Values carried from whichever path (fresh or resume) sets them, through to the
  // attest/mint leg + the returned result.
  let burnTxHash: string;
  let eoaAddress: string;
  let depositWallet: string;
  let commitmentH = 0n;
  // The index actually used (fresh: the arg; resume: the cursor's). Returned so the
  // app can key its account-history record on either path.
  let resolvedIndex = accountIndex;
  let cursorSelection: Record<string, unknown> | undefined = selection;
  // True when resuming a pre-migration cursor that burned WITHOUT the
  // Forwarding-Service hook: Circle never generated a forwardTxHash for those, so
  // waitForBridgedMint would loop for 30 min then time out — surface a terminal
  // error instead.
  let isLegacyCursor = false;

  const inflight = readInflightBurn(evmAddress);
  if (inflight) {
    // RESUME PATH: a prior run already burned for this account. Resume from attest
    // off the cursor — skip the re-sign + burn entirely (re-burning double-spends).
    burnTxHash = inflight.burnTxHash;
    eoaAddress = inflight.eoaAddress;
    isLegacyCursor = !inflight.depositWallet;
    depositWallet = inflight.depositWallet ?? inflight.eoaAddress;
    resolvedIndex = inflight.bidIndex;
    cursorSelection = inflight.selection;
    // Resolve the mint-watch destination domain from the burn's PERSISTED chain
    // (authoritative — the burn already committed to it), NOT the resume-time arg.
    // Fall back to the arg's domain only for old cursors that predate evmChainId.
    if (inflight.evmChainId !== undefined) {
      destDomain = resolveEvmCctpDestination(inflight.evmChainId).domain;
    }
    emit('bridge', 'done', 'Resuming an in-flight transfer (already burned).');
  } else {
    // FRESH PATH.
    // PRE-FLIGHT (Bundle A2): prove localStorage can persist the resume cursor BEFORE
    // we burn. If it can't (private-browsing), refuse to burn — a silently-lost
    // cursor means a reload couldn't resume and the user could re-burn.
    emit('bridge', 'running');
    try {
      assertStorageWritable(STORAGE_PROBE_KEY, 'funding');
    } catch (err) {
      emit('bridge', 'error', sanitizeErrorMessage(err));
      throw err;
    }

    // Re-sign (fresh only) + derive the account nonce IN-MEMORY. account_nonce =
    // poseidon([tag, viewing_key, index]); commitment H is computed inside bridgeOut.
    // resolveSignature's throw (e.g. a user-rejected wallet prompt) propagates RAW —
    // no ('bridge','error') is emitted here so the caller can classify it as a soft
    // cancel rather than a burn-step failure.
    emit('bridge', 'running', 'Awaiting signature in your wallet…');
    const signature = await resolveSignature();
    const viewingKey = deriveViewingKey(signature);
    const accountNonce = deriveAccountNonce(viewingKey, accountIndex);

    try {
      // `fast` (resolved at function scope above) sizes the fee quote AND the burn's
      // declared finality just below, so they never diverge — and matches the Iris
      // poll cadence in pollKnobs.
      // FORWARDING-FEE FLOOR (pre-flight): the Forwarding Service deducts its fee IN
      // USDC from the burn, so the amount must clear it — quote the live max_fee and
      // reject a sub-floor amount with a CLEAR error here, rather than let the
      // Anonymizer's assert(amount > max_fee) revert opaquely. The quote's max_fee is
      // passed to bridgeOut so the burn carries the fee Circle will deduct.
      emit('bridge', 'running', 'Quoting CCTP forwarding fee…');
      const quote = await fetchForwardMaxFee(amount, { fast, destDomain });
      assertAboveForwardFloor(amount, quote);
      emit(
        'bridge',
        'running',
        `Withdraw + burn (one Starknet tx, ${fast ? 'CCTP Fast' : 'CCTP Standard'})…`,
      );
      const bridged = await bridgeOut({
        signature,
        accountIndex,
        accountNonce,
        amount,
        resolveDepositWallet,
        destChainId,
        minFinalityThreshold: fast ? FAST_FINALITY_THRESHOLD : STANDARD_FINALITY_THRESHOLD,
        // Fee + burn share the SAME fast flag here, but thread the quote's tier so the
        // burn-boundary guard fails closed if they ever diverge (defense-in-depth).
        quotedFinalityThreshold: quote.finalityThreshold,
        maxFee: quote.maxFee,
        onStatus: (m) => emit('bridge', 'running', m),
      });
      burnTxHash = bridged.burnTxHash;
      eoaAddress = bridged.eoaAddress;
      depositWallet = bridged.mintRecipient;
      commitmentH = bridged.commitmentH;
      // Persist the resume cursor BEFORE consuming the index (#232): if anything
      // throws/interrupts between the two writes, the index must still look
      // UNCONSUMED so this same accountIndex's cursor is still the resumable one —
      // consuming it first and then failing to persist the cursor would orphan the
      // burned wallet (its EOA/deposit-wallet becomes unreachable by any resume
      // path, since a NEW deposit would derive the NEXT index instead). Persist
      // BEFORE attest/mint too: from here the funds are committed to CCTP and
      // recovery must RESUME, not re-burn. A write failure (quota) is reported
      // non-fatally so the user doesn't reload + double-spend — do NOT abort (the
      // burn already committed the funds).
      const persisted = writeInflightBurnVerified(evmAddress, {
        burnTxHash,
        eoaAddress,
        depositWallet,
        bidIndex: accountIndex,
        // Persist the burn's destination chain so a RESUME gates the mint-watch on the
        // domain the burn actually targeted (Finding 3 — mirrors returnIn's evmChainId).
        evmChainId: resolveEvmCctpDestination(destChainId).chainId,
        amountHuman: humanAmount(amount),
        ...(cursorSelection ? { selection: cursorSelection } : {}),
      });
      // Consume the index only AFTER the resume cursor is durable, so a pre-burn
      // failure (fee quote, signature, proving) doesn't burn an index either.
      consumeAccountIndex(evmAddress, accountIndex);
      onBurned?.({ burnTxHash, eoaAddress, depositWallet, accountIndex });
      emit(
        'bridge',
        'done',
        persisted
          ? 'Withdrawn + burned via CCTP.'
          : 'Withdrawn + burned via CCTP. WARNING: could not save resume point — do NOT reload this tab until the funding completes.',
      );
    } catch (err) {
      emit('bridge', 'error', sanitizeErrorMessage(err));
      throw err;
    }
  }

  // Pre-migration burn (deposit_for_burn, no "cctp-forward" hook): Circle's
  // Forwarding Service was never involved, so Iris never generates a forwardTxHash;
  // waitForBridgedMint would time out in 30 min. Surface a terminal error and
  // PRESERVE the cursor (the burn tx hash is retained for manual recovery).
  if (isLegacyCursor) {
    emit(
      'mint',
      'error',
      `This transfer was created before the deposit-wallet upgrade — Circle's Forwarding ` +
        `Service was not used, so no automatic mint is possible. Check your per-account ` +
        `EOA (${eoaAddress}) on Polygon; if the USDC is there you can trade normally. ` +
        `Burn tx for support: ${burnTxHash}.`,
    );
    throw new Error(
      `This transfer was created before the deposit-wallet upgrade — no automatic mint is possible. ` +
        `Burn tx for support: ${burnTxHash}.`,
    );
  }

  // Attest → forwarded mint (waitForBridgedMint owns the pair + the A1 recipient
  // gate). A transient here is RESUMABLE (burn already landed) — the cursor is
  // preserved; a demonstrably-terminal Iris status clears it. `attested` tracks
  // which leg a throw belongs to so the failing step is reported correctly.
  let attested = false;
  let forwardTxHash: string;
  try {
    emit('attest', 'running', 'Waiting for Circle attestation…');
    const r = await waitForBridgedMint(burnTxHash, {
      expectedMintRecipient: depositWallet,
      destinationDomain: destDomain,
      onAttestStatus: (m) => emit('attest', 'running', m),
      onAttested: () => {
        attested = true;
        emit('attest', 'done', 'Attestation complete.');
        emit('mint', 'running', 'Circle is forwarding the mint on Polygon…');
      },
      onMintStatus: (m) => emit('mint', 'running', m),
      ...pollKnobs,
    });
    forwardTxHash = r.forwardTxHash;
    emit('mint', 'done', 'USDC minted on Polygon.');
  } catch (err) {
    emit(attested ? 'mint' : 'attest', 'error', sanitizeErrorMessage(err));
    // Only a DEMONSTRABLY-terminal status proves the funds will never mint here, so
    // resume can't help → clear. Everything else PRESERVES the cursor (the burn is
    // replayable forever by burnTxHash) so the next run resumes.
    if (isTerminalAttestFailure(err)) {
      clearInflightBurn(evmAddress);
    }
    throw err;
  }

  // Success — clear the cursor.
  clearInflightBurn(evmAddress);
  return {
    burnTxHash,
    accountIndex: resolvedIndex,
    eoaAddress,
    depositWallet,
    commitmentH,
    forwardTxHash,
    ...(cursorSelection ? { selection: cursorSelection } : {}),
  };
}

// Deposit-token base units → a human string for the resume cursor's amountHuman
// (the cursor + resume banner display). Uses the configured decimals; a plain
// fixed-point format is enough for a display/echo value.
function humanAmount(amountWei: bigint): string {
  const decimals = config.depositToken.decimals;
  if (decimals === 0) return amountWei.toString();
  const base = 10n ** BigInt(decimals);
  const whole = amountWei / base;
  const frac = amountWei % base;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fracStr}`;
}

export interface BridgeOutToWalletArgs {
  // EVM wallet signature of the app's identity sign-message — re-derives the SN account +
  // viewing key for the pool withdraw/proof. NO per-account EOA, NO account nonce: the
  // cash-out has no return claim.
  signature: string;
  // Amount to withdraw + burn, in USDC base units (1 USDC = 1e6).
  amount: bigint;
  // The USER's chosen Polygon destination: a 20-byte EVM address hex string.
  // Becomes the CCTP mint_recipient (no fresh per-account EOA).
  destination: string;
  // CCTP finality: 2000 = Standard (default), 1000 = Fast.
  minFinalityThreshold?: number;
  // The finality tier the `maxFee` quote was computed for (ForwardFeeQuote.
  // finalityThreshold). When set, bridgeOutToWallet FAILS CLOSED before burning if it
  // differs from the resolved min_finality_threshold — a fee/finality mismatch strands funds.
  quotedFinalityThreshold?: number;
  // Per-call CCTP fee cap (0 for Standard).
  maxFee?: bigint;
  // User-chosen bridge-OUT destination EVM chain id. Defaults to
  // config.cctp.defaultDestChainId; its CCTP domain is appended to the Buy calldata.
  destChainId?: number;
  onStatus?: (s: string) => void;
}

export interface BridgeOutToWalletResult {
  // Starknet tx hash of the withdraw+burn apply_actions (Iris polls this).
  burnTxHash: string;
  // The Polygon destination address that will receive the minted USDC.
  mintRecipient: string;
}

// Cash out from the pool to a USER-chosen Polygon address (Leg B). Same shape as
// bridgeOut() — withdraw to the Anonymizer + ONE InvokeExternal ->
// Anonymizer.privacy_invoke(Buy) — but: mint_recipient = the destination address
// (no per-account EOA) and no per-account commitment H (a cash-out has no return claim,
// and the burn no longer emits H — bridge-plan.md, threat-model.md).
// Manager-paid via the shared proveAndSubmitBridgeOut helper.
export async function bridgeOutToWallet(
  args: BridgeOutToWalletArgs,
): Promise<BridgeOutToWalletResult> {
  const { signature, amount, destination, onStatus } = args;
  const minFinalityThreshold = args.minFinalityThreshold ?? defaultFinalityThreshold();
  // Fail closed on a fee/finality tier mismatch BEFORE any on-chain work (fund-safety).
  assertQuotedFinalityMatchesBurn(args.quotedFinalityThreshold, minFinalityThreshold);
  const maxFee = args.maxFee ?? 0n;
  const destDomain = resolveEvmCctpDestination(args.destChainId).domain;
  const provider = getRpcProvider();

  const anonymizer = config.anonymizerAddress;
  if (!anonymizer) {
    throw new Error(
      'bridgeOutToWallet: anonymizer address not configured (ANONYMIZER_ADDRESS).',
    );
  }

  // 1. Recover SN account + viewing key from the signature (in-memory only). No
  // per-account EOA: the destination is the user's own address.
  onStatus?.('Recovering keys…');
  const snPrivateKey = deriveStarknetPrivateKey(signature);
  const viewingKey = deriveViewingKey(signature);
  const { address: snAddress } = deriveStarknetAccount(snPrivateKey, config.ozClassHash);
  const account = makeAccount(snAddress, snPrivateKey, provider);

  // mint_recipient: the 20-byte EVM destination as a u256 (numeric value of the
  // addr) — mirrors bridgeOut()'s BigInt(eoa.address).
  const mintRecipient = BigInt(destination);

  // STRK protocol fee: the MANAGER approves it up front (manager-paid submit).
  onStatus?.('Checking pool fee…');
  const feeAmount = await fetchPoolFeeAmount();
  let lastTxBlockNumber: number | undefined;
  if (feeAmount > 0n) {
    onStatus?.('Approving pool fee…');
    lastTxBlockNumber = await approvePoolFee(feeAmount);
  }

  const discoveryProvider = new IndexerDiscoveryProvider(config.indexerUrl, config.poolAddress);
  const transfers = createPrivateTransfers({
    account,
    viewingKeyProvider: { getViewingKey: async () => viewingKey },
    provingProvider: {
      url: config.proverUrl,
      chainId: config.chainId as constants.StarknetChainId,
    },
    discoveryProvider,
    poolContractAddress: config.poolAddress,
  });

  const burnTxHash = await proveAndSubmitBridgeOut({
    transfers,
    account,
    provider,
    anonymizer,
    viewingKey,
    amount,
    mintRecipient,
    maxFee,
    minFinalityThreshold,
    destDomain,
    lastTxBlockNumber,
    onStatus,
  });

  onStatus?.('Withdraw + burn submitted; awaiting CCTP attestation.');
  return { burnTxHash, mintRecipient: destination };
}

// ---------------------------------------------------------------------------
// cashOut — compose bridgeOutToWallet + waitForBridgedMint behind ONE cash-out
// orchestrator that owns the pmp.inflightCashOut resume cursor (Slice G,
// docs/bridge-sdk-refactor.md §1/§2). This replaces the hand-rolled burn→attest→
// mint state machine + cursor that lived in the app's ReturnContext.runCashOut.
// The app now passes only the base-unit amount + the user's chosen Polygon
// destination + the connected evmAddress + a lazy resolveSignature; the CCTP
// forwarding fee is quoted internally (mirrors fundAccountFromPool).
//
// Cash-out (Leg B) = withdraw from the pool OUT to a USER-chosen Polygon address.
// A cash-out has NO pool claim (no per-account EOA, no commitment H), so the cursor
// carries only the CCTP-leg fields. Distinct from pmp.inflightBurn (the fund leg)
// and pmp.inflightReturn (Leg A). The KEY string is unchanged (§1.1 — renaming it
// orphans in-flight cash-outs).
// ---------------------------------------------------------------------------

// The three on-the-wire legs a UI renders for a cash-out:
//   burn   = withdraw from the pool to the Anonymizer → CCTP-burn toward the
//            user's chosen Polygon address (ONE signed Starknet pool tx;
//            bridgeOutToWallet — no commitment_h, no return claim)
//   attest = poll Circle Iris for the attestation (source = Starknet)
//   mint   = Circle's Forwarding Service mints native USDC to `destination`
export type CashOutStep = 'burn' | 'attest' | 'mint';
export type CashOutStepStatus = 'pending' | 'running' | 'done' | 'error';

// In-flight cash-out cursor (NON-SECRET, persisted; migrated verbatim from
// ReturnContext). Once bridgeOutToWallet's withdraw+burn lands on Starknet the
// funds are committed to CCTP and the only thing left is attest → Polygon mint to
// `destination`. If attest/mint hits a transient (or the tab reloads), re-burning
// would DOUBLE-SPEND; so we persist the burn tx hash + destination + amount and
// resume from attest. Everything here is NON-SECRET (burnTxHash is public; the
// destination is the user's own address; the amount is what they withdrew).
// Cleared after a successful mint. Keyed per connected EVM address.
export const INFLIGHT_CASHOUT_KEY = 'pmp.inflightCashOut';

export interface InflightCashOut {
  burnTxHash: string;
  destination: string;
  amount: string; // base-unit bigint as a decimal string (localStorage is text)
  evmChainId: number;
}

// Validate a persisted cash-out cursor before trusting it (mirrors
// isValidInflightBurn). A corrupt/partial record must be treated as a FRESH
// cash-out rather than resumed off garbage. `destination` must be a 20-byte EVM
// address — it is fed verbatim to waitForBridgedMint as the expected recipient.
export function isValidInflightCashOut(value: unknown): value is InflightCashOut {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.burnTxHash === 'string' &&
    /^0x[0-9a-fA-F]+$/.test(r.burnTxHash) &&
    typeof r.destination === 'string' &&
    EVM_ADDRESS_RE.test(r.destination) &&
    typeof r.amount === 'string' &&
    /^\d+$/.test(r.amount) &&
    typeof r.evmChainId === 'number' &&
    Number.isFinite(r.evmChainId)
  );
}

function readInflightCashOutMap(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(INFLIGHT_CASHOUT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

// Read the cash-out cursor for an account, or null. A corrupt record is dropped
// (treat as a FRESH cash-out — the funds are recoverable from the signature; a
// garbage cursor can't be safely resumed). Exported (read-only, non-secret — the
// burnTxHash is public) so the app can surface the burn's explorer link on the
// burn leg even when a later leg (attest/mint) fails after the burn landed.
export function readInflightCashOut(addr: string | null | undefined): InflightCashOut | null {
  if (!addr) return null;
  const record = readInflightCashOutMap()[addr.toLowerCase()] ?? null;
  if (record === null) return null;
  if (!isValidInflightCashOut(record)) {
    clearInflightCashOut(addr);
    return null;
  }
  return record;
}

function writeInflightCashOut(addr: string, record: InflightCashOut): void {
  try {
    const map = readInflightCashOutMap();
    map[addr.toLowerCase()] = record;
    localStorage.setItem(INFLIGHT_CASHOUT_KEY, JSON.stringify(map));
  } catch {
    // Best-effort: a storage failure must not break the cash-out in THIS run
    // (attest/mint can still finish; only cross-reload resume is lost). The
    // pre-flight probe refuses to burn when storage is provably unwritable.
  }
}

function clearInflightCashOut(addr: string): void {
  try {
    const map = readInflightCashOutMap();
    delete map[addr.toLowerCase()];
    localStorage.setItem(INFLIGHT_CASHOUT_KEY, JSON.stringify(map));
  } catch {
    // ignore — clearing is best-effort.
  }
}

export interface CashOutArgs {
  // Lazy provider of the raw wallet signature (in-memory only). Called ONCE on the
  // FRESH-burn path (to drive bridgeOutToWallet) and NEVER on the resume path (no
  // re-sign — re-burning would double-spend). The returned signature is never
  // logged or persisted.
  resolveSignature: () => Promise<string>;
  // Amount to withdraw + burn, in deposit-token base units (1 USDC = 1e6). The app
  // scales the user-entered human amount before calling.
  amount: bigint;
  // The user's chosen destination address (20-byte EVM address) on the destination
  // chain. Becomes the CCTP mint_recipient; validated here before any sign/submit.
  destination: string;
  // Connected EVM address that KEYS the resume cursor.
  evmAddress: string;
  // User-chosen bridge-OUT destination EVM chain id. Defaults to
  // config.cctp.defaultDestChainId; its CCTP domain drives the Buy calldata + the
  // fee route + the forwarded-mint destination gate, and is recorded on the cursor.
  destChainId?: number;
  // Fires (step,'running') before each leg and (step,'done'|'error') after; the app
  // maps these to its Step/StepStatus UI. Presentation only — no window here.
  onStep?: (step: CashOutStep, status: CashOutStepStatus, detail?: string) => void;
  // Deterministic-test knobs forwarded to the mint pollers.
  intervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface CashOutResult {
  // Starknet tx hash of the withdraw+burn (Iris polls this).
  burnTxHash: string;
  // The Polygon destination the USDC minted to.
  destination: string;
  // Circle's Forwarding-Service mint tx on Polygon.
  forwardTxHash?: string;
  // NET amount actually minted at `destination` (gross burned amount minus the CCTP
  // forwarding fee, #140). On a resume the fee quote isn't persisted in the cursor,
  // so this falls back to the gross amount (display-only, no fund-safety impact).
  amountNet: bigint;
}

// Cash out from the pool OUT to a user-chosen Polygon address (Leg B): validate the
// destination + amount → withdraw+burn toward `destination` (bridgeOutToWallet) →
// attest (source = Starknet) → Circle Forwarding-Service mint (waitForBridgedMint,
// gated on expectedMintRecipient = destination), owning the pmp.inflightCashOut
// resume cursor. Resumable:
//   - a VALID cursor for this EVM address matching the destination → RESUME from
//     attest, SKIP the re-sign + burn (re-burning double-spends);
//   - a cursor for a DIFFERENT destination → refuse (clobbering it would strand the
//     in-flight funds);
//   - else the FRESH path: pre-flight storage, quote the CCTP forwarding fee + assert
//     the amount clears the floor, sign, burn, PERSIST the cursor BEFORE attest, then
//     attest + mint.
// On success the cursor is CLEARED. On a DEMONSTRABLY-terminal attest failure the
// cursor is cleared; any OTHER failure PRESERVES it (the burn is replayable by its
// tx hash — never strand a recoverable one).
export async function cashOut(args: CashOutArgs): Promise<CashOutResult> {
  const { resolveSignature, amount, destination, evmAddress, destChainId, onStep } = args;
  const emit = (step: CashOutStep, status: CashOutStepStatus, detail?: string): void =>
    onStep?.(step, status, detail);
  // Resolve the chosen destination chain up front (fail loud on an unsupported id).
  // The arg's domain is only a FALLBACK — the resume branch below overrides it with
  // the burn's PERSISTED chain (the cursor's evmChainId) so a resume with a conflicting
  // destChainId can't gate the mint-watch on the wrong domain (→ mismatch + stranding).
  let destDomain = resolveEvmCctpDestination(destChainId).domain;
  const pollKnobs = {
    // Fast-tier cadence for the merged attest→mint Iris poll (see fundAccountFromPool).
    fast: config.cctp.fast,
    intervalMs: args.intervalMs,
    timeoutMs: args.timeoutMs,
    sleep: args.sleep,
    random: args.random,
  };

  // Validate the destination BEFORE any sign/submit — a malformed address would
  // burn the funds toward an unspendable recipient.
  const dest = destination.trim();
  if (!EVM_ADDRESS_RE.test(dest)) {
    const err = new Error(
      'Enter a valid Polygon address (0x followed by 40 hex characters).',
    );
    emit('burn', 'error', err.message);
    throw err;
  }
  if (amount <= 0n) {
    const err = new Error('Enter an amount greater than zero.');
    emit('burn', 'error', err.message);
    throw err;
  }

  // Circle's Forwarding Service deducts this from the burned amount before minting
  // at `destination` (#140); stays 0 on resume (the quote isn't persisted).
  let maxFeeRaw = 0n;
  let effectiveAmount = amount;
  let burnTxHash: string;

  const inflight = readInflightCashOut(evmAddress);
  if (inflight && inflight.destination.toLowerCase() === dest.toLowerCase()) {
    // RESUME PATH: a prior run already burned for this account+destination. Resume
    // from attest off the cursor — skip the re-sign + burn (re-burning double-spends).
    burnTxHash = inflight.burnTxHash;
    effectiveAmount = BigInt(inflight.amount);
    // Gate the mint-watch on the burn's PERSISTED chain (authoritative on resume), not
    // the resume-time arg (Finding 3). Cash-out cursors always carry evmChainId (the
    // validator requires it), so no fallback is needed.
    destDomain = resolveEvmCctpDestination(inflight.evmChainId).domain;
    emit('burn', 'done', 'Resuming an in-flight cash-out (already burned).');
  } else {
    // GUARD: a cursor for a DIFFERENT destination exists — don't silently overwrite
    // it. The prior burn is committed to CCTP; clobbering the cursor would make those
    // funds unrecoverable via the resume path.
    if (inflight) {
      const err = new Error(
        `A cash-out to ${inflight.destination} is already in progress — ` +
          `re-enter that address to resume it, or wait for it to complete ` +
          `before cashing out to a different address.`,
      );
      emit('burn', 'error', err.message);
      throw err;
    }

    // PRE-FLIGHT: refuse to burn when storage can't persist the resume cursor.
    emit('burn', 'running');
    try {
      assertStorageWritable(STORAGE_PROBE_KEY, 'funding');
    } catch (err) {
      emit('burn', 'error', sanitizeErrorMessage(err));
      throw err;
    }

    // Re-sign (fresh only). resolveSignature's throw (e.g. a user-rejected wallet
    // prompt) propagates RAW — no ('burn','error') is emitted so the caller can
    // classify it as a soft cancel rather than a burn-step failure.
    emit('burn', 'running', 'Awaiting signature in your wallet…');
    const signature = await resolveSignature();

    try {
      const fast = config.cctp.fast;
      // FORWARDING-FEE FLOOR (pre-flight, mirrors fundAccountFromPool): Circle's
      // Forwarding Service deducts its fee IN USDC from the burn, so quote the live
      // max_fee and reject a sub-floor amount with a CLEAR error here.
      emit('burn', 'running', 'Quoting CCTP forwarding fee…');
      const quote = await fetchForwardMaxFee(amount, { fast, destDomain });
      assertAboveForwardFloor(amount, quote);
      maxFeeRaw = quote.maxFee;
      emit(
        'burn',
        'running',
        `Withdraw + burn (one Starknet tx, ${fast ? 'CCTP Fast' : 'CCTP Standard'})…`,
      );
      const bridged = await bridgeOutToWallet({
        signature,
        amount,
        destination: dest,
        destChainId,
        // Forwarding needs max_fee in BOTH modes (Circle deducts the flat forwarding
        // fee from the burn regardless of finality).
        minFinalityThreshold: fast ? FAST_FINALITY_THRESHOLD : STANDARD_FINALITY_THRESHOLD,
        // Thread the quote's tier so the burn-boundary guard fails closed if the fee
        // and the declared finality ever diverge (defense-in-depth; same fast flag here).
        quotedFinalityThreshold: quote.finalityThreshold,
        maxFee: quote.maxFee,
        onStatus: (m) => emit('burn', 'running', m),
      });
      burnTxHash = bridged.burnTxHash;
      // Persist the cursor BEFORE attest/mint: from here the funds are committed to
      // CCTP and recovery must resume, not re-burn. Keyed by the connected evmAddress.
      writeInflightCashOut(evmAddress, {
        burnTxHash,
        destination: dest,
        amount: amount.toString(),
        evmChainId: resolveEvmCctpDestination(destChainId).chainId,
      });
      emit('burn', 'done', 'Withdrawn + burned via CCTP.');
    } catch (err) {
      emit('burn', 'error', sanitizeErrorMessage(err));
      throw err;
    }
  }

  // Attest (source = Starknet) → Circle Forwarding-Service mint to `destination`
  // (waitForBridgedMint owns the pair + the A1 recipient gate: the attested message
  // MUST mint to the exact destination the burn targeted). A transient here is
  // RESUMABLE (the burn already landed) — the cursor is preserved; a demonstrably-
  // terminal Iris status clears it.
  let attested = false;
  let forwardTxHash: string;
  try {
    emit('attest', 'running', 'Waiting for Circle attestation…');
    const r = await waitForBridgedMint(burnTxHash, {
      expectedMintRecipient: dest,
      destinationDomain: destDomain,
      onAttestStatus: (m) => emit('attest', 'running', m),
      onAttested: () => {
        attested = true;
        emit('attest', 'done', 'Attestation complete.');
        emit('mint', 'running', 'Circle is forwarding the mint on Polygon…');
      },
      onMintStatus: (m) => emit('mint', 'running', m),
      ...pollKnobs,
    });
    forwardTxHash = r.forwardTxHash;
    emit('mint', 'done', 'USDC minted on Polygon.');
  } catch (err) {
    emit(attested ? 'mint' : 'attest', 'error', sanitizeErrorMessage(err));
    // Only a DEMONSTRABLY-terminal status proves the funds will never mint here →
    // clear. Everything else PRESERVES the cursor (the burn is replayable forever by
    // burnTxHash) so the next run resumes.
    if (isTerminalAttestFailure(err)) {
      clearInflightCashOut(evmAddress);
    }
    throw err;
  }

  // Success — clear the cursor. NET amount actually minted at `destination` is
  // gross − the forwarding fee (#140); display-only, so a resume (maxFeeRaw 0) falls
  // back to gross.
  clearInflightCashOut(evmAddress);
  const amountNet = effectiveAmount > maxFeeRaw ? effectiveAmount - maxFeeRaw : effectiveAmount;
  return { burnTxHash, destination: dest, forwardTxHash, amountNet };
}

// A post-send throw from submitAndTrack means send() already put the burn tx on
// Starknet, so it is genuinely IN-FLIGHT (Iris can poll its hash) — UNLESS the
// throw is a DEFINITIVE on-chain failure: an execution REVERT or a REJECTED
// finality. A reverted withdraw+burn reverts ATOMICALLY — no CCTP burn happens
// and the funds stay in the pool — so returning that hash as a successful burn
// would make fundAccountFromPool consume the index + persist a resume cursor for
// a burn that never occurred: the account is bricked (the index is spent, the
// resume path always skips the burn, and attest polls a non-existent burn to a
// 30-min timeout that reads as "resumable"). So only a NON-revert/reject post-send
// throw (a tracking timeout) is returnable; a REVERTED/REJECTED propagates as a
// fresh-path terminal error and NO cursor is written. isRevertedOrRejected
// (core/tx.ts) matches submitAndTrack's literal REVERTED/REJECTED words — shared
// with bridgeBack.ts's + deposit.ts's identical guards.

interface ProveAndSubmitArgs {
  transfers: PrivateTransfersInterface;
  account: Account;
  provider: ReturnType<typeof getRpcProvider>;
  anonymizer: string;
  // Viewing key — read-only capability used ONLY by the prove-early quiescence gate
  // to discover the account's note-id set at two blocks (never logged/persisted).
  viewingKey: bigint;
  amount: bigint;
  mintRecipient: bigint;
  maxFee: bigint;
  minFinalityThreshold: number;
  // CCTP destination domain of the chosen bridge-OUT chain — appended to the Buy
  // calldata as the LAST felt (dest_domain: u32).
  destDomain: number;
  lastTxBlockNumber: number | undefined;
  onStatus?: (s: string) => void;
}

// Build the withdraw+invoke action, prove it against an aged block, and submit.
// On a submit failure (commonly a stale cached pool nonce), invalidate the SDK's
// proof-nonce cache and rebuild/re-prove once. Mirrors deposit.ts/register.ts.
// Returns the submitted burn tx hash.
async function proveAndSubmitBridgeOut(opts: ProveAndSubmitArgs): Promise<string> {
  const {
    transfers,
    account,
    provider,
    anonymizer,
    viewingKey,
    amount,
    mintRecipient,
    maxFee,
    minFinalityThreshold,
    destDomain,
    onStatus,
  } = opts;
  // Proving anchor — a from-pool withdraw PROVES BY SPENDING A PRE-EXISTING POOL NOTE, so
  // the proof MUST age past whatever committed that note. Crucially, that note can be from
  // THIS session: a user who ran Move Into Pool and then Move From Pool within
  // ~PROVING_BLOCK_DEPTH blocks (~a few seconds) has a freshly-deposited note not yet buried
  // in the tree. If we prove at `latest − depth` WITHOUT aging, the base block can predate
  // that note's commitment → the pool `apply_actions` reverts on-chain (a failed first
  // attempt until the chain advances). So we ALWAYS seed an anchor and age
  // PROVING_BLOCK_DEPTH (=8) past it, on BOTH paths.
  //
  // MANAGER path: opts.lastTxBlockNumber is the manager's STRK fee-approve block committed
  // THIS run — which is ≥ any earlier same-session deposit, so aging past it buries the
  // deposit too. Seed from it.
  //
  // AVNU-PAYMASTER path: opts.lastTxBlockNumber is undefined (approvePoolFee is a NO-OP
  // under a paymaster — poolFee.ts:39 — because the pool fee is BAKED INTO THE PROOF as a
  // withdraw to the AVNU forwarder, NOT a separate on-chain approve). With no fee-approve tx
  // to seed from, seed the anchor from the CURRENT HEAD: aging PROVING_BLOCK_DEPTH past the
  // live head guarantees the base includes everything committed before the withdraw started,
  // including a same-session deposit.
  //
  // Follow-up (deferred): a faster safe path would thread the caller's freshest COMMITTED
  // pool-deposit block into this leg (the established paymaster-aging pattern — see the
  // "Every proof-carrying leg needs a proving-block AGING ANCHOR … thread the caller's
  // freshest committed dependency" lesson in .claude/rules/code-style.md), so a withdraw
  // that spends only OLD, already-buried notes needn't wait the full window.
  //
  // Captured ONCE — a failed submit commits no new block. The anchor is reused verbatim by
  // the one-shot rebuild retry (never re-anchored to a newer head, which would force a fresh
  // full aging wait for nothing).
  const anchor = opts.lastTxBlockNumber ?? (await getCurrentBlock(provider));

  // AVNU-relay-in-flight flag (mirrors deposit.ts). Set by paymasterExecuteLeg's
  // onRelayStart, fired AFTER any signMessage, right before executeTransaction. Once
  // set, the AVNU relayer may already have broadcast the proven withdraw+burn, so a
  // throw from that point on is AMBIGUOUS — a blind retry would re-prove over the SAME
  // notes and request a SECOND pool withdrawal / CCTP burn (double-burn, saved only by
  // pool nullifiers; live-observed 2026-07-03: a spurious execute error 156 over a burn
  // that actually landed). We fail closed instead of retrying. A throw BEFORE it fires
  // (build/prove/nonce) submitted nothing and stays safe to retry.
  let paymasterSubmissionStarted = false;

  // Prove-early optimisation (now the default — no flag): a withdraw that spends only OLD,
  // already-buried notes needn't wait the ~8-block (~16s) aging window.
  // Prove at `latest − IMMEDIATE_PROVING_BLOCK_DEPTH` (12 — clears the sequencer's ~10-block
  // get_block_hash floor) with NO aging wait. The SDK compiler pins note discovery+selection
  // to provingBlockId, so a fresh (not-yet-buried) note is INVISIBLE at that base → the
  // build/prove FAILS CLOSED pre-submit (compile-time "Insufficient balance", or a prove-step
  // error if the indexer returns a "latest tagged N" snapshot). On ANY such failure we fall
  // back ONCE to today's aging path (the immediate build+prove catch below). build+prove
  // PRECEDES submit, so that fallback is always pre-`onRelayStart` — it can NEVER re-fire
  // after a relay has broadcast the burn. Captured ONCE (NOT via waitForProvingBlock(
  // undefined,12), which would re-read `latest` on a rebuild).
  //
  // QUIESCENCE GATE (usability, over the fail-closed backstop above): prove-early is only SAFE
  // when the account committed NO state in the ~12-block window — otherwise the stale
  // `latest − 12` view can reuse an already-consumed write-once slot, and the SDK still builds
  // a VALID proof that reverts ON-CHAIN (`NON_ZERO_VALUE`), escaping the pre-submit catch into
  // the fail-closed submit path (a hard fail the user must rerun). So we only take the immediate
  // path when the account is provably QUIESCENT: its spendable note-id set is IDENTICAL at
  // `immediateBase` and at head. Any addition OR removal (spend) ⇒ age (today's path). Compare
  // by id SET, not count — a spent-with-no-change note is a removal a max-of-count gate would
  // miss. The withdraw draws from the deposit token; the baked paymaster fee withdraw draws from
  // the SAME token, so one token covers both legs. FAIL-SAFE: wrap the two reads so ANY failure
  // (indexer down, or a historical numeric block_ref unsupported) degrades to aging — never
  // aborts the withdraw (this is a pre-relay read; failure is safe/retryable). Worst case = the
  // ~8-block aging wait we do today. Shared with bridgeBack.ts's return claim — see proveEarly.ts.
  const tokens = [BigInt(config.depositToken.address)];
  const { eligible: immediateEligible, immediateBase } = await checkProveEarlyQuiescence({
    provider,
    snAddress: account.address,
    viewingKey,
    tokens,
    onStatus,
  });
  // Pinned once the proving block is decided (immediate OR aged) so the submit-phase
  // stale-nonce retry rebuilds+re-proves at the SAME block — never re-aging, never re-running
  // the immediate probe (which would risk a post-relay re-fire). The OFF path leaves this
  // undefined and re-selects via waitForProvingBlock on each attempt (today's behaviour).
  let resolvedProvingBlock: number | string | undefined;

  // Build + prove the withdraw + burn at an explicit proving block. PROVE-ONLY
  // (createProofInvocation + executeWithInvocation both precede submit), so any throw here is
  // pre-relay and safe to retry / fall back from.
  const buildAndProve = async (
    provingBlockId: number | string,
    feeWithdraw: { recipient: string; amount: bigint } | undefined,
  ) => {
    onStatus?.('Building withdraw + burn…');
    // The pool runs Withdraw BEFORE the InvokeExternal, so the Anonymizer
    // already holds the USDC when privacy_invoke approves + deposit_for_burn.
    // privacy_invoke returns an empty span (nothing returns to the pool);
    // surplus (selected-note change) goes back to the submitter as a note.
    const builder = transfers
      .build({
        autoSetup: true,
        autoDiscover: { notes: 'refresh', channels: 'refresh' },
        autoSelectNotes: 'naive',
      })
      .surplusTo(account.address)
      .with(config.depositToken.address, (t) => {
        t.withdraw({ recipient: anonymizer, amount });
        // Bake the AVNU pool fee in as a withdraw to the forwarder (paymaster path).
        // Drawn from the user's notes alongside the account amount; surplusTo returns change.
        if (feeWithdraw) t.withdraw({ recipient: feeWithdraw.recipient, amount: feeWithdraw.amount });
      })
      .invoke(() => ({
        contractAddress: anonymizer,
        // privacy_invoke(params: BuyParams). The canonical OutboundAnonymizer takes
        // a FLAT BuyParams (no enum wrapper), so BuyParams serialises as
        // [mint_recipient(u256), amount(u256), max_fee(u256),
        //  min_finality_threshold(u32), destination_domain(u32)] → 8 felts (6 u256-halves
        //  + 2 u32; NO leading discriminant). `destDomain` (the LAST felt) is the CCTP
        //  domain of the chosen bridge-OUT chain, so Circle mints on that chain
        //  (Polygon 7/Base 6/Arbitrum 3/Ethereum 0/Optimism 2). No commitment_h:
        //  the per-account H is no longer emitted on-chain (it lives client-side + on
        //  the return leg only). The selector is supplied by the pool's InvokeExternal
        //  (privacy_invoke), so the calldata carries only the entrypoint args.
        calldata: [
          ...u256Calldata(mintRecipient),
          ...u256Calldata(amount),
          ...u256Calldata(maxFee),
          minFinalityThreshold.toString(),
          destDomain.toString(),
        ],
      }));

    const invocation = await builder.createProofInvocation({ provingBlockId });

    onStatus?.('Generating proof (this can take a few seconds)…');
    const { callAndProof } = await transfers.executeWithInvocation(invocation, provingBlockId);

    // Manager-paid: submitProvenCall sends the proven call from the MANAGER,
    // forwarding the proof + proof facts (the derived account's identity rides in
    // the calldata). Bridge the SDK's Call through the app's Call type (separate
    // starknet copies).
    const proofDetails = callAndProof.proof.proofFacts?.length
      ? { proof: callAndProof.proof.data, proofFacts: callAndProof.proof.proofFacts }
      : {};
    const call = callAndProof.call as unknown as Call;
    return { call, proofDetails };
  };

  // Returns void: the burn tx hash is captured into the function-scoped
  // `burnTxHash` below (C4) so the retry guard can inspect it after a throw.
  const attempt = async (): Promise<void> => {
    // PAYMASTER path: the pool fee must be baked into the proof as a withdraw to the
    // AVNU forwarder (AVNU 165 otherwise). buildTransaction FIRST to learn the fee, then
    // inject it into the SAME USDC `.with()` block as the account withdraw — both draw from
    // the user's private notes (mirrors deposit.ts; open-questions.md #13).
    let paymasterCtx: PaymasterBuildCtx | undefined;
    let feeWithdraw: { recipient: string; amount: bigint } | undefined;
    if (config.paymaster) {
      onStatus?.('Requesting pool fee from paymaster…');
      paymasterCtx = await paymasterBuildLeg(account); // apply_action (no user call)
      const fa = paymasterCtx.feeAction;
      if (fa && BigInt(fa.amount || '0') !== 0n) {
        if (BigInt(fa.token) !== BigInt(config.depositToken.address)) {
          throw new Error(
            `AVNU pool fee is in ${fa.token}, not the deposit token ${config.depositToken.address}. ` +
              'Use AVNU_FEE_MODE=sponsored_private with the deposit token as the pool fee token.',
          );
        }
        feeWithdraw = { recipient: fa.recipient, amount: BigInt(fa.amount) };
      }
    }

    // Resolve the proving block + build+prove. The stale-nonce submit retry re-enters here;
    // once resolvedProvingBlock is pinned (ON path) it rebuilds at the SAME block (no re-age).
    let built: Awaited<ReturnType<typeof buildAndProve>>;
    if (immediateEligible && resolvedProvingBlock === undefined) {
      // Quiescent + first attempt: prove immediately at latest−12; on ANY failure age ONCE.
      // proveWithImmediateFallback's catch is catch-ALL (not a string match): a "latest
      // tagged N" indexer surfaces the shortfall at the prove step, not compile — a narrow
      // catch would hard-fail the withdraw.
      const { result, provingBlockId } = await proveWithImmediateFallback({
        provider,
        immediateBase,
        resolveAgingAnchor: () => anchor,
        onStatus,
        buildAndProveAt: (blockId) => buildAndProve(blockId, feeWithdraw),
      });
      built = result;
      resolvedProvingBlock = provingBlockId;
    } else if (resolvedProvingBlock !== undefined) {
      // Submit-phase retry on the ON path: reuse the SAME proving block (no re-age).
      built = await buildAndProve(resolvedProvingBlock, feeWithdraw);
    } else {
      // Not quiescent (recent in-window activity / discovery failed): today's aging path,
      // unchanged. resolvedProvingBlock stays undefined here so every attempt re-selects via
      // waitForProvingBlock (today's behaviour).
      onStatus?.('Selecting proving block…');
      const provingBlockId = await waitForProvingBlock(provider, anchor, onStatus, PROVING_BLOCK_DEPTH);
      built = await buildAndProve(provingBlockId, feeWithdraw);
    }

    onStatus?.('Submitting withdraw + burn…');
    // Capture the burn tx hash from the submit callback's own result — it's the
    // value Iris polls. Declared outside `attempt` so that if submitAndTrack throws
    // AFTER send() already succeeded (tracking timeout), the first hash is preserved
    // and the retry guard below can return it instead of re-submitting.
    //
    // Retry the SAME built proof on full-node lag, no re-prove (resetRelayState clears this
    // attempt's relay/hash state between lag retries). A non-lag error rethrows into the
    // outer catch below unchanged. See nodeLagRetry.ts.
    const runSubmit = async (): Promise<void> => {
      await submitAndTrack(
        provider,
        async () => {
          // Paymaster path: AVNU's relayer submits the proven apply_action (the fee
          // withdraw is already baked into the proof). Manager path: submitProvenCall
          // passes explicit resourceBounds so account.execute skips the proof-less fee
          // estimate that would revert the proven apply_actions — see proven-submit.ts.
          const res = paymasterCtx
            ? await paymasterExecuteLeg(account, built.call, built.proofDetails, paymasterCtx, {
                // Flip only when the AVNU relay actually starts (after any signMessage) —
                // a pre-relay throw relays nothing and stays safely retryable.
                onRelayStart: () => {
                  paymasterSubmissionStarted = true;
                },
              })
            : await submitProvenCall(provider, account, built.call, built.proofDetails);
          burnTxHash = res.transaction_hash;
          return res;
        },
        {
          until: 'ACCEPTED_ON_L2',
          onStatus: ({ finality }) =>
            onStatus?.(`Submitting withdraw + burn (${humanizeFinality(finality)})…`),
        },
      );
    };
    await submitReusingProofOnNodeLag(runSubmit, {
      resetRelayState: () => {
        paymasterSubmissionStarted = false;
        burnTxHash = '';
      },
      onStatus,
    });
  };

  // burnTxHash is hoisted here so the retry guard can inspect it.
  let burnTxHash = '';
  try {
    await attempt();
  } catch (err) {
    // If burnTxHash was already set the submit SUCCEEDED but submitAndTrack timed
    // out waiting for ACCEPTED_ON_L2. The burn IS in-flight on Starknet — return
    // its hash so Iris can be polled for it. Do NOT re-submit (would double-burn).
    // But a REVERTED/REJECTED throw is NOT an in-flight burn (the withdraw+burn
    // reverted atomically, no CCTP burn) — let it propagate so NO resume cursor is
    // written for a burn that never happened.
    if (burnTxHash && !isRevertedOrRejected(err)) return burnTxHash;
    // Exhausted node-lag: propagate, never rebuild — the node is still behind, so a
    // same-anchor re-prove would just node-lag again. Before the fail-closed guard so it
    // also covers the manager path (mirrors bridgeBack).
    if (isNodeLagError(err)) throw err;
    // AMBIGUITY GUARD (paymaster path): fail closed ONLY when the AVNU relay is
    // in-flight AND no tx hash was obtained (executeTransaction threw) — the relayer
    // may have broadcast the burn anyway (live-observed: a spurious error 156 over a
    // burn that landed), we cannot find it (AVNU's error carries no hash; the SDK has
    // no nullifier/tx lookup), and re-proving over the same notes would DOUBLE the
    // pool withdrawal / CCTP burn. A KNOWN hash is observable, not ambiguous: a
    // tracking timeout returned it above (Iris polls it); reaching here with a hash
    // means the burn was tracked to terminal REVERTED/REJECTED — an atomic no-burn
    // (notes unspent), safe to rebuild + retry exactly like the manager path.
    if (paymasterSubmissionStarted && !burnTxHash) throw err;
    // Falling through to the rebuild retry: a hash reaching here is definitively dead
    // (REVERTED/REJECTED) — clear it so a retry that fails WITHOUT its own hash can't
    // resurrect the dead one as a live burn via the retry guard below.
    burnTxHash = '';
    transfers.invalidateProofNonceCache();
    onStatus?.(`Submit failed (${sanitizeErrorMessage(err)}); retrying…`);
    // Do NOT re-anchor to head: the failed submit committed no new block, so the
    // original (already-captured) `anchor` is still the correct proving anchor.
    // Re-waiting the full PROVING_BLOCK_DEPTH window here would needlessly stall the
    // retry (and a code-52 already recovers in-call in managerExecute).
    try {
      await attempt();
    } catch (retryErr) {
      // Same guard as the first attempt: if the RETRY's send() already succeeded
      // (burnTxHash set) but submitAndTrack then timed out, the burn IS in-flight
      // on Starknet — return its hash so Iris can be polled. An un-guarded throw
      // here would reject bridgeOut AFTER the burn landed, so the caller's failure
      // path would never persist the resume cursor and a later run could re-burn
      // (double pool withdrawal). Do NOT re-submit. A REVERTED/REJECTED retry is
      // NOT in-flight (reverted atomically) — propagate it so no cursor is written.
      if (burnTxHash && !isRevertedOrRejected(retryErr)) return burnTxHash;
      throw retryErr;
    }
  }
  return burnTxHash;
}
