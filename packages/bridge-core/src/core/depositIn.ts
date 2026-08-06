// Fund the pool deposit from the user's OWN MetaMask USDC — instead of the dev
// treasury transferring it into the derived account (ensureDepositTokenFunded).
//
// This is the CCTP "deposit-in" leg: the mirror of the fund-account leg's
// Starknet→Polygon burn (bridgeOut.ts / polygonMint.ts), with source and destination swapped:
//
//   1. MetaMask (on its current EVM chain) approves USDC to the source
//      TokenMessengerV2, then depositForBurn(dest = Starknet, mintRecipient =
//      derived SN account). The USER pays the EVM gas from their own wallet.
//   2. Poll Circle Iris for the attestation, keyed by the EVM SOURCE domain.
//   3. Submit receive_message(message, attestation) on Starknet's
//      MessageTransmitterV2 → native USDC mints to the derived SN account. This
//      is permissionless (destination_caller = 0), so the MANAGER submits it
//      (pays the Starknet gas) — keeping the derived account STRK-free, matching
//      the manager-pays model used for the proven legs (proven-submit.ts).
//
// Privacy: funding the SN account is NOT the protected hop — the link to break is
// SN-exit ↔ Polygon EOA (docs/threat-model.md). The SN account already derives
// from the same MetaMask signature, so MetaMask → SN account is a known linkage;
// sourcing the deposit from MetaMask changes nothing about what stays private.
//
// LIVE-VERIFICATION BOUNDARY (.claude/rules/verification.md): the cross-chain burn
// → attest → mint can only be confirmed against live CCTP infra + a funded
// MetaMask. The unit tests pin the client behaviour (chain selection, burn args,
// attestation source domain, receive_message calldata) against mocked viem/Iris.

import {
  BaseError,
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  encodeFunctionData,
  http,
  UnknownBundleIdError,
  type Abi,
  type EIP1193Provider,
} from 'viem';
import { getCallsStatus, getCapabilities, sendCalls } from 'viem/actions';

import type { Account } from 'starknet';

import { config, evmExplorerTxUrl, getEvmCctpSource, type EvmCctpSource } from './config';
import { getDepositTokenBalance } from './deposit';
import { markNonRetryable } from './errors';
import { getRpcProvider } from './provider';
import { READ_BLOCK } from './tx';
import {
  isTerminalAttestFailure,
  waitForAttestation,
  extractCctpNonce,
  assertCctpMessageMatches,
  decodeCctpMintedAmount,
} from './polygonMint';
import { submitStarknetMint, snAddressToBytes32 } from './snMint';
import {
  FAST_FINALITY_THRESHOLD,
  STANDARD_FINALITY_THRESHOLD,
  assertAboveForwardFloor,
  fetchForwardMaxFee,
} from './cctpFees';
import { switchChain, type EthereumProvider } from '../lib/ethereum';
import { hasAnyInflightReturn } from './returnIn';
import { hasAnyPendingReturnBurn } from './pendingReturnBurn';
import { hasAnyInflightBurn } from './account-store';
import { assertStorageWritable } from './storageProbe';

// CCTP Standard finality (free, finalized) — the default. 1000 = Fast (a small fee).
const STANDARD_FINALITY = STANDARD_FINALITY_THRESHOLD;

// Native-gas (POL/ETH) pre-check budget (FRESH burn path). The fresh path sends two
// EVM txs (approve + depositForBurn) the USER pays for. We estimate the approve
// PRECISELY (estimateContractGas — estimable pre-allowance) and add a CONSERVATIVE
// fixed budget for depositForBurn (NOT estimable pre-approve: it transferFroms USDC
// so it'd revert without a live allowance). Cost ≈ (approveUnits +
// BURN_GAS_UNITS_BUDGET) × the EIP-1559 effective per-gas cap (maxFeePerGas — what
// viem actually caps a tx at, roughly baseFee×2 + priorityFee, MAX'd with
// getGasPrice) × a 2× safety factor for drift between this read and broadcast. The
// old estimate used getGasPrice() alone × a flat 300k and UNDER-caught a real
// Ethereum shortfall (#192), so the maxFeePerGas + precise-approve estimate below.
const BURN_GAS_UNITS_BUDGET = 150_000n;
// Fallback flat approve+burn envelope if estimateContractGas is unavailable/throws —
// keeps the preflight from ever crashing (matches the old conservative budget).
const FRESH_PATH_GAS_UNITS = 300_000n;
const GAS_PRICE_SAFETY_NUM = 2n;
const GAS_PRICE_SAFETY_DEN = 1n;
// How long to wait for an EIP-5792 batch to reach a terminal status. Matches the
// two-tx path's waitForTransactionReceipt default so the batch is never more
// timeout-prone than the sequential flow (see the wait site for the double-spend
// rationale).
//
// We poll wallet_getCallsStatus ourselves (waitForBatchStatus) rather than use viem's
// waitForCallsStatus: a wallet can transiently answer with UnknownBundleIdError (5730,
// "bundle id unknown / not submitted") for the first few seconds after wallet_sendCalls
// returns, while its background worker/bundler is still cold. viem treats a THROWN 5730
// as fatal after only ~3s of internal retries — its timeout budget covers a `pending`
// STATUS, not a thrown error — so it aborts the deposit far inside this budget. Observed:
// a deposit failed with 5730, then succeeded verbatim after a page reload warmed the
// wallet. Our loop absorbs an early 5730 as not-ready-yet, up to the full budget.
const BATCH_CALLS_TIMEOUT_MS = 180_000;
// Cadence for polling wallet_getCallsStatus while waiting for a batch to settle.
const BATCH_POLL_INTERVAL_MS = 2_000;

// EVM priority-fee (tip) margin. The deposit-in approve/burn are submitted with an
// EXPLICIT EIP-1559 fee read live from the source-chain RPC — never left to the
// wallet's own (often too-low) default. Polygon chains ENFORCE a per-chain minimum
// tip (Amoy: 25 gwei; see EvmCctpSource.minPriorityFeeGwei) and reject a submit
// whose tip is below it with "gas tip cap … below minimum" (2026-07-08): the node's
// suggested tip can sample a hair UNDER the floor (24.25 vs 25 gwei), and a wallet
// default can be far under (1.5 gwei). So we (a) floor the estimated tip to the
// chain's enforced minimum, then (b) multiply UP by this margin so a slightly-stale
// sample can't land under — without hardcoding a bare gwei literal in the value path
// (the floor is per-chain config; this is just headroom).
const PRIORITY_FEE_MARGIN_NUM = 2n;
const PRIORITY_FEE_MARGIN_DEN = 1n;

// Pick the EIP-1559 fees to submit with, given the RPC's live estimate and the
// chain's enforced minimum tip (wei; undefined = no enforced floor). The tip is
// `max(estimatedTip, floor) × margin`; the cap keeps the estimate's base-fee
// headroom and adds the new tip, preserving maxFeePerGas ≥ maxPriorityFeePerGas
// (viem's invariant). Pure + exported for a red→green unit test — the live submit
// itself stays testnet/human-gated (.claude/rules/verification.md).
export function selectEip1559Fees(
  estimate: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  minPriorityFeeWei?: bigint,
): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  const floor = minPriorityFeeWei ?? 0n;
  const base =
    estimate.maxPriorityFeePerGas > floor ? estimate.maxPriorityFeePerGas : floor;
  const tip = (base * PRIORITY_FEE_MARGIN_NUM) / PRIORITY_FEE_MARGIN_DEN;
  // Base-fee portion of the estimated cap (never negative), + the bumped tip.
  const basePortion =
    estimate.maxFeePerGas > estimate.maxPriorityFeePerGas
      ? estimate.maxFeePerGas - estimate.maxPriorityFeePerGas
      : 0n;
  return { maxFeePerGas: basePortion + tip, maxPriorityFeePerGas: tip };
}

const ERC20_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const satisfies Abi;

// CCTP V2 depositForBurn (circlefin EVM TokenMessengerV2). Param order matches
// docs/bridge-plan.md §3 / the Starknet deposit_for_burn used by the Anonymizer.
const TOKEN_MESSENGER_ABI = [
  {
    type: 'function',
    name: 'depositForBurn',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'burnToken', type: 'address' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32' },
    ],
    outputs: [],
  },
] as const satisfies Abi;

// TokenMessengerV2 DepositForBurn event — used by waitForBatchStatus's on-chain
// scan to discover our burn tx hash when the wallet stops answering
// wallet_getCallsStatus (see the scan block inside waitForBatchStatus). Indexed
// per Circle's V2: burnToken, depositor, minFinalityThreshold. All other fields
// are matched in code after the RPC-side filter narrows to (address, depositor).
const TOKEN_MESSENGER_EVENT_ABI = [
  {
    type: 'event',
    name: 'DepositForBurn',
    inputs: [
      { name: 'burnToken', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'depositor', type: 'address', indexed: true },
      { name: 'mintRecipient', type: 'bytes32', indexed: false },
      { name: 'destinationDomain', type: 'uint32', indexed: false },
      { name: 'destinationTokenMessenger', type: 'bytes32', indexed: false },
      { name: 'destinationCaller', type: 'bytes32', indexed: false },
      { name: 'maxFee', type: 'uint256', indexed: false },
      { name: 'minFinalityThreshold', type: 'uint32', indexed: true },
      { name: 'hookData', type: 'bytes', indexed: false },
    ],
  },
] as const satisfies Abi;

const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as const;

// Build the friendly, TERMINAL gas-shortfall message (errors.ts TERMINAL_RE matches
// "insufficient funds"): a fund-your-wallet pointer PLUS a steer to a cheaper source
// chain (#191's picker). Reused by the native-gas PREFLIGHT and the broadcast-time
// catch, so a raw viem "insufficient funds for gas" revert never reaches the user
// verbatim (#192). `requiredWei` is included only when known (the preflight has it;
// the broadcast catch, hit after a between-read gas spike, does not).
function insufficientGasMessage(
  source: EvmCctpSource,
  evmAddress: string,
  nativeBalance: bigint,
  requiredWei?: bigint,
): string {
  const sym = source.nativeCurrency.symbol;
  const faucet = source.faucetUrl ? ` (e.g. ${source.faucetUrl})` : '';
  const need = requiredWei !== undefined ? `, needs ~${requiredWei} wei` : '';
  return (
    `Insufficient funds for gas: ${sym} on ${source.chainName} — fund ${evmAddress} ` +
    `with ${sym}${faucet} or pick a cheaper source chain, then retry ` +
    `(has ${nativeBalance} wei${need}).`
  );
}

// --- inflight-deposit resume cursor (Fix 1 / Bundle A2) ----------------------
// The deposit-in CCTP burn → attest → mint window is minutes long. Once the burn
// lands, the USER's own USDC is committed to CCTP and the only thing left is to
// finish attest → Starknet mint. A tab reload / crash / retry in that window
// would otherwise re-run depositForBurn and DOUBLE-BURN the user's funds (the
// on-Starknet balance check only guards AFTER the mint lands). So we persist the
// burn tx hash + source domain + amount + recipient (all NON-SECRET, all public
// once the burn is on-chain) keyed per FUNDER, and resume from attest. Cleared
// after a successful mint. waitForAttestation is idempotent on the same burnTx.
const INFLIGHT_DEPOSIT_KEY = 'pmp.inflightDeposit';

interface InflightDeposit {
  // Always a 0x-hex burn tx hash (deposit-in is native-gas only).
  burnTx: string;
  sourceDomain: number;
  amountWei: string; // bigint serialized as a decimal string
  snRecipient: string;
  evmChainId: number;
  // #229: the forwarding max_fee ACTUALLY burned with (bigint serialized as a
  // decimal string). A resume must compute netMintedWei from THIS persisted fee,
  // never a fresh fetchForwardMaxFee() quote — the live fee can drift between the
  // original burn and a later resume, and CCTP already minted `amountWei − (the
  // ORIGINAL maxFee)`, not `amountWei − (today's maxFee)`. Undefined on a
  // pre-#229 legacy cursor (falls back to a fresh quote — the prior behavior).
  maxFee?: string;
  // How the burn was STARTED: true iff it was launched on the single-tx FOLD path
  // (the mint rides inside the atomic pool deposit). Persisted at burn time so the
  // resume path classifies a CONSUMED CCTP nonce off how the burn began — NOT off
  // `deferMint`, which is recomputed live and can flip (flag toggled / no-paymaster /
  // non-a-priori sizing) between the fold burn and a later resume. A consumed nonce
  // on a FOLD burn proves the whole atomic deposit committed (never re-burn); on a
  // STANDALONE burn it means only the separate mint landed. Undefined on a legacy
  // cursor (predates the fold feature ⟹ standalone).
  fold?: boolean;
}

type InflightDepositMap = Record<string, InflightDeposit>;

function readInflightDepositMap(): InflightDepositMap {
  try {
    const raw = localStorage.getItem(INFLIGHT_DEPOSIT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as InflightDepositMap;
    return {};
  } catch {
    return {};
  }
}

// Validate a persisted cursor before trusting it (mirrors isValidInflightBurn): a
// corrupt/partial record (e.g. a half-written localStorage entry) would make the
// resume path poll a bad Iris URL or mint against a garbage recipient. A record
// is valid only if every field has the right shape — burnTx a 0x-hex string,
// snRecipient a 0x-hex felt, amountWei a positive-integer string, and the two
// domain/chain ids finite numbers.
// Back-compat: a legacy native cursor may carry an extra `path: 'native'` field
// (from before deposit-in became native-only) — an unknown extra field is ignored
// rather than rejected, so an existing persisted native cursor still reads back.
const HEX_RE = /^0x[0-9a-fA-F]+$/;
function isValidInflightDeposit(value: unknown): value is InflightDeposit {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  const commonOk =
    typeof r.sourceDomain === 'number' &&
    Number.isFinite(r.sourceDomain) &&
    typeof r.amountWei === 'string' &&
    /^[0-9]+$/.test(r.amountWei) &&
    typeof r.snRecipient === 'string' &&
    HEX_RE.test(r.snRecipient) &&
    typeof r.evmChainId === 'number' &&
    Number.isFinite(r.evmChainId) &&
    // #229: optional (legacy cursors predate it) but must be a clean decimal
    // string when present — a corrupt/tampered value must not BigInt()-throw
    // on resume.
    (r.maxFee === undefined || (typeof r.maxFee === 'string' && /^[0-9]+$/.test(r.maxFee))) &&
    // Optional (legacy cursors predate the fold feature) but must be a real boolean
    // when present — a corrupt value must not be read as a truthy/falsy fold marker.
    (r.fold === undefined || typeof r.fold === 'boolean');
  if (!commonOk) return false;
  // A 0x-hex burn tx hash (deposit-in is native-gas only).
  return typeof r.burnTx === 'string' && HEX_RE.test(r.burnTx);
}

function clearInflightDeposit(evmAddress: string): void {
  try {
    const map = readInflightDepositMap();
    delete map[evmAddress.toLowerCase()];
    localStorage.setItem(INFLIGHT_DEPOSIT_KEY, JSON.stringify(map));
  } catch {
    // ignore.
  }
}

// Read the cursor for a funder, dropping (and clearing) a corrupt record so the
// caller treats it as a FRESH deposit rather than resuming off garbage. The
// funds, if any, are recoverable from the signature-derived account; a corrupt
// cursor can't be safely resumed.
function readInflightDeposit(evmAddress: string): InflightDeposit | null {
  const record = readInflightDepositMap()[evmAddress.toLowerCase()] ?? null;
  if (record === null) return null;
  if (!isValidInflightDeposit(record)) {
    clearInflightDeposit(evmAddress);
    return null;
  }
  return record;
}

// FUND-SAFETY (MEDIUM-1): a persisted burn-but-not-yet-minted deposit cursor is
// an IN-FLIGHT CCTP transfer that survives a reload — the burn is committed but
// the mint hasn't landed. The UI reads this on mount / funder change to keep the
// network switch BLOCKED (a switch mid-transfer would resume the mint against the
// WRONG-network transmitter/domain and misroute funds). Returns true iff a VALID
// (resumable, non-corrupt) cursor exists for the funder — a corrupt record is
// cleared and treated as no in-flight transfer (the funds, if any, are recoverable
// from the derived account, not resumable off garbage). Cheap synchronous
// localStorage read; safe to call from an effect.
export function hasInflightDeposit(evmAddress: string): boolean {
  if (!evmAddress) return false;
  return readInflightDeposit(evmAddress) !== null;
}

// Normalized read of the in-flight CCTP deposit-in cursor for the unified
// getBridgeTransferStatus reader. Returns the NET already committed (what CCTP minted
// = gross − the fee ACTUALLY burned with; a legacy cursor with no persisted maxFee
// reports the gross, the pre-#229 fallback) plus the SN recipient the mint targets,
// or null when there is no resumable cursor. Reuses the same validated reader the
// resume path trusts (corrupt-drop, best-effort — never throws).
export function peekInflightDeposit(
  evmAddress: string | null | undefined,
): { netWei: bigint; snRecipient: string } | null {
  if (!evmAddress) return null;
  const record = readInflightDeposit(evmAddress);
  if (!record) return null;
  const gross = BigInt(record.amountWei);
  const fee = record.maxFee !== undefined ? BigInt(record.maxFee) : 0n;
  const netWei = gross > fee ? gross - fee : gross;
  return { netWei, snRecipient: record.snRecipient };
}

// FUND-SAFETY (Bugbot HIGH — "Deposit cursor switch gap"): the per-funder
// hasInflightDeposit above needs the connected funder's address. But the network
// toggle lives in the always-present NavBar and can be clicked while SIGNED OUT
// (no funder known) — and the MEDIUM-1 mount-time guard only runs while
// MoveIntoPool is MOUNTED. So a persisted burn-but-not-minted cursor could exist
// for SOME funder while the app reports "no funder" → the toggle stays enabled →
// the network-switch disconnect() wipes the resume cursor mid-CCTP-transfer
// (stranded funds). This funder-AGNOSTIC reader scans the whole per-funder cursor
// map and returns true iff ANY funder has a VALID (resumable, non-corrupt) cursor,
// so NetworkContext can block the switch independent of mount state or connection.
// Cheap synchronous localStorage read; safe to call from render.
export function hasAnyInflightDeposit(): boolean {
  const map = readInflightDepositMap();
  return Object.values(map).some((record) => isValidInflightDeposit(record));
}

// Shared prefix for every in-flight resumable transfer cursor. Each such cursor is
// a `pmp.inflight<Kind>` localStorage key holding a per-EVM-address map
// { [addr]: record }. Keep this the single source of truth for the naming
// convention the generic guard scans (mirrored by device-store's PMP_STORAGE_KEYS).
export const INFLIGHT_CURSOR_KEY_PREFIX = 'pmp.inflight';

// A per-address cursor map value is RESUMABLE (must block the switch) iff it parses
// to an object with at least one entry that is itself a non-empty plain object — a
// persisted record with fields to resume from. Empty maps, non-objects, and
// records with no fields are NOT resumable. Corrupt/unparseable JSON is caught by
// the caller and treated as non-blocking (nothing to resume off garbage). This is
// the GENERIC fallback for any cursor kind we don't have a strict per-type
// validator for (e.g. a future pmp.inflightXyz) — deliberately permissive on the
// record's INNER shape so a new cursor type is covered automatically, but still
// refuses to block on garbage/empty.
function hasResumableRecordGeneric(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false; // corrupt/unparseable → not resumable, don't block.
  }
  if (!parsed || typeof parsed !== 'object') return false;
  return Object.values(parsed as Record<string, unknown>).some(
    (rec) =>
      !!rec &&
      typeof rec === 'object' &&
      !Array.isArray(rec) &&
      Object.keys(rec as Record<string, unknown>).length > 0,
  );
}

// FUND-SAFETY (Bugbot — "Switch guard skips burn cursors" → "Cash-out cursor skips
// switch guard"): the funder-AGNOSTIC, cursor-COMPLETE guard the network switch
// must consult. A switch disconnect()s and wipes ALL pmp.* state
// (clearDeviceIdentity), so it strands ANY unresolved resumable transfer.
//
// This is GENERIC on purpose (stop the whack-a-mole): an ENUMERATED OR of the
// then-known readers re-opened the bug every time a new cursor type was added
// (deposit-in, then burn, then return, then cash-out, …). Instead we SCAN
// localStorage for every `pmp.inflight*` key at runtime, so a future
// pmp.inflightXyz is covered automatically with no code change here.
//   - For the strictly-known cursor kinds we still delegate to their exact per-type
//     validators (hasAnyInflightDeposit / hasAnyInflightBurn / hasAnyInflightReturn)
//     so their precise corrupt-record semantics are unchanged.
//   - For any OTHER pmp.inflight* key (incl. pmp.inflightCashOut and anything added
//     later) we apply the generic resumable-record predicate. Corrupt/empty cursors
//     do NOT block (nothing to resume off garbage), consistent with the per-type
//     readers.
// Cheap synchronous localStorage reads; safe to call from render / a switch guard.
export function hasAnyInflightTransfer(): boolean {
  // Strict, known kinds first (unchanged semantics).
  // hasAnyPendingReturnBurn covers the submitted-but-unconfirmed return burn, whose store
  // is NOT named pmp.inflight* — so neither the strict readers nor the generic scan below
  // would otherwise see it, and a switch could wipe the only handle on a live burn.
  if (
    hasAnyInflightDeposit() ||
    hasAnyInflightBurn() ||
    hasAnyInflightReturn() ||
    hasAnyPendingReturnBurn()
  ) {
    return true;
  }

  // Generic scan for ANY other inflight cursor key (forward-compat). The three
  // strictly-validated kinds are already handled above; skip them here so their
  // precise corrupt-record semantics aren't double-counted by the permissive
  // generic predicate.
  const KNOWN = new Set([INFLIGHT_DEPOSIT_KEY, 'pmp.inflightBurn', 'pmp.inflightReturn']);
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(INFLIGHT_CURSOR_KEY_PREFIX) || KNOWN.has(key)) continue;
      const raw = localStorage.getItem(key);
      if (raw && hasResumableRecordGeneric(raw)) return true;
    }
  } catch {
    // localStorage unavailable (private mode/quota) → no persisted cursor to strand.
  }
  return false;
}

// Best-effort cursor write that REPORTS whether it actually landed (mirrors
// writeInflightBurnVerified). Used AFTER the burn — the burn already committed
// the funds to CCTP, so we never throw here; the caller surfaces a "don't
// reload" warning when the read-back shows the cursor didn't persist.
function writeInflightDepositVerified(evmAddress: string, record: InflightDeposit): boolean {
  try {
    const map = readInflightDepositMap();
    map[evmAddress.toLowerCase()] = record;
    localStorage.setItem(INFLIGHT_DEPOSIT_KEY, JSON.stringify(map));
  } catch {
    // fall through to the read-back, which reports the miss.
  }
  const persisted = readInflightDepositMap()[evmAddress.toLowerCase()];
  if (!persisted) return false;
  return persisted.burnTx === record.burnTx;
}

// PRE-FLIGHT (Bundle A2), FRESH-burn path only: prove localStorage accepts a
// write + read-back BEFORE we burn. If it can't (private-browsing, disabled
// storage, quota), the resume cursor we'd write AFTER the burn would silently
// vanish — a reload then couldn't resume and the user could re-burn
// (double-spend). Throw a TERMINAL error so we NEVER burn when we can't persist
// the cursor. (Do NOT call on the resume path: it has already burned, so
// refusing to resume would strand funds.)
const STORAGE_PROBE_KEY = 'pmp.depositStorageProbe';

// Authoritative consumed-state for a CCTP message on the SN MessageTransmitterV2:
// once receive_message lands, is_nonce_used(nonce) = 1 forever (monotonic), so a
// `1` read proves the mint already happened; a read FAILURE proves nothing.
// EXPORTED so returnIn.ts can use the same monotonic gate on RESUME (bug-hunt E1).
export async function isCctpMessageNonceUsed(message: `0x${string}`): Promise<boolean> {
  const nonce = BigInt(extractCctpNonce(message)); // bytes 12..44, big-endian u256
  const result = await getRpcProvider().callContract(
    {
      contractAddress: config.cctp.snMessageTransmitter,
      entrypoint: 'is_nonce_used',
      calldata: [
        `0x${(nonce & ((1n << 128n) - 1n)).toString(16)}`, // u256.low first
        `0x${(nonce >> 128n).toString(16)}`, // u256.high second
      ],
    },
    READ_BLOCK,
  );
  const [used] = result;
  if (used === undefined) {
    throw new Error('isCctpMessageNonceUsed: unexpected is_nonce_used result shape');
  }
  return BigInt(used) === 1n;
}

// True when `err` is the SN MessageTransmitterV2's "Nonce already used" revert — the CCTP
// message nonce was already consumed by a prior receive_message. On the atomic fold path
// (receive_message folded INTO the pool deposit) a consumed nonce ⟺ the whole
// mint → approve → pool pull → apply_action tx already committed (they succeed or revert
// together), so this revert is DEFINITIVE proof the deposit landed. It surfaces as an AVNU
// code-156 `argent/multicall-failed, Nonce already used, ENTRYPOINT_FAILED`. Exported for
// the fold-resume convergence in moveIntoPool, which closes the accepted≠reflected window
// the pre-submit is_nonce_used probe can't (issue #432): a quick retry can re-fold before a
// prior fold reflects, and this revert is the authoritative backstop. Match is deliberately
// narrow — the CALLER additionally gates on a folded receive_message being present, so it
// can never collide with a Starknet account-nonce error (which is worded differently).
export function isNonceAlreadyUsedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /nonce already used/i.test(message);
}

// Resolves the CCTP source to use for the burn.
//
// When `preferredChainId` is set, it is an EXPLICIT user pick: it must map to a
// known EvmCctpSource, in which case MetaMask is switched to that chain and it is
// returned. If it is NOT in the registry we THROW — silently auto-detecting would
// burn on the wallet's CURRENT chain (chain Y) when the user explicitly chose
// chain X, violating their intent (MED #1).
//
// Auto-detect (use the chain MetaMask is already on if supported, else switch to
// the configured default) runs ONLY when no preference was given.
async function resolveSource(
  provider: EthereumProvider,
  onStatus?: (s: string) => void,
  preferredChainId?: number,
): Promise<EvmCctpSource> {
  // Picker-driven: the user explicitly chose a chain.
  if (preferredChainId !== undefined) {
    const preferred = getEvmCctpSource(preferredChainId);
    if (!preferred) {
      throw new Error(
        `Selected source chain ${preferredChainId} is not a supported CCTP source ` +
          `(not in EVM_CCTP_SOURCES) — pick a supported chain.`,
      );
    }
    onStatus?.(`Switching MetaMask to ${preferred.chainName}…`);
    await switchChain(provider, preferred.chainId, {
      chainId: preferred.chainId,
      chainName: preferred.chainName,
      rpcUrls: [preferred.rpcUrl],
      nativeCurrency: preferred.nativeCurrency,
      blockExplorerUrls: preferred.blockExplorerUrls,
    });
    return preferred;
  }

  // Auto-detect: use MetaMask's current chain if supported, else switch to default.
  const currentChainId = Number((await provider.request({ method: 'eth_chainId' })) as string);
  const current = getEvmCctpSource(currentChainId);
  if (current) return current;

  const fallback = getEvmCctpSource(config.cctp.defaultEvmSourceChainId);
  if (!fallback) {
    throw new Error(
      `No CCTP source configured for chain ${currentChainId}, and the default source ` +
        `${config.cctp.defaultEvmSourceChainId} is not in EVM_CCTP_SOURCES.`,
    );
  }
  onStatus?.(`Switching MetaMask to ${fallback.chainName}…`);
  await switchChain(provider, fallback.chainId, {
    chainId: fallback.chainId,
    chainName: fallback.chainName,
    rpcUrls: [fallback.rpcUrl],
    nativeCurrency: fallback.nativeCurrency,
    blockExplorerUrls: fallback.blockExplorerUrls,
  });
  return fallback;
}

// Read-only: determine the EVM CCTP source domain from the wallet's current chain
// (or an explicit `preferredChainId`) WITHOUT switching chains. Used to quote the
// forwarding fee for the correct EVM→Starknet route BEFORE the chain-switch that
// resolveSource performs on the fresh path. Returns null if the provider is
// unavailable or errors — the caller then falls back to the default fee route, and
// the fresh-path burn surfaces any real provider error before anything is submitted.
// Mirrors resolveSource's chain resolution (preferred → current → default) minus the
// switchChain side effect, so the peeked domain matches the domain the burn uses.
async function peekEvmSourceDomain(
  provider: EthereumProvider,
  preferredChainId?: number,
): Promise<number | null> {
  try {
    const chainId =
      preferredChainId ?? Number((await provider.request({ method: 'eth_chainId' })) as string);
    const src = getEvmCctpSource(chainId) ?? getEvmCctpSource(config.cctp.defaultEvmSourceChainId);
    return src?.domain ?? null;
  } catch {
    return null;
  }
}

export interface FundFromMetaMaskArgs {
  // The connected MetaMask account that burns USDC + pays the EVM gas.
  evmAddress: string;
  // The derived Starknet account that receives the minted USDC (the deposit source).
  snRecipient: string;
  // The recipient's derived account (paymaster-enabled via makeAccount). When present
  // with a configured paymaster, the Starknet mint (receive_message) is submitted
  // GASLESS via AVNU's sponsored relayer instead of the manager — required in PROD
  // where no manager exists. Omit → manager-paid (testnet/dev).
  account?: Account;
  // USDC base units (6 dp) to bridge in. Must be > 0.
  amountWei: bigint;
  // The connected wallet's EIP-1193 provider (WalletConnect). REQUIRED — there is
  // no window.ethereum fallback; the caller passes useWallet().getProvider().
  provider: EthereumProvider;
  // CCTP Fast Transfer (soft-finality 1000, attests in ~seconds for a small
  // forwarding fee) vs Standard (2000, free, minutes). Defaults to config.cctp.fast
  // — mirrors the fund/return legs. When fast, the
  // forwarding max_fee is QUOTED here (fetchForwardMaxFee) unless `maxFee` is set
  // explicitly. Explicit `minFinalityThreshold`/`maxFee` always override `fast`.
  fast?: boolean;
  // CCTP finality: 2000 = Standard (default), 1000 = Fast. Overrides `fast`.
  minFinalityThreshold?: number;
  // Per-call CCTP fee cap (0 for Standard). Overrides the `fast` quote.
  maxFee?: bigint;
  onStatus?: (s: string) => void;
  // Optional EIP-155 chain id of the user-selected source chain. When set and
  // present in EVM_CCTP_SOURCES, MetaMask is switched to it before the burn.
  // Omitting preserves the existing auto-detect + default-fallback behavior.
  sourceChainId?: number;
  // CONTINUE ONLY (unattended watcher / Continue button): finish an already-burned
  // deposit, never start one. With nothing to resume this throws NOTHING_TO_RESUME
  // instead of falling through to a fresh approve + depositForBurn.
  resumeOnly?: boolean;
  // PART B (single-tx deposit-in fold): when true, the Starknet CCTP mint
  // (receive_message) is NOT submitted as its own tx here — instead the attested
  // {message, attestation} are handed back via onMintFold so the caller folds
  // receive_message into the pool deposit's atomic paymaster multicall (mint →
  // approve → pool pull → deposit, ONE tx). Only meaningful on the paymaster path with
  // an a-priori amount. When the mint has ALREADY landed (resume/already-minted) there
  // is nothing to fold, onMintFold does NOT fire, and the caller deposits the funds
  // already on the account. The returned net is unchanged (the value that WILL mint
  // inside the deposit tx).
  deferMint?: boolean;
  // Fired (deferMint only) with the attested bytes to fold, plus `clearMintCursor` —
  // the caller invokes it AFTER the folded deposit tx commits (the mint lands inside
  // that tx) so the in-flight burn cursor clears only once the value has moved. On an
  // atomic revert nothing moved and the cursor is preserved for a clean re-run.
  onMintFold?: (fold: {
    message: `0x${string}`;
    attestation: `0x${string}`;
    clearMintCursor: () => void;
  }) => void;
  // FIX 1: fired on RESUME when the CCTP nonce is already consumed on the SN
  // MessageTransmitterV2. When this fires, fundFromMetaMask does NOT re-burn and returns
  // the already-landed net; the caller converges on completion (balance cross-check)
  // instead of re-folding the spent nonce (which would revert "Nonce already used" every
  // retry). Fires for a fold burn, or for ANY burn under resumeOnly; a standalone burn
  // without resumeOnly keeps the historical fresh-re-burn behavior.
  // `foldBurn` reports the shape of the burn being resumed (from the cursor): a fold
  // deposit is atomic, so a swept balance proves completion in one read; a standalone
  // mint can leave the funds resting on the account, which the caller must confirm.
  onMintAlreadyConsumed?: (info: { foldBurn: boolean }) => void;
  // Fired when the source-chain CCTP burn is confirmed — on a FRESH burn (path 3) or when a
  // prior run's burn is RESUMED from the cursor (path 2) — with the burn tx hash + a
  // source-chain block-explorer URL for it (when the source config carries one). Lets the
  // caller surface the EVM-side leg on its deposit receipt: the Starknet mint/deposit tx alone
  // omits where the funds were burned. Non-secret (public on-chain) and purely informational —
  // it NEVER fires on the already-funded no-op (nothing burned this op). This is PER-INVOCATION:
  // a caller that RETRIES fundFromMetaMask after a fresh burn (e.g. a transient attest/mint
  // failure) sees it fire AGAIN for the SAME hash on the resume, so callers that retry must
  // de-dupe by burnTxHash — moveIntoPool does, making its own onBurned strictly once-per-burn.
  onBurned?: (info: { burnTxHash: string; explorerUrl?: string }) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Outcome of polling an EIP-5792 call bundle to a terminal status or the budget deadline.
type BatchStatusResult =
  | { kind: 'success'; receipts: Awaited<ReturnType<typeof getCallsStatus>>['receipts'] }
  | { kind: 'failure'; statusCode: string }
  // Wallet stopped answering wallet_getCallsStatus, but the CCTP burn event was found
  // on chain for this funder+recipient+amount — the bundle DID broadcast. Same downstream
  // path as 'success', keyed off the on-chain tx hash from the log.
  | { kind: 'scan-success'; burnTx: `0x${string}` }
  // Deadline reached while the bundle was ACKNOWLEDGED (a real status was seen) but never
  // settled. The batch may be in-flight, so the caller must NOT re-burn.
  | { kind: 'in-flight' }
  // Deadline reached with the wallet reporting UnknownBundleIdError (5730) the whole time.
  // By EIP-5792 the bundle was never submitted; the caller may fall back — after an on-chain
  // balance check rules out the pathological "executed then forgot the id" case.
  | { kind: 'never-acknowledged' };

// True iff `error` is (or wraps) viem's EIP-5792 UnknownBundleIdError — RPC code 5730,
// "this bundle id is unknown / has not been submitted".
function isUnknownBundleIdError(error: unknown): boolean {
  if (error instanceof UnknownBundleIdError) return true;
  // viem sometimes wraps the RPC error; walk the BaseError cause chain for code 5730.
  if (error instanceof BaseError) {
    return Boolean(error.walk((e) => (e as { code?: number }).code === UnknownBundleIdError.code));
  }
  return false;
}

// Options for the interleaved on-chain scan. Second signal alongside
// wallet_getCallsStatus: if the wallet stops answering (5730 forever) but the CCTP
// DepositForBurn event with (depositor, mintRecipient, amount, destinationDomain)
// matching this submission is visible on chain, the bundle DID broadcast — resolve
// with the tx hash and let the caller take the same downstream path as 'success'.
// A same-block landing is covered by snapshotting fromBlock BEFORE sendCalls.
interface BurnScanOptions {
  publicClient: ReturnType<typeof createPublicClient>;
  tokenMessenger: `0x${string}`;
  burnToken: `0x${string}`;
  depositor: `0x${string}`;
  mintRecipient: `0x${string}`;
  amountWei: bigint;
  destinationDomain: number;
  fromBlock: bigint;
}

// Poll wallet_getCallsStatus until the bundle settles (success/failure) or `timeoutMs`
// elapses, absorbing a transient UnknownBundleIdError as not-ready-yet (see
// BATCH_CALLS_TIMEOUT_MS for why viem's waitForCallsStatus can't be used here). A non-5730
// error propagates immediately.
//
// Interleaved second signal: on every poll, also scan the source chain for our own CCTP
// DepositForBurn event. A match unambiguously identifies THIS submission's burn (the RPC
// filter is scoped to our TokenMessenger + depositor; the code-side match locks it to our
// mintRecipient + amount + destinationDomain). If the wallet is stuck returning 5730 for a
// bundle it actually broadcast, this breaks the 180s wait as soon as the burn is on chain.
// A getLogs failure is swallowed (non-fatal) so a scan-RPC hiccup can't abort a still-
// progressing wallet_getCallsStatus poll.
async function waitForBatchStatus(
  walletClient: Parameters<typeof getCallsStatus>[0],
  {
    id,
    timeoutMs,
    pollIntervalMs,
    scan,
  }: {
    id: string;
    timeoutMs: number;
    pollIntervalMs: number;
    scan: BurnScanOptions;
  },
): Promise<BatchStatusResult> {
  const deadline = Date.now() + timeoutMs;
  let acknowledged = false;
  const wantMintRecipient = scan.mintRecipient.toLowerCase();
  for (;;) {
    try {
      const result = await getCallsStatus(walletClient, { id });
      acknowledged = true;
      if (result.status === 'success') return { kind: 'success', receipts: result.receipts };
      if (result.status === 'failure') return { kind: 'failure', statusCode: String(result.statusCode) };
      // 'pending' (or an unrecognized status) → keep polling until the deadline.
    } catch (error) {
      if (!isUnknownBundleIdError(error)) throw error;
      // 5730: the wallet doesn't (yet) know this bundle id — not fatal; keep polling.
    }

    // Second signal: is the burn already visible on chain?
    try {
      const logs = await scan.publicClient.getLogs({
        address: scan.tokenMessenger,
        event: TOKEN_MESSENGER_EVENT_ABI[0],
        args: { depositor: scan.depositor },
        fromBlock: scan.fromBlock,
        toBlock: 'latest',
      });
      const match = logs.find(
        (log) =>
          log.args.mintRecipient?.toLowerCase() === wantMintRecipient &&
          log.args.amount === scan.amountWei &&
          Number(log.args.destinationDomain) === scan.destinationDomain &&
          log.args.burnToken?.toLowerCase() === scan.burnToken.toLowerCase() &&
          log.transactionHash !== null,
      );
      if (match?.transactionHash) {
        return { kind: 'scan-success', burnTx: match.transactionHash };
      }
    } catch {
      // Scan-RPC hiccup — keep polling; the batch may still settle via getCallsStatus
      // or a later scan iteration.
    }

    if (Date.now() >= deadline) {
      return acknowledged ? { kind: 'in-flight' } : { kind: 'never-acknowledged' };
    }
    await sleep(pollIntervalMs);
  }
}

// Bridges `amountWei` of USDC from the user's MetaMask into the derived Starknet
// account via CCTP. Idempotent + resumable (Fix 1 / Bundle A2):
//   1. if the SN account already holds the NET (a prior fund-in's mint landed)
//      → no-op, so a resumed make-private doesn't double-bridge;
//   2. else if a valid inflight cursor exists for THIS funder (a prior run burned
//      but didn't finish) → RESUME from attest off the persisted burn tx, never
//      re-running approve+burn (which would DOUBLE-BURN the user's USDC);
//   3. else the FRESH path: pre-flight storage, approve, burn, PERSIST the cursor
//      (with the burn tx hash) BEFORE attest, attest, mint, then clear the cursor.
//
// VALUE PATH: the burn is for the GROSS `amountWei` (what the user spends), but CCTP
// mints `amountWei − maxFee` on Starknet (the Forwarding Service deducts its fee from
// the burned amount). So under Fast (maxFee > 0) the SN account NETS less than the
// gross — the no-op/resume balance threshold keys on the NET, and the NET is RETURNED
// so the caller deposits exactly what landed (never the gross). Standard → maxFee 0 →
// net == gross (unchanged). Returns the net minted amount (USDC base units).
export async function fundFromMetaMask(args: FundFromMetaMaskArgs): Promise<bigint> {
  const { evmAddress, snRecipient, account: snAccount, amountWei, onStatus } = args;
  if (amountWei <= 0n) {
    throw new Error('fundFromMetaMask: amount must be greater than zero.');
  }

  // Finality + max_fee. Explicit args win (back-compat / tests); otherwise derive
  // from `fast` (defaults to config.cctp.fast). Fast quotes the forwarding max_fee
  // for the burn amount and floor-checks it — same mechanics as the fund/return legs.
  // Standard is free (maxFee 0, finality 2000).
  const fast = args.fast ?? config.cctp.fast;
  let minFinalityThreshold = args.minFinalityThreshold;
  let maxFee = args.maxFee;
  let feeQuote: import('./cctpFees').ForwardFeeQuote | undefined;
  if (maxFee === undefined && fast) {
    // Deposit-in ALWAYS burns EVM → Starknet and mints on Starknet, which is NOT a
    // Forwarding-Service destination (Circle 400s on ?forward=true into domain 25).
    // fetchForwardMaxFee derives forwarding=false from destDomain=starknetDomain and
    // charges ONLY the CCTP protocol-fee bps (no Forwarding fee). Peek the wallet's
    // current chain id (read-only, no switch) for the SOURCE; fall back to the
    // default EVM source domain if the provider is unavailable so the fee route is
    // never the nonsensical Starknet→Starknet. The fresh-path burn surfaces any real
    // provider error before anything is submitted.
    const evmSrcDomain =
      (await peekEvmSourceDomain(args.provider, args.sourceChainId)) ??
      getEvmCctpSource(config.cctp.defaultEvmSourceChainId)?.domain;
    feeQuote = await fetchForwardMaxFee(amountWei, {
      fast: true,
      sourceDomain: evmSrcDomain,
      destDomain: config.cctp.starknetDomain,
    });
    maxFee = feeQuote.maxFee;
    minFinalityThreshold ??= FAST_FINALITY_THRESHOLD;
  }
  minFinalityThreshold ??= fast ? FAST_FINALITY_THRESHOLD : STANDARD_FINALITY;
  maxFee ??= 0n;

  // The Anonymizer/CCTP reverts opaquely if amount <= max_fee (recipient gets 0);
  // reject below-floor here with an actionable error (mirrors the fund-account leg).
  // A1 fix: guard runs UNIVERSALLY — for auto-quote (feeQuote defined) and for an
  // explicit-`args.maxFee` caller (synthesized quote). Previously nested inside the
  // auto-quote branch, letting an explicit `maxFee >= amountWei` reach line ~654
  // with a non-positive netMintedWei that then trivially passed the balance no-op.
  assertAboveForwardFloor(
    amountWei,
    feeQuote ?? {
      maxFee,
      forwardFee: 0n,
      protocolFee: maxFee,
      finalityThreshold: minFinalityThreshold,
    },
  );

  // The NET that CCTP mints on Starknet = burned amount − the forwarding max_fee.
  // This is the resume/no-op threshold AND the value the caller deposits.
  const netMintedWei = amountWei - maxFee;
  // Defense in depth: if netMintedWei is non-positive we must NOT proceed — the
  // resume-no-op gate below (`balance >= netMintedWei`) is trivially satisfied by
  // any 0n balance when netMintedWei is 0n or negative, silently short-circuiting
  // as "already funded" without a burn. assertAboveForwardFloor above owns the
  // human-readable error, but this guard catches the arithmetic invariant even
  // if a future refactor mis-composes the fee shape.
  if (netMintedWei <= 0n) {
    throw new Error(
      `fundFromMetaMask: amount ${amountWei} is below the CCTP fee floor (maxFee ${maxFee}); net would be non-positive.`,
    );
  }

  const snProvider = getRpcProvider();

  // Attest → validate → mint, then clear the cursor. Shared by the resume + fresh
  // paths so both behave identically. The cursor is CONSERVATIVELY preserved on
  // any non-success EXCEPT a DEMONSTRABLY-TERMINAL one — exactly mirroring the
  // fund-account leg's clear-on-terminal intent ("never silently strand a
  // recoverable account funding"). Only an Iris "attestation failed"/"rejected" status or a
  // CCTP "recipient/domain mismatch" proves the message will never mint to us, so
  // resume can't help → clear. Everything else (slow Iris, a one-off Starknet RPC
  // error, any unclassified throw) PRESERVES the cursor: the burn is replayable
  // until MINTED — a consumed nonce is detected and cleared on resume (below), so
  // the next run can still make progress. (Re-burning is impossible here
  // regardless — this runs only after the burn already landed.)
  // The ACTUAL amount CCTP minted on the SN account (burn − feeExecuted), decoded from
  // the attested message once it resolves — authoritative even when the pre-submit
  // `maxFee` estimate ≠ the fee actually deducted (mainnet Fast fee, or a
  // Fast-requested/Standard-executed tier mismatch). This is the value the caller must
  // deposit (approve + pool pull), so the RETURN below prefers it over the maxFee-based
  // netMintedWei/landedNetWei. Undefined until the attestation is read, or when the
  // message is a truncated/legacy blob with no fee field (falls back to the estimate).
  let mintedFromMessageWei: bigint | undefined;

  const finishAttestAndMint = async (
    burnTx: string,
    sourceDomain: number,
    recipient: string,
    opts?: { detectAlreadyMinted?: boolean; foldBurn?: boolean; resumeOnly?: boolean },
  ): Promise<'minted' | 'already-minted' | 'already-deposited' | 'deferred'> => {
    try {
      const { message, attestation } = await waitForAttestation(burnTx, {
        sourceDomain,
        onStatus,
      });
      // Size the deposit to what CCTP will ACTUALLY mint (burn − feeExecuted from the
      // attested body), NOT the pre-submit maxFee estimate — on the atomic fold path the
      // mint rides inside the deposit tx, so an over-stated approve/pull reverts (#Bug1).
      const decodedMinted = decodeCctpMintedAmount(message);
      if (decodedMinted !== null) mintedFromMessageWei = decodedMinted;
      // Resume-only: the transmitter may have already consumed this message in a
      // prior run. The balance no-op gate (1) can't see it — depositToPool swept
      // the derived account after that prior run, so the balance is back to zero —
      // but is_nonce_used is monotonic once receive_message lands, so a `true`
      // read PROVES the mint already happened. The cursor is provably dead: clear
      // it, then either converge (below) or — a standalone burn with no resumeOnly —
      // fall through to a FRESH burn for the CURRENT amount.
      if (opts?.detectAlreadyMinted && (await isCctpMessageNonceUsed(message))) {
        clearInflightDeposit(evmAddress);
        // FIX 1 — FOLD path (deferMint): the mint rides INSIDE the atomic deposit tx, so a
        // consumed CCTP nonce proves the WHOLE deposit (receive_message → approve → pool
        // pull → apply_action) already committed — they succeed or revert together, and
        // the nonce is marked used ONLY if receive_message succeeded. Re-folding would
        // re-submit receive_message with the spent nonce → the atomic multicall reverts
        // ("Nonce already used") on every retry (the live-observed stuck resume). So do
        // NOT fall through to a fresh re-burn (the standalone 'already-minted' behavior,
        // where a consumed nonce means only the separate mint landed and the funds still
        // sit on the account); instead signal the caller to converge on completion via a
        // balance cross-check.
        //
        // Classify off how the BURN WAS STARTED (`opts.foldBurn`, persisted on the cursor
        // at burn time), NOT the live `args.deferMint`. `deferMint`/`foldEligible` are
        // recomputed every run (#305), so they can FLIP between the fold burn and this
        // resume (flag toggled off, no paymaster, non–a-priori sizing). A fold burn read
        // as standalone here would clear the cursor and fall through to a FRESH re-burn of
        // value that ALREADY reached the pool — a double-spend (Bugbot HIGH). A legacy
        // cursor has no `fold` field ⟹ standalone (it predates the fold feature), which is
        // the correct historical classification.
        //
        // Resume-only converges too, on EITHER burn shape: it may never start a fresh
        // burn, and a standalone mint can leave funds resting on the account, so the
        // caller finishes with a deposit-only of whatever settled.
        if (opts?.foldBurn || opts?.resumeOnly) {
          if (!opts.foldBurn) onStatus?.('Prior deposit already minted — finishing it.');
          args.onMintAlreadyConsumed?.({ foldBurn: opts.foldBurn === true });
          return 'already-deposited';
        }
        return 'already-minted';
      }
      // PART B FOLD: hand the attested bytes to the caller instead of submitting the
      // mint here. The mint (receive_message) now runs INSIDE the atomic deposit tx,
      // so we must NOT clear the in-flight burn cursor yet — the funds have not moved
      // until that tx commits. The caller invokes clearMintCursor after the deposit
      // lands; on an atomic revert the cursor is preserved and a re-run re-folds
      // (is_nonce_used stays false on the un-consumed message). No fold on resume once
      // the mint already landed — that hits the detectAlreadyMinted branch above.
      if (args.deferMint) {
        // FUND-SAFETY (Fix 2 symmetry): the standalone submitStarknetMint validates the
        // attested message BEFORE building receive_message (snMint.ts). The fold path
        // SKIPS submitStarknetMint — the mint rides inside the caller's deposit tx — so
        // run the SAME gate HERE before handing the bytes over; otherwise a tampered /
        // MITM'd Iris attestation (Iris is a TRUSTED oblivious service, docs/threat-model.md)
        // would be folded in UNCHECKED (redirected mint recipient / wrong destination
        // domain). Same params + same TERMINAL "recipient/domain mismatch" throw
        // (classified non-transient, cleared as terminal, never resume-looped) as the
        // standalone mint, so both paths share ONE validation contract.
        assertCctpMessageMatches(message, {
          expectedSourceDomain: sourceDomain,
          expectedDestinationDomain: config.cctp.starknetDomain,
          expectedRecipient: snAddressToBytes32(recipient),
        });
        args.onMintFold?.({
          message,
          attestation,
          clearMintCursor: () => clearInflightDeposit(evmAddress),
        });
        onStatus?.('USDC ready — the mint is folded into the pool deposit.');
        return 'deferred';
      }
      await submitStarknetMint({
        provider: snProvider,
        account: snAccount,
        message,
        attestation,
        recipient,
        sourceDomain,
        onStatus,
      });
    } catch (err) {
      if (isTerminalAttestFailure(err)) {
        clearInflightDeposit(evmAddress);
      }
      // Fail-closed: an is_nonce_used RPC failure throws here too, but matches
      // neither TERMINAL regex above, so the cursor is PRESERVED and the error
      // rethrows — a read failure proves nothing, so it must never be treated as
      // already-minted (which would wrongly clear a still-live cursor).
      throw err;
    }
    clearInflightDeposit(evmAddress);
    onStatus?.('USDC bridged into the Starknet account.');
    return 'minted';
  };

  // Read the resume cursor up front: when a prior burn is in flight, the fee it
  // ACTUALLY used is persisted on the cursor, so the resume path (2) returns the net
  // CCTP truly minted (`inflight.amountWei − the ORIGINAL maxFee`), never a fresh
  // requote — #229: the live fee can drift between the original burn and this run. No
  // cursor (a fresh run) or a legacy cursor with no persisted maxFee falls back to the
  // top-of-function fresh quote (the pre-#229 behavior).
  const inflight = readInflightDeposit(evmAddress);
  const landedNetWei =
    inflight?.maxFee !== undefined
      ? BigInt(inflight.amountWei) - BigInt(inflight.maxFee)
      : netMintedWei;

  // (1) Resume no-op: the SN account already holds the NET for THIS request (mint
  // landed). The fee came out of the mint, so the account nets `amountWei − maxFee`,
  // NOT the gross — gating on the gross would never recognize a Fast deposit as funded
  // and re-burn. The threshold is the CURRENT request's net: the persisted-fee net
  // (#229's upward-drift dust fix) applies ONLY when the cursor is for THIS SAME gross
  // amount — a genuine resume of the same deposit. A cursor for a DIFFERENT amount is
  // stale for this request (the caller changed the amount), so gate on the fresh quote;
  // otherwise a smaller prior deposit's still-present landed balance would satisfy the
  // gate, return its smaller net and clear the cursor instead of resuming / burning for
  // the larger amount now requested.
  const alreadyFundedNetWei =
    inflight?.maxFee !== undefined && BigInt(inflight.amountWei) === amountWei
      ? landedNetWei
      : netMintedWei;
  onStatus?.('Checking Starknet USDC balance…');
  if ((await getDepositTokenBalance(snRecipient)) >= alreadyFundedNetWei) {
    onStatus?.('Starknet account already funded.');
    clearInflightDeposit(evmAddress); // tidy any stale cursor — the funds are here.
    return alreadyFundedNetWei;
  }

  // (2) RESUME PATH: a prior run already burned for this funder but didn't finish
  // attest/mint. Resume from attest off the persisted cursor — skip approve+burn
  // entirely (re-burning would double-spend the user's USDC). The burn tx, source
  // domain AND recipient come from the CURSOR (authoritative on resume): the
  // validation gate must check the recipient actually burned to, so a caller
  // passing a different `snRecipient` this run is intentionally ignored here.
  //
  // `detectAlreadyMinted: true` guards against a cursor whose message the SN
  // MessageTransmitter already consumed in a PRIOR resume — the balance no-op
  // gate (1) can't see it once the derived account has been swept (depositToPool),
  // so a naive resume would loop forever re-attesting a dead message. When that's
  // detected, the cursor is cleared and we fall through to a FRESH burn for the
  // CURRENT args (do not return here) — the resumed amount may be stale. An
  // is_nonce_used RPC failure is NOT a detection: it rethrows and preserves the
  // cursor (fail-closed), same as any other unclassified resume failure.
  if (inflight) {
    onStatus?.('Resuming an in-flight deposit (already burned)…');
    // Surface the (already-committed) burn from the cursor so the receipt links the
    // EVM leg even when this run only finishes attest/mint. The explorer is resolved
    // off the cursor's own source chain (authoritative on resume, like the burn tx).
    args.onBurned?.({
      burnTxHash: inflight.burnTx,
      explorerUrl: evmExplorerTxUrl(getEvmCctpSource(inflight.evmChainId), inflight.burnTx),
    });
    const result = await finishAttestAndMint(
      inflight.burnTx,
      inflight.sourceDomain,
      inflight.snRecipient,
      // foldBurn from the PERSISTED cursor (how the burn began), not live config —
      // a consumed nonce on a fold burn must converge, never re-burn (Bugbot HIGH).
      { detectAlreadyMinted: true, foldBurn: inflight.fold === true, resumeOnly: args.resumeOnly },
    );
    if (result === 'minted' || result === 'deferred' || result === 'already-deposited') {
      // #229: the mint already landed (or, on the PART B fold, WILL land inside the
      // deposit tx) `inflight.amountWei − (the ORIGINAL maxFee)` — the actually-landed
      // net computed above from the PERSISTED fee, never a fresh requote (a legacy
      // cursor with no persisted maxFee fell back to the top-of-function quote there).
      // 'deferred' returns the same net: the caller mints+deposits it atomically and
      // must NOT fall through to a FRESH burn (which would double-spend).
      //
      // FIX 1 'already-deposited' (fold path): a PRIOR atomic fold deposit already
      // committed (CCTP nonce consumed). Return the net that deposit moved and do NOT
      // re-burn — finishAttestAndMint fired onMintAlreadyConsumed, so the caller
      // (moveIntoPool) cross-checks the on-chain balance and converges on completion
      // (or a deposit-only of any residual), never a re-fold of the spent nonce.
      // Bug1: prefer the message-decoded actual minted (burn − feeExecuted) over the
      // maxFee-based landedNetWei so the deposit is sized to what truly minted.
      return mintedFromMessageWei ?? landedNetWei;
    }
    // 'already-minted' (non-fold): the dead cursor was cleared inside finishAttestAndMint.
    onStatus?.('Prior deposit already minted — starting a fresh deposit…');
  }

  // RESUME-ONLY STOP. Every EVM write and wallet prompt in this module lives past this
  // line (approve/depositForBurn, wallet_sendCalls, the resolveSource chain switch), so
  // one guard here makes "a continue can never start a burn" true by construction. A
  // caller that continues unattended must fail here instead of prompting the wallet.
  if (args.resumeOnly) {
    const err = new Error('There is no in-flight deposit to continue for this wallet.') as Error & {
      code: 'NOTHING_TO_RESUME';
    };
    err.code = 'NOTHING_TO_RESUME';
    throw markNonRetryable(err);
  }

  // (3) FRESH PATH.
  const ethProvider = args.provider;
  if (!ethProvider) {
    throw new Error('fundFromMetaMask: no wallet (EIP-1193 provider) was provided.');
  }
  const source = await resolveSource(ethProvider, onStatus, args.sourceChainId);

  const eip1193 = ethProvider as unknown as EIP1193Provider;
  const account = evmAddress as `0x${string}`;
  const sourceChain = defineChain({
    id: source.chainId,
    name: source.chainName,
    nativeCurrency: source.nativeCurrency,
    rpcUrls: { default: { http: [source.rpcUrl] } },
  });
  const walletClient = createWalletClient({ transport: custom(eip1193) });
  const publicClient = createPublicClient({ transport: http(source.rpcUrl) });

  // PREFLIGHT — six independent reads, issued CONCURRENTLY (they were serial once,
  // ~6 round trips of pure latency before the first wallet prompt). Their individual
  // error contracts are preserved by attaching each promise's own handler:
  //   - capabilities / fee estimate / approve estimate fail SOFT (two-tx fallback /
  //     gasPrice-only cap / flat gas envelope), exactly as their old try/catch did;
  //   - USDC balance, native balance, and gasPrice must succeed. These three are
  //     SETTLED (never reject in flight) and unwrapped below in the OLD SERIAL ORDER,
  //     so which error the user sees stays deterministic under a compound failure —
  //     with a raw Promise.all the first rejection IN TIME would win, letting a flaky
  //     gas read's raw RPC error displace the actionable low-USDC message.
  //
  // Capabilities probe: EIP-5792 atomic-batch support (also gates the native-gas
  // check below). Only batch when the wallet reports atomic support (or is
  // upgrade-ready via 7702). A wallet without wallet_getCapabilities — or a transport
  // that rejects it (e.g. a WalletConnect session that didn't negotiate the 5792
  // methods) — falls to the two-transaction path.
  const settleRead = <T>(
    read: Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; reason: unknown }> =>
    read.then(
      (value) => ({ ok: true as const, value }),
      (reason) => ({ ok: false as const, reason }),
    );
  const unwrapRead = <T>(settled: { ok: true; value: T } | { ok: false; reason: unknown }): T => {
    if (!settled.ok) throw settled.reason;
    return settled.value;
  };
  onStatus?.(
    `Checking ${source.chainName} USDC balance and ${source.nativeCurrency.symbol} for gas…`,
  );
  const [
    supportsAtomicBatch,
    evmBalanceRead,
    nativeBalanceRead,
    gasPriceRead,
    eip1559Fees,
    approveGasUnits,
  ] = await Promise.all([
    getCapabilities(walletClient, { account, chainId: source.chainId })
      .then((capabilities) => {
        const atomicStatus = capabilities?.atomic?.status;
        return atomicStatus === 'supported' || atomicStatus === 'ready';
      })
      .catch(() => false),
    settleRead(
      publicClient.readContract({
        address: source.usdc as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [account],
      }) as Promise<bigint>,
    ),
    settleRead(publicClient.getBalance({ address: account })),
    settleRead(publicClient.getGasPrice()),
    // estimateFeesPerGas unavailable (e.g. a non-1559 chain) → undefined: keep the
    // getGasPrice() cap and let viem/the wallet pick the fees.
    publicClient.estimateFeesPerGas().catch(() => undefined),
    // Precise approve estimate (estimable pre-allowance); undefined → the flat
    // envelope below, so the preflight never crashes on it.
    publicClient
      .estimateContractGas({
        address: source.usdc as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [source.tokenMessenger as `0x${string}`, amountWei],
        account,
      })
      .catch(() => undefined),
  ]);
  const evmBalance = unwrapRead(evmBalanceRead);

  // Pre-check the EVM USDC balance so a shortfall surfaces a clear, actionable
  // error instead of an opaque on-chain approve/burn revert.
  if (evmBalance < amountWei) {
    throw new Error(
      `MetaMask account ${evmAddress} is low on USDC on ${source.chainName} ` +
        `(has ${evmBalance}, needs ${amountWei} base units) — top it up at https://faucet.circle.com.`,
    );
  }

  // Pre-check NATIVE gas (POL/ETH). A funder with USDC but zero native balance
  // passes the USDC check and even eth_estimateGas, then fails only at BROADCAST
  // with a raw "insufficient funds for gas" RPC error (no faucet pointer). The
  // fresh path sends two EVM txs (approve + burn) the user pays for, so estimate a
  // robust budget and refuse BEFORE any write. The per-gas cap is the EIP-1559
  // effective maxFeePerGas (what viem actually caps a tx at) MAX'd with
  // getGasPrice() — the old getGasPrice()-only figure under-caught a real Ethereum
  // shortfall (#192). The approve is estimated precisely (estimable pre-allowance);
  // depositForBurn (NOT estimable pre-approve — it transferFroms USDC) gets a fixed
  // budget. This is TERMINAL (errors.ts: "insufficient funds" matches TERMINAL_RE)
  // so it fails cleanly with the fund-your-wallet message rather than resume-looping.
  // (Fresh path only: the resume path's only chain leg is the manager-gas-paid
  // Starknet mint — no EVM tx — so it must finish even with zero native balance.)
  const nativeBalance = unwrapRead(nativeBalanceRead);
  const gasPrice = unwrapRead(gasPriceRead);

  // Effective per-gas cap: MAX(EIP-1559 maxFeePerGas, legacy gasPrice).
  let perGasCap = gasPrice;
  // Explicit EIP-1559 fees for the approve/burn submits, read live + floored to the
  // chain's enforced minimum tip and bumped by a margin (selectEip1559Fees) so a
  // slightly-stale sample can't land under a Polygon "gas tip cap below minimum"
  // reject (2026-07-08). Undefined only if the node has no 1559 data (non-1559
  // chain) → fall back to letting viem/the wallet pick, the prior behavior.
  const minPriorityFeeWei =
    source.minPriorityFeeGwei !== undefined
      ? BigInt(source.minPriorityFeeGwei) * 1_000_000_000n
      : undefined;
  let feeOverrides: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | undefined;
  if (eip1559Fees?.maxFeePerGas !== undefined && eip1559Fees.maxFeePerGas > perGasCap) {
    perGasCap = eip1559Fees.maxFeePerGas;
  }
  if (eip1559Fees?.maxFeePerGas !== undefined && eip1559Fees?.maxPriorityFeePerGas !== undefined) {
    feeOverrides = selectEip1559Fees(eip1559Fees, minPriorityFeeWei);
  }
  // Precise approve estimate + a conservative fixed burn budget; the flat envelope
  // when the estimate was unavailable.
  const gasUnits: bigint =
    approveGasUnits !== undefined ? approveGasUnits + BURN_GAS_UNITS_BUDGET : FRESH_PATH_GAS_UNITS;
  const requiredWei = (gasUnits * perGasCap * GAS_PRICE_SAFETY_NUM) / GAS_PRICE_SAFETY_DEN;
  // Skip this hard block for an atomic-batch wallet: it may be a smart account that
  // pays gas via a paymaster and legitimately holds zero native balance, yet is exactly
  // the wallet that benefits from batching. A self-paying batch wallet that IS short on
  // gas still fails cleanly — guardGas maps the broadcast "insufficient funds" to the
  // same friendly message. The two-tx fallback (self-paying by definition) keeps the
  // preflight.
  if (!supportsAtomicBatch && nativeBalance < requiredWei) {
    throw new Error(insufficientGasMessage(source, evmAddress, nativeBalance, requiredWei));
  }

  // PRE-FLIGHT (Bundle A2): before we burn, prove localStorage can persist the
  // resume cursor we'll write right after the burn. If it can't (private-browsing,
  // disabled storage, quota), refuse to burn — a silently-lost cursor means a
  // reload couldn't resume and the user could re-burn (double-spend). FRESH path
  // only; the resume path above has already burned.
  assertStorageWritable(STORAGE_PROBE_KEY, 'a deposit');

  // Belt-and-braces (#192): even after the preflight, gas price can spike between
  // the read above and broadcast. If viem still throws a RAW "insufficient funds"
  // at broadcast, re-throw the SAME friendly (TERMINAL) message so the raw revert
  // never reaches the user. Non-gas errors propagate unchanged.
  const guardGas = async <T>(write: () => Promise<T>): Promise<T> => {
    try {
      return await write();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/insufficient funds/i.test(msg)) {
        throw new Error(insufficientGasMessage(source, evmAddress, nativeBalance));
      }
      throw err;
    }
  };

  // Approve the TokenMessenger to pull the USDC, then burn it toward the Starknet
  // account (CCTP destinationDomain = Starknet). depositForBurn calls transferFrom, so
  // the allowance must be live first.
  //
  // Prefer an EIP-5792 ATOMIC BATCH (wallet_sendCalls): approve + burn land in ONE user
  // confirmation instead of two. The wallet provides atomicity — a smart-contract
  // account, or an EOA it delegates via EIP-7702 to a wallet-supplied implementation —
  // so we deploy no contracts of our own. Any wallet that doesn't advertise atomic
  // batching (older MetaMask, a WalletConnect session without the 5792 methods) falls
  // through to the unchanged two-transaction path.
  const approveCall = {
    to: source.usdc as `0x${string}`,
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [source.tokenMessenger as `0x${string}`, amountWei],
    }),
  };
  const burnCall = {
    to: source.tokenMessenger as `0x${string}`,
    data: encodeFunctionData({
      abi: TOKEN_MESSENGER_ABI,
      functionName: 'depositForBurn',
      args: [
        amountWei,
        config.cctp.starknetDomain,
        snAddressToBytes32(snRecipient),
        source.usdc as `0x${string}`,
        ZERO_BYTES32,
        maxFee,
        minFinalityThreshold,
      ],
    }),
  };

  // supportsAtomicBatch was probed up front (before the native-gas preflight). `burnTx`
  // stays undefined until a burn lands; the two-tx path below runs only when it's still
  // undefined, which — since every atomic outcome either sets it or throws — happens
  // exactly for a non-atomic wallet.
  let burnTx: `0x${string}` | undefined;
  if (supportsAtomicBatch) {
    onStatus?.('Approving + burning USDC in one confirmation…');
    // Snapshot the source-chain block BEFORE sendCalls so the interleaved burn-event
    // scan inside waitForBatchStatus can find a same-block landing (a public RPC's
    // block height typically lags the sequencer by 0-1 block). Pre-broadcast throw is
    // safe — nothing is committed yet.
    const scanFromBlock = await publicClient.getBlockNumber();
    const { id } = await guardGas(() =>
      sendCalls(walletClient, {
        account,
        chain: sourceChain,
        // Require atomicity: an approve that landed WITHOUT the burn would leave a
        // dangling allowance and a half-done deposit. We only get here when atomic is
        // supported/ready, so this won't spuriously reject.
        forceAtomic: true,
        calls: [approveCall, burnCall],
      }),
    );
    // Poll wallet_getCallsStatus ourselves so a transient "unknown bundle id" (5730) right
    // after sendCalls doesn't abort the deposit — the exact failure a user hit, which a page
    // reload then fixed (see BATCH_CALLS_TIMEOUT_MS). We wait up to the same budget as the
    // two-tx path's receipt wait; we can't persist the resume cursor until this yields the
    // burn tx hash, so a shorter window would make a slow batch more prone than the two-tx
    // path to burn-then-throw before the cursor is written (reload double-spend risk).
    //
    // Second signal (the `scan` field): a wallet stuck returning 5730 for a bundle it
    // actually broadcast makes the batch invisible via wallet_getCallsStatus for the full
    // 180s; scanning our own CCTP DepositForBurn event on chain each iteration breaks the
    // wait as soon as the burn is visible. Same downstream path — the scan-produced tx
    // hash flows through the same cursor-persist → onBurned → attest → mint sequence.
    const batchStatus = await waitForBatchStatus(walletClient, {
      id,
      timeoutMs: BATCH_CALLS_TIMEOUT_MS,
      pollIntervalMs: BATCH_POLL_INTERVAL_MS,
      scan: {
        publicClient,
        tokenMessenger: source.tokenMessenger as `0x${string}`,
        burnToken: source.usdc as `0x${string}`,
        depositor: account,
        mintRecipient: snAddressToBytes32(snRecipient),
        amountWei,
        destinationDomain: config.cctp.starknetDomain,
        fromBlock: scanFromBlock,
      },
    });
    if (batchStatus.kind === 'success') {
      // Atomic execution yields ONE receipt (both calls in a single tx); a wallet that
      // batches as separate txs yields one per call. The burn is the LAST call either
      // way, so the last receipt's tx carries the CCTP MessageSent log that attest/mint
      // below looks up by burnTx.
      const batchBurnReceipt = batchStatus.receipts?.at(-1);
      if (!batchBurnReceipt?.transactionHash) {
        throw new Error(`Batched deposit returned no transaction hash on ${source.chainName}`);
      }
      if (batchBurnReceipt.status !== 'success') {
        throw new Error(
          `CCTP depositForBurn reverted on ${source.chainName} (batch tx ${batchBurnReceipt.transactionHash})`,
        );
      }
      burnTx = batchBurnReceipt.transactionHash;
    } else if (batchStatus.kind === 'scan-success') {
      // Wallet stopped answering wallet_getCallsStatus but the burn event is on chain —
      // the bundle DID broadcast. There is no viem batch receipt to validate; the log
      // itself proves the burn happened for our (depositor, mintRecipient, amount,
      // destinationDomain). Attest / mint only need the tx hash (finishAttestAndMint →
      // waitForAttestation is Iris-keyed by tx hash + source domain).
      burnTx = batchStatus.burnTx;
    } else if (batchStatus.kind === 'failure') {
      throw new Error(
        `CCTP approve+burn batch did not succeed on ${source.chainName} (status ${batchStatus.statusCode})`,
      );
    } else {
      // 'in-flight' or 'never-acknowledged': the wallet ACCEPTED wallet_sendCalls (we hold a
      // bundle id) but never returned a terminal status within the budget. Crucially, we CANNOT
      // fall back to a second approve+burn here: the batch may still be mining, and nothing can
      // prove it won't land. A pending bundle is invisible in a balance snapshot (the burn debits
      // only when it mines), and inbound USDC during the long poll can mask one that already did —
      // so a balance check can't rule out a double CCTP burn. We also have no burn tx hash to
      // attest/mint. So we must NOT re-burn: surface a clear, non-retryable error. (The two-tx
      // path below is reached only when the wallet has NO atomic support — no sendCalls was ever
      // issued, so there is no in-flight bundle a second burn could stack on.)
      throw new Error(
        `CCTP approve+burn batch on ${source.chainName} could not be confirmed within ` +
          `${Math.round(BATCH_CALLS_TIMEOUT_MS / 1000)}s (bundle ${id}, ${batchStatus.kind}). It may ` +
          `still land — do NOT retry; reload the page and check your balance before trying again.`,
      );
    }
  }

  if (burnTx === undefined) {
    // Two separate transactions (two confirmations). Reached ONLY for a wallet without atomic
    // batching — we never called wallet_sendCalls, so there is no in-flight bundle a second
    // burn could stack on. (Every atomic outcome above either set burnTx or threw.)
    // 1a. Approve the TokenMessenger to pull the USDC, then wait for it to mine.
    onStatus?.('Approving USDC for CCTP burn…');
    const approveTx = await guardGas(() =>
      walletClient.writeContract({
        account,
        chain: sourceChain,
        address: source.usdc as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [source.tokenMessenger as `0x${string}`, amountWei],
        ...feeOverrides,
      }),
    );
    await publicClient.waitForTransactionReceipt({ hash: approveTx });

    // 1b. Burn the USDC toward the Starknet account (CCTP destinationDomain = Starknet).
    onStatus?.('Burning USDC on the source chain (CCTP)…');
    burnTx = await guardGas(() =>
      walletClient.writeContract({
        account,
        chain: sourceChain,
        address: source.tokenMessenger as `0x${string}`,
        abi: TOKEN_MESSENGER_ABI,
        functionName: 'depositForBurn',
        args: [
          amountWei,
          config.cctp.starknetDomain,
          snAddressToBytes32(snRecipient),
          source.usdc as `0x${string}`,
          ZERO_BYTES32,
          maxFee,
          minFinalityThreshold,
        ],
        ...feeOverrides,
      }),
    );
    const burnReceipt = await publicClient.waitForTransactionReceipt({ hash: burnTx });
    if (burnReceipt.status !== 'success') {
      throw new Error(`CCTP depositForBurn reverted on ${source.chainName} (tx ${burnTx})`);
    }
  }

  // Persist the resume cursor BEFORE attest/mint: from here on the funds are
  // committed to CCTP and recovery must RESUME (never re-burn). We pre-flighted
  // storage above, but a post-burn write can still fail (e.g. quota); if the
  // read-back shows it didn't land, surface a prominent NON-fatal warning so the
  // user doesn't reload + double-burn (Bundle A2). We do NOT abort — the burn
  // already committed the funds, and this run can still finish attest+mint.
  const persisted = writeInflightDepositVerified(evmAddress, {
    burnTx,
    sourceDomain: source.domain,
    amountWei: amountWei.toString(),
    snRecipient,
    evmChainId: source.chainId,
    maxFee: maxFee.toString(),
    // Record how THIS burn was started so a later resume classifies a consumed CCTP
    // nonce off the burn's ORIGINAL intent, not a live-recomputed `deferMint` that
    // may have flipped in between (the fold-resume double-burn, Bugbot HIGH).
    fold: args.deferMint === true,
  });
  if (!persisted) {
    onStatus?.(
      'WARNING: could not save the deposit resume point — do NOT reload this tab until the deposit completes.',
    );
  }

  // The burn is committed on-chain — surface it (hash + source explorer link) so the
  // caller can show the EVM leg on the deposit receipt, independent of attest/mint below.
  args.onBurned?.({ burnTxHash: burnTx, explorerUrl: evmExplorerTxUrl(source, burnTx) });

  // 2-3. Attest (Iris is keyed by the EVM SOURCE domain), validate the attested
  // message (Fix 2), mint on Starknet, then clear the cursor. Same path the
  // resume branch takes, so a fresh and a resumed deposit finish identically.
  await finishAttestAndMint(burnTx, source.domain, snRecipient);
  // Bug1: prefer the actual minted (burn − feeExecuted) decoded from the attested
  // message over the maxFee-based estimate, so the caller deposits exactly what landed
  // (fold path) / what the standalone mint credited (2-tx path). Falls back to the
  // estimate for a truncated/legacy message with no fee field.
  return mintedFromMessageWei ?? netMintedWei;
}
