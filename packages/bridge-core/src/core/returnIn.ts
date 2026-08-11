// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Return-funds Leg-A: the REVERSE-CCTP burn (Polygon → Starknet) that returns a
// per-account deposit wallet's leftover USDC back into the InboundAnonymizer via
// privacy-compute (no sub-accounts) — the pool's `ComputeAndInvoke` feature.
//
// The burn runs GASLESSLY as a relayer WALLET batch FROM the per-account DEPOSIT WALLET
// (the CREATE2 smart wallet that held the trade proceeds): the relayer pays the
// Polygon gas, and the per-account EOA only SIGNS the relayer's EIP-712 batch (it holds
// no funds and needs NO POL). This removes the per-account-EOA POL precondition that the
// old EOA-signed path required. The burner / msg.sender is the deposit wallet, so
// the burned == minted to the InboundAnonymizer (the return-leg burn is fee-free:
// Standard finality, maxFee 0, `depositForBurnWithHook`). Steps:
//
//   1. Build the burn calls = [ approve(USDC → Polygon TokenMessengerV2, amount),
//      depositForBurnWithHook(dest = Starknet, mintRecipient = destinationCaller =
//      the INBOUND ANONYMIZER, hookData = the bound commitment) ].
//   2. Submit them gaslessly via the INJECTED submitter (submitGaslessBatch) — that
//      relayer batch IS the burn; it returns the on-chain Polygon burn tx hash.
//   3. Poll Circle Iris for the attestation, keyed by the Polygon SOURCE domain (7),
//      and SURFACE the {message, attestation} to the orchestrator.
//
// The CCTP MINT is NO LONGER submitted here: it is FOLDED into the proven pool claim
// (bridgeBack.ts) — InboundAnonymizer.privacy_invoke_with_computation runs
// receive_message (mint) + hands the minted USDC to the pool in ONE atomic,
// proof-authorized tx. So this module stops at attestation; the orchestrator
// (returnToPool) runs the folded claim next. This closes the A↔deposit-wallet leak: the
// user's derived Starknet account is never the on-chain sender of any return leg.
//
// Module boundary: returnIn keeps the CCTP knowledge (resolves the source contracts
// + builds/encodes the burn calls) and the resume cursor; the gasless transport is
// owned by relayer.ts and INJECTED here as submitGaslessBatch — so this module needs
// no relayer/builder-SDK import and stays unit-testable offline.
//
// Resumable: the burn → attest → claim window is minutes long; once the burn lands
// the wallet's USDC is committed to CCTP and a reload must RESUME from attest, never
// re-burn (re-burning double-spends the wallet's USDC). The post-burn cursor (a single
// "awaiting claim" state keyed by the burn tx) is owned here; the claim stage /
// ReturnContext clears it once the folded claim lands. Resume idempotency uses the CCTP
// nonce: a consumed nonce PROVES the folded claim already landed (the mint is inside it),
// so there is nothing left to do.
//
// LIVE-VERIFICATION BOUNDARY (.claude/rules/verification.md): the cross-chain burn
// → attest → folded-claim (mint) can only be confirmed against live CCTP infra + the
// relayer + a live proving/AVNU submit. The unit tests pin the client behaviour (the
// gasless burn calls, the INBOUND mintRecipient/destinationCaller + hookData, the
// attestation source domain, the folded-claim wiring) against an injected submitter +
// mocked Iris/proving/submit.

import { encodeFunctionData, parseEventLogs, type Abi, type Log, type PublicClient } from 'viem';

import { config, getEvmCctpSource, resolveEvmCctpDestination } from './config';
import { isTerminalAttestFailure, waitForAttestation } from './polygonMint';
import { isCctpMessageNonceUsed } from './depositIn';
import { snAddressToBytes32 } from './snMint';
import type { CctpMessageMatch } from './polygonMint';
import {
  deriveAccountNonce,
  deriveInboundCommitment,
  deriveStarknetAccount,
  deriveStarknetPrivateKey,
  deriveViewingKey,
  encodeCommitmentHookData,
} from '../derivation/index';
import { claimToPool, buildAndProveClaim, submitProvenClaim } from './bridgeBack';
import { assertStorageWritable } from './storageProbe';
import { markNonRetryable } from './errors';
import { sleep } from './proving';
import {
  clearPendingReturnBurn,
  evmClientForSource,
  isPendingBurnExecutable,
  readPendingReturnBurn,
  resolvePendingReturnBurn,
  writePendingReturnBurn,
  TOKEN_MESSENGER_EVENT_ABI,
  type PendingReturnBurn,
} from './pendingReturnBurn';

// Identifies OUR return message in an Iris response. The return burn is submitted by
// the builder relayer, which batches several users' ops into ONE transaction, so the
// response can hold strangers' CCTP messages — including OTHER RETURNS, which share our
// domains AND our mintRecipient (the one inbound anonymizer). Only the burn-bound
// commitment in hookData is unique per return, so it is the required discriminator.
function returnMessageMatch(
  sourceDomain: number,
  inboundAnonymizer: string | undefined,
  commitment: string,
): CctpMessageMatch {
  return {
    expectedSourceDomain: sourceDomain,
    expectedDestinationDomain: config.cctp.starknetDomain,
    expectedRecipient: snAddressToBytes32(inboundAnonymizer ?? config.inboundAnonymizerAddress),
    expectedHookData: encodeCommitmentHookData(BigInt(commitment)),
  };
}

// CCTP Standard finality (free, finalized) — the default for testing. 1000 = Fast.
const STANDARD_FINALITY = 2000;

// Dust tolerance (USDC base units, 6 dp = 0.01 USDC) for the stale-cursor re-validation's
// near-full-amount check: the burn moves ≈ the whole frozen amount, so "funds still fully
// present" (never-burned) ⟺ the live returnable balance is within this band of the frozen
// amount. Small enough that leftover pUSD/USDC.e dust after a real burn can never cross it
// (frozen return amounts are orders of magnitude larger), generous enough to absorb a
// conversion-rate/rounding dip in the genuine funds-still-present case.
const STALE_RETURN_DUST_TOLERANCE = 10_000n;

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
] as const satisfies Abi;

// CCTP V2 depositForBurnWithHook (circlefin EVM TokenMessengerV2) — depositForBurn
// PLUS a trailing opaque `hookData` field. The return burn uses the HOOK variant (not
// plain depositForBurn) so the bound commitment rides along in `hookData`, read by
// `InboundAnonymizer::receive_and_bind` on the Starknet side (32-byte big-endian —
// encodeCommitmentHookData). Param order otherwise matches the depositForBurn
// used by depositIn.ts.
const TOKEN_MESSENGER_HOOK_ABI = [
  {
    type: 'function',
    name: 'depositForBurnWithHook',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'burnToken', type: 'address' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32' },
      { name: 'hookData', type: 'bytes' },
    ],
    outputs: [],
  },
] as const satisfies Abi;

// FEE-FREE-RETURN INVARIANT: the return path is fee-free (Standard finality, maxFee
// 0). The proven claim (claimToPool / ComputeAndInvoke) drains ledger[commitment],
// which `receive_and_bind` credits with the GROSS burned `amount`; a per-call CCTP
// fee would make the NET mint (amount − fee) fall short of what the claim tries to
// drain → the claim reverts INSUFFICIENT_CLAIMABLE. Rather than silently strand
// funds, FAIL LOUD if a caller passes a fee-bearing config. The params stay in the
// signature (so call sites don't break) — only non-fee-free values are rejected.
// Behavior-preserving for all current callers (they pass maxFee 0 / Standard finality).
function assertFeeFreeReturn(maxFee: bigint, minFinalityThreshold: number): void {
  if (maxFee !== 0n) {
    throw new Error(
      `returnToPool: the return path is fee-free — maxFee must be 0 (got ${maxFee}). A per-call ` +
        'CCTP fee under-mints the gross claim amount and would revert the claim (INSUFFICIENT_CLAIMABLE).',
    );
  }
  if (minFinalityThreshold < STANDARD_FINALITY) {
    throw new Error(
      `returnToPool: the return path is fee-free — Standard finality only (minFinalityThreshold ≥ ` +
        `${STANDARD_FINALITY}, got ${minFinalityThreshold}). Fast finality incurs a per-call fee.`,
    );
  }
}

// --- inflight-return resume cursor -------------------------------------------
// The return CCTP burn → attest → folded-claim window is minutes long. Once the burn
// lands, the EOA's USDC is committed to CCTP and the only thing left is to finish
// attest → the folded pool claim (which mints + claims atomically). A reload/crash/
// retry in that window would otherwise re-run depositForBurnWithHook and DOUBLE-BURN
// the EOA's USDC. So we persist the burn tx hash + source domain + amount + the bound
// commitment + accountIndex (all NON-SECRET, all public once the burn is on-chain)
// keyed per EVM address, and resume from attest. waitForAttestation is idempotent
// on the same burnTx.
//
// SINGLE post-burn state (no more 'cctp'/'claim' phases): the cursor exists ⟺ we
// burned and the folded claim has not been confirmed cleared. Resume idempotency comes
// from the CCTP nonce — a consumed nonce PROVES the folded claim (mint inside it)
// already landed, so there is nothing left to do. The claim stage / ReturnContext
// CLEARS the cursor once the claim lands.
// SELF-CONTAINED here on purpose: device-store (T5) only references the KEY.
export const INFLIGHT_RETURN_KEY = 'pmp.inflightReturn';

export interface InflightReturn {
  accountIndex: number;
  burnTx: string;
  sourceDomain: number;
  amount: string; // bigint serialized as a decimal string
  // The commitment carried in the burn's hookData (deriveInboundCommitment, decimal-
  // encoded felt252) — the commitment the folded claim's on-chain COMMITMENT_MISMATCH
  // asserts against. Non-secret (a one-way hash); persisted for resume/recovery and to
  // match this identity's cursor by commitment (see findInflightReturnByCommitment).
  commitment: string;
  evmChainId: number;
  // The InboundAnonymizer address the burn was BUILT AGAINST (mintRecipient +
  // destinationCaller + hookData commitment all pin to it, and the folded claim's on-chain
  // recompute uses THIS contract's address). Persisted so a resume/recover survives a
  // config `inboundAnonymizerAddress` change mid-return (a redeploy): the claim must target
  // the burn-time contract, or the on-chain recompute lands on a different commitment
  // (COMMITMENT_MISMATCH) / targets a contract holding no CCTP funds. OPTIONAL for
  // backward-compat: a cursor written before this field falls back to the current config
  // address (migrate-on-read) — correct as long as the address hasn't changed since.
  inboundAnonymizer?: string;
  // The account CHANNEL the burned index belongs to (see account-store). The commitment
  // in the burn's hookData binds the channel (via the account nonce), so a resume/recover
  // MUST re-derive with THIS channel — recoverBridgeIn/scanUnclaimedReturns read it here
  // and self-route (like inboundAnonymizer/sourceDomain), so a channel-blind caller
  // recovers a channel's return without knowing its channel. OPTIONAL/backward-compat:
  // absent on default-channel + pre-channel cursors → undefined = the default (byte-
  // identical) derivation.
  channel?: string;
  // Written only by chain-evidence recovery, off a matched on-chain DepositForBurn. Such a
  // cursor is exempt from the stale-balance heuristic.
  proven?: true;
  // LEGACY (ignored): pre-fold cursors carried a two-phase field. Kept optional so a
  // cursor written before the single-tx fold still validates + resumes.
  phase?: 'cctp' | 'claim';
}

type InflightReturnMap = Record<string, InflightReturn>;

function readInflightReturnMap(): InflightReturnMap {
  try {
    const raw = localStorage.getItem(INFLIGHT_RETURN_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as InflightReturnMap;
    return {};
  } catch {
    return {};
  }
}

// Migrate-on-read: a cursor persisted before the Slice R rename used the legacy
// pre-Slice-R index field name instead of `accountIndex` (see the property
// read below). Accept it here so an in-flight return
// crossing the rename isn't dropped as corrupt (which would strand an
// already-committed CCTP burn).
function migrateAccountIndexKey(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (record.accountIndex === undefined && typeof record.bidIndex === 'number') {
    const { bidIndex, ...rest } = record;
    return { ...rest, accountIndex: bidIndex };
  }
  return value;
}

// Validate a persisted cursor before trusting it (mirrors isValidInflightDeposit):
// a corrupt/partial record would make the resume path poll a bad Iris URL or claim
// against garbage. A record is valid only if every field has the right shape —
// burnTx a 0x-hex string, commitment a bounded decimal felt string (mirrors the amount
// check — a commitment is a Poseidon output, well under felt252's ~77 decimal digits),
// amount a positive-integer string, and the accountIndex/domain/chain ids finite
// numbers. The legacy `phase` field (pre-fold) is NOT required — a cursor written before
// the single-tx fold still resumes.
export function isValidInflightReturn(value: unknown): value is InflightReturn {
  const migrated = migrateAccountIndexKey(value);
  if (!migrated || typeof migrated !== 'object') return false;
  const r = migrated as Record<string, unknown>;
  return (
    typeof r.accountIndex === 'number' &&
    Number.isFinite(r.accountIndex) &&
    typeof r.burnTx === 'string' &&
    /^0x[0-9a-fA-F]+$/.test(r.burnTx) &&
    typeof r.sourceDomain === 'number' &&
    Number.isFinite(r.sourceDomain) &&
    typeof r.amount === 'string' &&
    r.amount.length <= 80 &&
    /^[0-9]+$/.test(r.amount) &&
    typeof r.commitment === 'string' &&
    r.commitment.length <= 80 &&
    /^[0-9]+$/.test(r.commitment) &&
    typeof r.evmChainId === 'number' &&
    Number.isFinite(r.evmChainId) &&
    // OPTIONAL (backward-compat): absent on pre-redeploy cursors → falls back to config.
    // When present it must be a 0x-hex Starknet address (the burn-time InboundAnonymizer).
    (r.inboundAnonymizer === undefined ||
      (typeof r.inboundAnonymizer === 'string' && /^0x[0-9a-fA-F]+$/.test(r.inboundAnonymizer))) &&
    // OPTIONAL (backward-compat): absent on default-channel + pre-channel cursors. When
    // present it must be a string (deriveAccountNonce re-validates its slug shape).
    (r.channel === undefined || typeof r.channel === 'string')
  );
}

// End of life for ONE return burn: drop the resume cursor AND the pending-submission
// record together. They are separate stores with separate jobs, but they describe the SAME
// burn, so every terminal outcome has to retire both. A pending record that outlives its
// burn keeps re-promoting it from chain, and the user's NEXT return is then swallowed as
// "already claimed" instead of returning their new funds — and the deadline path can never
// clear it, because that burn genuinely did land. Used at the folded claim landing, the
// already-claimed short-circuit, and a demonstrably-terminal attestation failure.
function clearReturnRecords(evmAddress: string): void {
  clearInflightReturn(evmAddress);
  clearPendingReturnBurn(evmAddress);
}

function clearInflightReturn(evmAddress: string): void {
  try {
    const map = readInflightReturnMap();
    delete map[evmAddress.toLowerCase()];
    localStorage.setItem(INFLIGHT_RETURN_KEY, JSON.stringify(map));
  } catch {
    // ignore.
  }
}

// Read the cursor for an EVM address, dropping (and clearing) a corrupt record so
// the caller treats it as a FRESH return rather than resuming off garbage. Returns
// the MIGRATED shape (see migrateAccountIndexKey) so a cursor written before the
// Slice R rename still exposes `accountIndex`.
function readInflightReturn(evmAddress: string): InflightReturn | null {
  const raw = readInflightReturnMap()[evmAddress.toLowerCase()] ?? null;
  if (raw === null) return null;
  const migrated = migrateAccountIndexKey(raw);
  if (!isValidInflightReturn(migrated)) {
    clearInflightReturn(evmAddress);
    return null;
  }
  return migrated;
}

// All VALID post-burn return cursors on this device, paired with the EVM address that
// keys each (needed to clear it). The fold-only recovery model is cursor-driven: the
// folded claim needs the CCTP message/attestation, obtainable ONLY from the persisted
// burn tx via Iris — so recovery works on the device that holds the cursor (there is no
// on-chain per-commitment ledger to scan cross-device anymore). Best-effort: skips
// corrupt records; never throws. Used by recoverBridgeIn + scanUnclaimedReturns.
export function listInflightReturns(): Array<{ evmAddress: string; record: InflightReturn }> {
  const out: Array<{ evmAddress: string; record: InflightReturn }> = [];
  for (const [evmAddress, raw] of Object.entries(readInflightReturnMap())) {
    const migrated = migrateAccountIndexKey(raw);
    if (isValidInflightReturn(migrated)) out.push({ evmAddress, record: migrated });
  }
  return out;
}

// Find this identity's post-burn cursor by its (decimal-encoded) commitment. The
// commitment is re-derivable from (signature, accountIndex), so matching by it confirms
// the cursor belongs to the current identity WITHOUT needing the EVM address — and a
// folded claim over another identity's cursor would revert COMMITMENT_MISMATCH anyway.
export function findInflightReturnByCommitment(
  commitment: string,
): { evmAddress: string; record: InflightReturn } | null {
  return listInflightReturns().find(({ record }) => record.commitment === commitment) ?? null;
}

// Normalized read of the in-flight return cursor for the unified
// getBridgeTransferStatus reader. Returns the frozen amount already committed to the
// return + the account index that keys the deterministic recovery claim
// (recoverBridgeIn), or null when there is no resumable cursor. Reuses the validated
// reader (migrate-on-read + corrupt-drop; best-effort — never throws).
export function peekInflightReturn(
  evmAddress: string | null | undefined,
): { amountWei: bigint; accountIndex: number } | null {
  if (!evmAddress) return null;
  const record = readInflightReturn(evmAddress);
  if (!record) return null;
  return { amountWei: BigInt(record.amount), accountIndex: record.accountIndex };
}

// FUND-SAFETY (Bugbot HIGH — "Switch guard skips burn cursors"): the funder-
// AGNOSTIC counterpart of hasInflightDeposit's `hasAnyInflightDeposit`. A network
// switch disconnect()s and wipes ALL pmp.* cursors — including pmp.inflightReturn
// — so a burn-but-not-yet-claimed RETURN in flight would be stranded. The always-
// present network toggle can be clicked SIGNED OUT (no EVM address known), so the
// per-address readInflightReturn can't guard it. This scans the whole per-address
// cursor map and returns true iff ANY address has a VALID (resumable, non-corrupt)
// return cursor. Cheap synchronous localStorage read; safe to call from render.
export function hasAnyInflightReturn(): boolean {
  const map = readInflightReturnMap();
  return Object.values(map).some((record) => isValidInflightReturn(record));
}

// Best-effort cursor write that REPORTS whether it actually landed (mirrors
// writeInflightDepositVerified). Used AFTER the burn — the burn already committed
// the funds to CCTP, so we never throw here; the caller surfaces a "don't reload"
// warning when the read-back shows the cursor didn't persist.
function writeInflightReturnVerified(evmAddress: string, record: InflightReturn): boolean {
  try {
    const map = readInflightReturnMap();
    map[evmAddress.toLowerCase()] = record;
    localStorage.setItem(INFLIGHT_RETURN_KEY, JSON.stringify(map));
  } catch {
    // fall through to the read-back, which reports the miss.
  }
  const persisted = readInflightReturnMap()[evmAddress.toLowerCase()];
  return !!persisted && persisted.burnTx === record.burnTx && persisted.phase === record.phase;
}

// Chain evidence about a cursor's own burn tx. 'unknown' covers a failed read AND an
// ambiguous answer — neither is absence. 'unsupported-chain' is permanent: there is no
// RPC left to ask.
type CursorBurnVerdict = 'found' | 'not-found' | 'unknown' | 'unsupported-chain';

// eth_getTransactionReceipt on the cursor's own hash (no log range, so range-capped
// providers work). The hookData commitment comes from the CURSOR, never a fresh
// derivation — a cursor predating an InboundAnonymizer redeploy carries a different one.
//
// Only two answers are absence: a REVERTED receipt, and a hash no node has ever seen. A
// mined receipt without our DepositForBurn is ambiguous (an address or wire-format drift
// would otherwise re-burn every real burn), and a null receipt for a tx that DOES exist is
// merely unmined — this RPC is a different endpoint from the caller's balance reader, so a
// lagging pool can serve "balance full, no receipt" for a burn sitting in the mempool.
async function verifyCursorBurnOnChain(cursor: InflightReturn): Promise<CursorBurnVerdict> {
  const source = getEvmCctpSource(cursor.evmChainId);
  if (!source) return 'unsupported-chain';
  try {
    const client = evmClientForSource(source);
    const hash = cursor.burnTx as `0x${string}`;
    const receipt = await client.request({
      method: 'eth_getTransactionReceipt',
      params: [hash],
    });
    if (!receipt) {
      const tx = await client.request({ method: 'eth_getTransactionByHash', params: [hash] });
      return tx ? 'unknown' : 'not-found';
    }
    const status = String((receipt as { status?: unknown }).status ?? '');
    if (status !== '0x1') return status === '0x0' ? 'not-found' : 'unknown';
    const wantHookData = encodeCommitmentHookData(BigInt(cursor.commitment)).toLowerCase();
    const burns = parseEventLogs({
      abi: TOKEN_MESSENGER_EVENT_ABI,
      eventName: 'DepositForBurn',
      logs: (receipt.logs ?? []) as unknown as Log[],
    });
    const matched = burns.some(
      (log) =>
        log.address.toLowerCase() === source.tokenMessenger.toLowerCase() &&
        log.args.hookData?.toLowerCase() === wantHookData,
    );
    return matched ? 'found' : 'unknown';
  } catch {
    return 'unknown';
  }
}

// Turn a PENDING (submitted, outcome unobserved) return burn into a real post-burn
// cursor, once — and only once — the chain proves the burn actually landed.
//
// This is the recovery half of the pending-record scheme (see pendingReturnBurn.ts). It is
// the ONLY writer that can mint a cursor without having watched the burn happen, so the
// promotion gate is the chain scan's `landed` verdict and nothing weaker: 'pending' and
// 'unknown' both leave the record untouched for a later attempt, because a cursor written
// on a guess would send the resume path off to attest a tx hash that does not exist.
//
// A 'never-landed' verdict is the other definitive answer — the batch's deadline has passed
// so it can never execute — and clears the record, which is what lets the user simply
// return again instead of being told forever not to retry.
//
// Returns the promoted cursor (so a caller can resume from it immediately) plus whether it
// actually reached storage, else null.
async function promoteLandedPendingBurn(
  evmAddress: string,
  opts?: { client?: PublicClient; now?: number },
): Promise<{ record: InflightReturn; persisted: boolean } | null> {
  const pending = readPendingReturnBurn(evmAddress);
  if (!pending) return null;
  // A cursor already exists for this address ⇒ the burn was observed the normal way and the
  // pending record is spent bookkeeping. Drop it rather than racing the real cursor.
  if (readInflightReturn(evmAddress)) {
    clearPendingReturnBurn(evmAddress);
    return null;
  }
  const resolution = await resolvePendingReturnBurn(pending, opts);
  if (resolution.kind === 'never-landed') {
    clearPendingReturnBurn(evmAddress);
    return null;
  }
  if (resolution.kind !== 'landed') return null;

  const record: InflightReturn = {
    accountIndex: pending.accountIndex,
    burnTx: resolution.burnTx,
    sourceDomain: pending.sourceDomain,
    amount: pending.amount,
    commitment: pending.commitment,
    evmChainId: pending.evmChainId,
    inboundAnonymizer: pending.inboundAnonymizer,
    channel: pending.channel,
  };
  writeInflightReturnVerified(evmAddress, record);
  // Clear only AFTER the cursor write is attempted: if that write is what fails (quota), the
  // pending record is the last thing standing between the user and a stranded burn, so it
  // must outlive a failed promotion and be retried on the next sweep.
  //
  // The RETURN VALUE is what callers must resume from, not a re-read of storage. The burn is
  // PROVEN on-chain at this point and we are holding its hash, so a failed cursor write is a
  // persistence problem, not an evidence problem — falling back to "no cursor" would drop
  // that hash and leave the run stuck on the unresolved-submission guard, blocking the very
  // recovery this function just completed. The fresh path already takes the same line: it
  // warns and carries on when its post-burn cursor write misses.
  //
  // The pending record is deliberately NOT cleared here, even on a successful write. A
  // cursor can still be dropped downstream — the stale-cursor re-validation nulls one whose
  // wallet looks full, which a lagging RPC can report right after the burn mines. Retiring
  // the only other handle at write time would make that drop unrecoverable: both records
  // gone for a burn that did happen. It is retired instead when the burn's lifecycle ENDS
  // (clearReturnRecords), and the next call's cursor-already-exists branch above sweeps up
  // the ordinary case.
  return { record, persisted: readInflightReturn(evmAddress) !== null };
}

// Public recovery entry point: resolve any submitted-but-unconfirmed return burn on this
// device for `evmAddress` and promote it to a resumable cursor if it landed. Safe to call
// on app load / from a periodic sweep — it is a no-op when there is nothing pending, never
// throws (a scan failure resolves 'unknown' and simply leaves the record), and never burns.
//
// Returns what the caller needs to decide what to say: whether a return is now resumable,
// and whether the funds are confirmed untouched (so offering a fresh return is safe).
export async function recoverPendingReturnBurn(
  evmAddress: string,
  opts?: { client?: PublicClient; now?: number },
): Promise<{ resumable: InflightReturn | null; stillPending: boolean }> {
  const promoted = await promoteLandedPendingBurn(evmAddress, opts);
  return {
    resumable: promoted?.record ?? null,
    // A record that outlives a successful PROMOTION is bookkeeping, not an open question:
    // that burn is resolved and resumable, and the record is only held until the return
    // completes. Reporting it as pending would tell the sweep "we still can't tell" about a
    // burn we just proved — so only an UNRESOLVED record counts.
    stillPending: promoted === null && readPendingReturnBurn(evmAddress) !== null,
  };
}

// The relayer batch is signed with a 10-minute EIP-712 deadline. The transport owns the
// real value and doesn't report it, so this is the conservative assumption — see
// PendingReturnBurn.deadlineMs for why erring long is the safe direction.
const DEFAULT_BATCH_DEADLINE_MS = 600_000;

// Inline budget for resolving a burn whose submitter threw. Generous enough to cover the
// usual case (the relayer's status poll gave up moments before the batch mined) without
// holding the UI to the batch's full 10-minute deadline: whatever is unresolved when this
// runs out stays in the pending record for the app's sweep / the next return attempt.
const AMBIGUOUS_RESOLVE_ATTEMPTS = 12;
const AMBIGUOUS_RESOLVE_INTERVAL_MS = 5_000;

// How long the pre-submit chain-head read may take before its answer is discarded. Comfortably
// above a healthy RPC round-trip and far below the time a burn needs to mine, so a normal read
// always lands and a hung one is dropped rather than believed.
const ANCHOR_READ_TIMEOUT_MS = 5_000;

// Read the chain head for the recovery scan's lower bound, bounded and NEVER rejecting.
//
// Written as one promise rather than `Promise.race([read, timer])` for two reasons, neither
// of which is unhandled rejections — a race attaches handlers to EVERY racer, so a losing
// racer's later rejection is already handled (verified empirically, not just from the spec):
//   - the timer is CLEARED once the read wins, instead of leaving a 5s handle pending on
//     every burn; and
//   - which branch settles first is explicit, rather than depending on microtask ordering
//     between two promise chains — under test, where the shared `sleep` is mocked to a
//     no-op, a race would resolve by luck and the anchor would be captured only sometimes.
function readAnchorBlock(client: PublicClient): Promise<string | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ANCHOR_READ_TIMEOUT_MS);
    const settle = (value: string | undefined) => {
      clearTimeout(timer);
      resolve(value);
    };
    client
      .getBlockNumber()
      .then((b) => settle(b.toString()))
      .catch(() => settle(undefined));
  });
}

// Ask the chain what happened to a burn whose submitter threw, polling while the answer is
// still "don't know". Returns the burn tx hash if it landed, 'never-landed' if the batch
// can no longer execute (funds untouched — the original error stands and a retry is safe),
// or null while it remains genuinely undecidable.
//
// Never clears the pending record on 'landed': the cursor is written by the caller a few
// lines later, and until it is, the pending record is the only thing that can recover this
// burn. Only a verdict that the funds NEVER MOVED is safe to clear here.
async function resolveAmbiguousReturnBurn(
  evmAddress: string,
  pending: PendingReturnBurn,
  onStatus?: (s: string) => void,
): Promise<string | 'never-landed' | null> {
  for (let attempt = 0; attempt < AMBIGUOUS_RESOLVE_ATTEMPTS; attempt++) {
    const resolution = await resolvePendingReturnBurn(pending);
    if (resolution.kind === 'landed') return resolution.burnTx;
    if (resolution.kind === 'never-landed') {
      clearPendingReturnBurn(evmAddress);
      return 'never-landed';
    }
    if (attempt < AMBIGUOUS_RESOLVE_ATTEMPTS - 1) {
      onStatus?.("Checking whether the return burn reached the chain — don't close this tab…");
      await sleep(AMBIGUOUS_RESOLVE_INTERVAL_MS);
    }
  }
  return null;
}

// Refusal for a fresh burn while an earlier submission is unresolved. Worded to classify
// TRANSIENT so the flow ends RESUMABLE rather than as a red terminal card, and shared by
// both entry points (returnToPool guards before its prep runs; returnBurnToPool guards
// again right before the burn) so the two can never drift apart.
function unresolvedSubmissionError(record: PendingReturnBurn): Error {
  return new Error(
    `A return burn for account #${record.accountIndex} was submitted from this device ` +
      `and hasn't been confirmed on-chain yet, so starting another one could burn the same ` +
      `funds twice. Your USDC is safe in the deposit wallet either way. Retry in a few ` +
      `minutes — we re-check the chain every time, and either resume the original burn or ` +
      `let you start a new one once the first can no longer run.`,
  );
}

// The honest error for a burn we still can't place. Always NON_RETRYABLE so nothing
// AUTOMATICALLY re-submits while the original batch may still mine.
//
// `tracked` says whether the pending record actually persisted, and the two messages differ
// because the user's safe next action differs. Tracked: the retry is safe by construction —
// it re-enters through the pending-recovery gate, which resolves the burn or refuses to
// start a second one. Untracked: there is no gate, so a retry WOULD take the fresh path
// while this batch may still be mining, and the only safe advice is to check the chain
// first. Promising the tracked story in the untracked case is how a recoverable strand
// becomes a double-burn.
function ambiguousBurnError(
  cause: unknown,
  evmAddress: string,
  // The wallet that actually BURNS, which is what a user must look up. NOT evmAddress:
  // that is the connected wallet used to key the record, and it never executes the burn —
  // pointing a user there means they see nothing, conclude it never happened, and retry
  // into the double-burn this message exists to prevent.
  depositWallet: string,
  tracked: boolean,
): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const message = tracked
    ? `The return burn was submitted but we couldn't confirm it on-chain yet (${detail}). ` +
      `Your funds are tracked: we saved this submission and will finish the return ` +
      `automatically once the burn appears on-chain — reopen or retry the return in a few ` +
      `minutes and it will resume. Do not send a second return; the retry checks the chain ` +
      `first and will never burn twice.`
    : `The return burn was submitted but we couldn't confirm it on-chain (${detail}), AND ` +
      `browser storage rejected the record we use to track it — so a retry cannot be ` +
      `protected from burning the same funds twice. Do NOT retry yet: check the deposit ` +
      `wallet ${depositWallet} on a block explorer first. If the burn is there your funds ` +
      `are in transit and will need recovery; if it is not, free up browser storage and retry.`;
  return markNonRetryable(Object.assign(new Error(message), { cause, evmAddress, depositWallet }));
}

// PRE-FLIGHT, FRESH-burn path only: prove localStorage accepts a write + read-back
// BEFORE we burn. If it can't (private-browsing, disabled storage, quota), the
// resume cursor we'd write AFTER the burn would silently vanish — a reload then
// couldn't resume and the EOA could re-burn (double-spend). Throw a TERMINAL error
// so we NEVER burn when we can't persist the cursor. (Do NOT call on the resume
// path: it has already burned, so refusing to resume would strand funds.)
const STORAGE_PROBE_KEY = 'pmp.returnStorageProbe';

// One call in the gasless relayer batch (target + ABI-encoded calldata).
export interface ReturnBurnCall {
  target: string;
  data: `0x${string}`;
}

// Injected gasless transport: submit the burn calls FROM the deposit wallet via the
// relayer (signed by the EOA owner, relayer pays Polygon gas) and return the
// on-chain Polygon tx hash of the executed batch (the one Iris indexes for the
// MessageSent). Owned by relayer.ts; injected so returnIn needs no relayer import.
//
// A THROW from this is AMBIGUOUS, not a failure: the relayer may already have broadcast
// the batch (its status poll gives up well before the signed batch's own deadline). The
// caller must therefore never treat a throw as proof the burn didn't happen — see the
// recovery in returnBurnToPool and pendingReturnBurn.ts.
export type SubmitGaslessBatch = (calls: ReturnBurnCall[]) => Promise<string>;

export interface ReturnBurnToPoolArgs {
  // The account whose per-account deposit wallet holds the USDC to return (cross-account guard).
  accountIndex: number;
  // The account CHANNEL the index belongs to (see account-store). Persisted VERBATIM into
  // the resume cursor on the FRESH burn so a later resume/recover re-derives the commitment
  // in the right keyspace. undefined = the default channel. Inert on a resume (no re-write).
  channel?: string;
  // USDC base units (6 dp) to return. Must be > 0.
  amount: bigint;
  // The connected EVM address used to KEY the resume cursor.
  evmAddress: string;
  // The commitment carried in the burn's hookData (deriveInboundCommitment — computed by
  // the returnToPool orchestrator from the signature + accountIndex, so it never needs
  // to be recomputed here). Baked into the burn's hookData (encodeCommitmentHookData)
  // on the FRESH path and persisted into the cursor; unused on a resume (the burn —
  // and its hookData — already landed; the cursor's own `commitment` is authoritative).
  commitment: bigint;
  // The per-account deposit wallet whose USDC is burned (msg.sender of the burn).
  // Required on a FRESH burn (asserted just before building the calls); unused on
  // a resume (the cursor is authoritative), so callers may omit it there.
  depositWallet?: string;
  // The EVM chain the account's funds sit on (where the return burn ORIGINATES).
  // Defaults to config.cctp.defaultDestChainId. Used on the FRESH path to resolve
  // the burn chain's CCTP domain + TokenMessengerV2/USDC; on a RESUME the cursor's
  // persisted sourceDomain/evmChainId are authoritative (the burn already landed).
  destChainId?: number;
  // Injected gasless submitter (relayer pays gas). Required on a FRESH burn; unused
  // on a resume (which does not re-burn).
  submitGaslessBatch?: SubmitGaslessBatch;
  // CCTP finality: 2000 = Standard (default), 1000 = Fast.
  minFinalityThreshold?: number;
  // Per-call CCTP fee cap (0 for Standard).
  maxFee?: bigint;
  onStatus?: (s: string) => void;
}

// What returnBurnToPool hands the orchestrator once the burn is attested: the CCTP
// message/attestation the folded claim needs, plus the source domain (for the claim's
// pre-flight validation) and the burn amount. `alreadyClaimed` is set on a RESUME whose
// CCTP nonce is already consumed — the folded claim (mint inside it) landed on a prior
// run, so the orchestrator must SKIP the claim and clear the cursor (idempotent).
export interface ReturnBurnResult {
  message: `0x${string}`;
  attestation: `0x${string}`;
  sourceDomain: number;
  amount: bigint;
  alreadyClaimed: boolean;
}

// Burns the per-account deposit wallet's `amount` of USDC back to the
// InboundAnonymizer on Starknet via reverse CCTP (hookData = the bound commitment),
// waits for Circle's attestation, and RETURNS the {message, attestation} the folded
// pool claim needs — it NO LONGER submits the mint (that is folded into the proven
// claim). The burn is a GASLESS relayer batch FROM the deposit wallet (the injected
// submitGaslessBatch; the relayer pays Polygon gas, the EOA only signs — no POL
// precondition). Resumable:
//   - valid inflight cursor with a burnTx → RESUME from attest, SKIP the burn
//     (re-burning would double-spend the wallet's USDC in the burn→claim window);
//   - else the FRESH path: pre-flight storage, build + gaslessly submit the burn
//     batch, PERSIST the post-burn cursor BEFORE attest, then attest.
// Leaves the cursor in place on success (the claim stage clears it after the folded
// claim lands). Never mints or claims here.
export async function returnBurnToPool(args: ReturnBurnToPoolArgs): Promise<ReturnBurnResult> {
  const {
    accountIndex,
    channel,
    amount,
    evmAddress,
    commitment,
    depositWallet,
    submitGaslessBatch,
    onStatus,
  } = args;
  const minFinalityThreshold = args.minFinalityThreshold ?? STANDARD_FINALITY;
  const maxFee = args.maxFee ?? 0n;
  // Enforce the fee-free-return invariant before we burn (see assertFeeFreeReturn).
  assertFeeFreeReturn(maxFee, minFinalityThreshold);
  if (amount <= 0n) {
    throw new Error('returnBurnToPool: amount must be greater than zero.');
  }
  // The chain the funds sit on = where the return burn originates. Its CCTP domain
  // is the SOURCE domain of the reverse burn (Polygon 7/Base 6/…). Resolved from the
  // chosen destChainId (fresh path); the resume path uses the cursor's persisted
  // sourceDomain instead (authoritative once the burn has landed).
  const burnChain = resolveEvmCctpDestination(args.destChainId);
  const sourceDomain = burnChain.domain;
  const inbound = config.inboundAnonymizerAddress;

  // Attest → return the {message, attestation} the folded claim needs. Shared by the
  // resume + fresh paths so both behave identically. The cursor is CONSERVATIVELY
  // preserved on any non-success EXCEPT a DEMONSTRABLY-TERMINAL one — mirroring
  // depositIn's clear-on-terminal intent. Only an Iris "attestation failed"/"rejected"
  // status or a CCTP "recipient/domain mismatch" proves the message will never mint to
  // us, so resume can't help → clear. Everything else (slow Iris, a one-off Starknet RPC
  // error, any unclassified throw) PRESERVES the cursor: the burn is replayable forever
  // by its tx hash, so the next run resumes.
  const finishAttest = async (
    burnTx: string,
    record: InflightReturn,
    opts?: { detectAlreadyClaimed?: boolean },
  ): Promise<ReturnBurnResult> => {
    try {
      const { message, attestation } = await waitForAttestation(burnTx, {
        sourceDomain: record.sourceDomain,
        match: returnMessageMatch(record.sourceDomain, record.inboundAnonymizer, record.commitment),
        onStatus,
      });
      // Resume-only: the folded claim (mint INSIDE it) may already have landed on a
      // prior run (nonce consumed) while the cursor lingered (a post-broadcast throw,
      // or a device that never saw the clear). is_nonce_used is monotonic once
      // receive_message lands, so a `true` read PROVES the claim already happened →
      // signal alreadyClaimed so the orchestrator SKIPS the claim (re-proving would
      // waste a proof and the folded receive_message would revert `used_nonce`).
      // Mirrors depositIn.ts's detectAlreadyMinted gate (bug-hunt E1).
      const alreadyClaimed =
        opts?.detectAlreadyClaimed === true && (await isCctpMessageNonceUsed(message));
      return {
        message,
        attestation,
        sourceDomain: record.sourceDomain,
        amount: BigInt(record.amount),
        alreadyClaimed,
      };
    } catch (err) {
      if (isTerminalAttestFailure(err)) {
        clearReturnRecords(evmAddress);
      }
      // Fail-closed: an is_nonce_used RPC failure throws here too, but matches
      // neither TERMINAL regex above, so the cursor is PRESERVED — a read failure
      // proves nothing, so it must never be treated as already-claimed.
      throw err;
    }
  };

  // (0) PENDING-BURN RECOVERY, before anything reads the cursor. A prior run may have
  // SUBMITTED a burn and never learned its outcome (the relayer's status poll timed out /
  // the tab closed), leaving a pending record but no cursor. Resolve it from chain first:
  // if that burn landed it becomes a cursor here and the resume path below picks it up
  // exactly as though we had watched it happen — which is the difference between finishing
  // the return and re-burning an already-empty wallet. Deliberately runs for ANY account
  // index: a landed burn belonging to a DIFFERENT account must reach the cross-account
  // guard below and BLOCK this return, not be skipped so this one can burn over it.
  const promoted = await promoteLandedPendingBurn(evmAddress);
  if (promoted && !promoted.persisted) {
    onStatus?.(
      'WARNING: recovered your in-flight return but could not save the resume point — ' +
        'do NOT reload this tab until it completes.',
    );
  }

  // (1) RESUME PATH: a prior run already burned for this EVM address but didn't
  // finish attest/claim. Resume from attest off the persisted cursor — skip
  // approve+burn entirely (re-burning would double-spend the EOA's USDC). The burn
  // tx AND source domain come from the CURSOR (authoritative on resume).
  //
  // Fall back to the JUST-PROMOTED record when the cursor write missed: the burn is proven
  // and we hold its hash, so re-reading empty storage would throw that away and drop the run
  // onto the unresolved guard — blocking the recovery that just succeeded.
  const inflight = readInflightReturn(evmAddress) ?? promoted?.record ?? null;
  if (inflight) {
    // CROSS-ACCOUNT GUARD (fund-safety): the cursor is keyed by EVM address ONLY,
    // so a resume must verify it belongs to THIS account. Returning account B
    // while account A is mid-CCTP must NOT resume A's burn under B's identity
    // (the orchestrator would then claim against A's message under B's commitment →
    // COMMITMENT_MISMATCH / cross-account claim). If a return for a DIFFERENT account
    // is in flight, refuse — do not resume the wrong one, and do not fall through to a
    // fresh burn (which would clobber A's cursor and orphan A's already-burned funds).
    if (inflight.accountIndex !== accountIndex) {
      throw new Error(
        `A return for account #${inflight.accountIndex} is already in progress for this account — ` +
          `finish or resume it before returning account #${accountIndex}.`,
      );
    }
    onStatus?.('Resuming an in-flight return (already burned)…');
    return finishAttest(inflight.burnTx, inflight, { detectAlreadyClaimed: true });
  }

  // (1b) UNRESOLVED-SUBMISSION GUARD. Step (0) promotes a pending burn once the chain
  // PROVES it landed; a record that survives means the opposite — we still cannot tell
  // whether the deposit wallet's USDC has already gone into CCTP. Falling through to a
  // fresh burn there is precisely the double-burn the pending record exists to prevent
  // (and the wallet often still reads funded, because the first burn hasn't mined yet).
  // Refuse, and say so in words that classify TRANSIENT so the flow ends RESUMABLE rather
  // than as a red terminal card.
  //
  // ACCEPTED COST: a submit the relayer never actually took (rejected credentials, a
  // rate limit) is indistinguishable from one it took and broadcast — the transport reports
  // both as a throw — so it lands here too and holds up a retry. The funds are untouched and
  // visible in the wallet throughout. That is the right direction to be wrong in: the
  // alternative is re-burning funds already committed, which is what stranded a user's
  // return in the first place. A submitter that reported whether the relayer accepted the
  // batch (and its real deadline) would remove this wait entirely.
  //
  // The wait is bounded by isPendingBurnExecutable — the batch's own deadline — NOT by the
  // scan reaching a verdict. That distinction is load-bearing: a record with no block anchor
  // can only ever resolve 'unknown' on a clean no-match, so gating on the scan meant a
  // refused submit blocked every future return for this wallet forever.
  const unresolved = readPendingReturnBurn(evmAddress);
  if (unresolved && isPendingBurnExecutable(unresolved))
    throw unresolvedSubmissionError(unresolved);

  // (2) FRESH PATH. The burn runs GASLESSLY from the deposit wallet via the
  // injected submitter — both it and the deposit wallet are required here.
  if (!submitGaslessBatch || !depositWallet) {
    throw new Error(
      'returnBurnToPool: a fresh return burn needs the deposit wallet + a gasless ' +
        'submitter (no inflight cursor to resume from).',
    );
  }
  // FAIL CLOSED: the default placeholder is the STRING '0x0' (config.ts), not
  // empty — refuse to burn toward an undeployed InboundAnonymizer (would strand
  // the CCTP mint with no way to ever claim it).
  if (!inbound || inbound === '0x0') {
    throw new Error(
      'returnBurnToPool: inboundAnonymizerAddress not configured — the return leg ' +
        'is not deployed yet.',
    );
  }
  // Resolve the EVM Polygon CCTP contracts (TokenMessengerV2 + USDC) from the
  // shared source registry — exactly as depositIn.ts does. The burn executes on
  // POLYGON, so the approve spender / depositForBurn target MUST be the EVM
  // TokenMessengerV2 (source.tokenMessenger), NOT the Starknet TokenMessengerMinter
  // (config.cctp.snTokenMessengerMinter is a felt — wrong chain, would lose funds).
  const source = getEvmCctpSource(burnChain.chainId);
  if (!source) {
    throw new Error(
      `returnIn: no EVM CCTP source configured for chain ${burnChain.chainId} ` +
        `(EVM_CCTP_SOURCES) — cannot resolve the TokenMessengerV2 for the return burn.`,
    );
  }

  // PRE-FLIGHT: before we burn, prove localStorage can persist the resume cursor
  // we'll write right after the burn. If it can't, refuse to burn — a silently-lost
  // cursor means a reload couldn't resume and the wallet could re-burn (double-spend).
  assertStorageWritable(STORAGE_PROBE_KEY, 'a return');

  // Build the burn batch: approve(tokenMessenger, amount) then depositForBurnWithHook
  // toward the INBOUND ANONYMIZER on Starknet (destination = Starknet). Both
  // mintRecipient AND destinationCaller are the inbound contract (the bypass-proof
  // requirement — see snMint.ts:assertReturnCctpMessage), and hookData carries the
  // bound commitment (32-byte big-endian — encodeCommitmentHookData) so the folded pool
  // claim's on-chain COMMITMENT_MISMATCH check (bridgeBack.ts) binds the mint to the
  // signer. The relayer executes both FROM the deposit wallet in one batch (the
  // allowance + transferFrom land in the same tx), so msg.sender/burner is the deposit
  // wallet. The return burn is otherwise fee-free (Standard finality, maxFee 0).
  const inboundBytes32 = snAddressToBytes32(inbound);
  const calls: ReturnBurnCall[] = [
    {
      target: source.usdc,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [source.tokenMessenger as `0x${string}`, amount],
      }),
    },
    {
      target: source.tokenMessenger,
      data: encodeFunctionData({
        abi: TOKEN_MESSENGER_HOOK_ABI,
        functionName: 'depositForBurnWithHook',
        args: [
          amount,
          config.cctp.starknetDomain,
          inboundBytes32,
          source.usdc as `0x${string}`,
          inboundBytes32, // destinationCaller — NOT zero (bypass-proof requirement)
          maxFee,
          minFinalityThreshold,
          encodeCommitmentHookData(commitment),
        ],
      }),
    },
  ];

  // Submit the batch gaslessly — this IS the burn. The returned hash is the on-chain
  // Polygon tx carrying the CCTP MessageSent (fed to waitForAttestation below).
  //
  // AMBIGUITY WINDOW: the relayer accepts the submit and broadcasts asynchronously, so a
  // throw from here does NOT mean the burn didn't happen — the status poll may simply have
  // given up first (it polls for a fraction of the signed batch's own deadline). Historically
  // that threw with nothing persisted, and since fold-only recovery is entirely cursor-driven,
  // the burn (which then landed) became invisible: the wallet read empty on retry and there
  // was no cursor to recover. So on a throw we ASK THE CHAIN instead of guessing.
  //
  // Everything the chain scan needs is already in scope — the deposit wallet that burns, the
  // commitment we wrote into hookData, the amount and the chain — so the pending record is
  // DERIVED here rather than reported by the submitter. That keeps the recovery entirely
  // inside this package: no transport change, and it works with a submitter written before
  // any of this existed.
  onStatus?.('Burning USDC on Polygon (gasless return CCTP)…');
  const submittedAtMs = Date.now();
  // Kick off a chain-head read WITHOUT awaiting it: an exact lower bound for the recovery
  // scan at zero cost on the burn's critical path. Only collected if the submit throws, by
  // which point it resolved long ago. The .catch is attached here (not at the await) so a
  // failure on the happy path can never surface as an unhandled rejection — and a failed
  // read is survivable: the scan falls back to an estimated window that can still PROVE a
  // burn, it just can't prove the absence of one.
  // Anchored on the BURN chain (source), not Polygon: the scan queries that chain, so a
  // height from a different one would be meaningless.
  //
  // BOUNDED, because a LATE answer is worse than none: this read races the submit, so a
  // response that arrives long after the burn mined reports a height past it, and an anchor
  // above the burn makes the window miss it. Dropping a slow read leaves no anchor, which
  // costs only the ability to prove a NEGATIVE (the window becomes estimated) — a strictly
  // safer trade than a confident window in the wrong place. Timing out a read is also safe
  // in a way timing out the submit is not: nothing has moved yet.
  const anchorBlock = readAnchorBlock(evmClientForSource(source));

  let burnTx: string;
  try {
    burnTx = await submitGaslessBatch(calls);
  } catch (err) {
    // The batch's real deadline is the submitter's business, so assume the conservative
    // default: too LONG merely delays a safe retry, while too short would declare a
    // still-mineable batch dead and invite the double-burn.
    const pending: PendingReturnBurn = {
      accountIndex,
      channel,
      depositWallet,
      amount: amount.toString(),
      commitment: commitment.toString(),
      sourceDomain,
      evmChainId: burnChain.chainId,
      inboundAnonymizer: inbound,
      submittedAtMs,
      fromBlock: await anchorBlock,
      deadlineMs: submittedAtMs + DEFAULT_BATCH_DEADLINE_MS,
    };
    // Persist BEFORE scanning: the scan below can take a while, and a tab closed during it
    // must still leave something a later sweep can resolve.
    //
    // Whether that write LANDED changes what we are able to promise. A stored record both
    // resumes the burn later and blocks a second one; without it the next attempt has no
    // guard at all and would take the fresh path while this batch may still be mining. So
    // the outcome is threaded into the error rather than assumed — telling a user "we saved
    // this, just retry" when nothing was saved is what turns a recoverable strand into a
    // double-burn. (The fresh path pre-flights storage before burning, so this is the narrow
    // case of quota being hit between that probe and here.)
    const tracked = writePendingReturnBurn(evmAddress, pending);
    const recovered = await resolveAmbiguousReturnBurn(evmAddress, pending, onStatus);
    if (recovered === null) throw ambiguousBurnError(err, evmAddress, depositWallet, tracked);
    if (recovered === 'never-landed') throw err;
    burnTx = recovered;
    onStatus?.('Found the return burn on-chain — continuing.');
  }

  // FAIL CLOSED on a malformed submitter return (empty/non-0x-hex). The value is
  // persisted VERBATIM into the resume cursor below, and readInflightReturn uses
  // the SAME /^0x[0-9a-fA-F]+$/ check via isValidInflightReturn to DROP corrupt
  // cursors — a write that fails that check is a self-inflicted corruption: on the
  // next call the fresh path would take over and re-burn the wallet's USDC
  // (double-burn). Validate here BEFORE the cursor is written so the failure is a
  // loud throw, never a silent state-machine hole. Mirrors the AVNU code-156
  // lesson (`.claude/rules/code-style.md`): fail closed on no-hash / unknown
  // status; do not persist ambiguous submitter output.
  if (typeof burnTx !== 'string' || !/^0x[0-9a-fA-F]+$/.test(burnTx)) {
    throw new Error(
      `returnBurnToPool: gasless submitter returned an invalid burn tx hash ` +
        `(${JSON.stringify(burnTx)}) — refusing to persist a corrupt resume cursor. ` +
        `Retry the return.`,
    );
  }

  // Persist the resume cursor (post-burn, with the burn tx) BEFORE attest: from here on
  // the funds are committed to CCTP and recovery must RESUME (never re-burn). We
  // pre-flighted storage, but a post-burn write can still fail (quota); if the read-back
  // shows it didn't land, surface a prominent NON-fatal warning so the user doesn't
  // reload + double-burn. We do NOT abort — the burn already committed the funds, and
  // this run can still finish attest + the folded claim.
  const record: InflightReturn = {
    accountIndex,
    burnTx,
    sourceDomain,
    amount: amount.toString(),
    commitment: commitment.toString(),
    evmChainId: burnChain.chainId,
    // Pin the burn-time InboundAnonymizer (mintRecipient/destinationCaller/hookData all
    // reference it) so a resume/recover after a config redeploy claims against the SAME
    // contract the burn targeted — not the new config address.
    inboundAnonymizer: inbound,
    // Pin the channel so a resume/recover re-derives the commitment in the SAME keyspace
    // the burn bound (recoverBridgeIn/scanUnclaimedReturns read it and self-route). Omitted
    // key on default-channel cursors (undefined) keeps them byte-identical to pre-channel.
    channel,
  };
  if (!writeInflightReturnVerified(evmAddress, record)) {
    onStatus?.(
      'WARNING: could not save the return resume point — do NOT reload this tab until the return completes.',
    );
  } else {
    // The cursor now carries everything the pending record was insuring against, so retire
    // it. Only on a VERIFIED cursor write: if that write was the thing that failed, the
    // pending record is the sole remaining handle on an already-committed burn, and dropping
    // it here would recreate exactly the strand this whole mechanism exists to prevent.
    clearPendingReturnBurn(evmAddress);
  }

  // Attest (Iris is keyed by the Polygon SOURCE domain) and return the {message,
  // attestation} for the folded claim. Same path the resume branch takes, so a fresh and
  // a resumed return finish identically. The orchestrator runs the folded claim next; the
  // cursor stays in place until that claim lands (the claim stage clears it).
  return finishAttest(burnTx, record);
}

// ---------------------------------------------------------------------------
// returnToPool — compose returnBurnToPool + the folded claim behind ONE return
// orchestrator that owns the inflight-return cursor TRUST + ALL the sequencing
// (Slice G, Decision 7). Since the mint is folded
// INTO the claim, the sequence is just: burn → attest (returnBurnToPool) → prove+submit
// the folded claim (buildAndProveClaim + submitProvenClaim). There is no separate mint,
// no credit-settle gate, and (because the proof commits the CCTP message) no
// build-concurrently-with-attestation overlap.
// This replaces the H/claim-secret sequencing that lived inline in the app's
// ReturnContext.runReturnToPool: the app now derives NO account-nonce / claim-secret
// / commitment H and calls NO anonymizer builder — it passes the raw signature +
// accountIndex, and injects the two Polymarket-coupled pieces:
//   - prepareFreshReturn(): convert the deposit wallet's proceeds to native USDC +
//     size the burn to the actual balance + build the gasless submitter (called ONLY
//     on the FRESH path, after the cross-account guard + stale re-validation);
//   - readReturnableBalance(): the live returnable USDC on the deposit wallet, for
//     the stale-cursor re-validation.
// The account-nonce / commitment are derived INTERNALLY from the signature and
// NEVER logged/persisted (Decision 5).
// ---------------------------------------------------------------------------

// The Leg-A stages a UI renders as a progress tracker (still two steps for UX — the
// mint now lives inside the claim step, not a step of its own):
//   cctp  = reverse-CCTP burn → attest (returnBurnToPool)
//   claim = the proven pool tx (ComputeAndInvoke) that MINTS (receive_message, folded)
//           + hands the minted USDC into a fresh open note
export type ReturnStep = 'cctp' | 'claim';
export type ReturnStepStatus = 'pending' | 'running' | 'done' | 'error';

// The Polymarket-coupled FRESH-return prep the app injects (kept out of core — the
// proceeds conversion + balance sizing + gasless transport are Polymarket/relayer
// concerns). Returns the sized burn amount, the deposit wallet whose USDC burns, and
// the gasless submitter. May THROW (e.g. "nothing to return") to abort before burning.
export interface FreshReturnPlan {
  amount: bigint;
  depositWallet: string;
  submitGaslessBatch: SubmitGaslessBatch;
}

export interface ReturnToPoolArgs {
  // EVM wallet signature of the app's identity sign-message — the only secret input;
  // re-derives the viewing key → account nonce → bound commitment internally
  // (in-memory only, never logged/persisted).
  signature: string;
  // The account whose per-account deposit wallet holds the USDC to return.
  accountIndex: number;
  // The account CHANNEL (see account-store) the accountIndex belongs to. The caller
  // MUST pass the SAME channel used at fund time so the nonce/commitment re-derived
  // here matches what was bound on-chain (else COMMITMENT_MISMATCH → unclaimable).
  // undefined = the default channel. Sourced from the account's channel-namespaced record.
  channel?: string;
  // The connected EVM address that KEYS the resume cursor.
  evmAddress: string;
  // Injected FRESH-path prep (convert proceeds → native USDC, size the burn, build
  // the gasless submitter). Called ONLY when a fresh burn is needed — i.e. no
  // resumable cursor survives the cross-account guard + stale re-validation. Keeps
  // bridge-core Polymarket-free.
  prepareFreshReturn: () => Promise<FreshReturnPlan>;
  // Injected live returnable-balance reader for the stale-cursor re-validation. Compared
  // as a DELTA against the cursor's frozen amount (NOT `> 0`): the FULL frozen amount still
  // returnable ⇒ the burn never landed ⇒ drop the cursor + take the fresh path (re-size +
  // re-burn) rather than "complete" for ~0 and STRAND the funds; a smaller reading is
  // leftover pUSD/USDC.e dust after a real burn ⇒ trust the post-burn cursor and resume.
  // Optional: omit ⇒ trust the cursor (today's behavior when the wallet address can't be
  // resolved).
  readReturnableBalance?: () => Promise<bigint>;
  // Fires only when the stale-cursor re-validation actually dropped a cursor (balance says
  // never burned AND the chain has no such burn). Never fires on a preserved cursor.
  onStaleCursorCleared?: () => void;
  // The EVM chain the account's funds sit on (where the return burn originates).
  // Defaults to config.cctp.defaultDestChainId. Threaded to returnBurnToPool's fresh
  // burn; a resume uses the cursor's persisted chain. The bound commitment is
  // UNCHANGED by this choice (it commits only identity_key/dapp_name/nonce — the
  // destination chain is not part of it).
  destChainId?: number;
  // CCTP finality for the fresh burn: 2000 = Standard (default), 1000 = Fast.
  minFinalityThreshold?: number;
  // Per-call CCTP fee cap (0 for the fee-free return burn).
  maxFee?: bigint;
  // Fires (step,'running') before each leg and (step,'done'|'error') after; the app
  // maps these to its Step/StepStatus UI. Presentation only — no window here.
  onStep?: (step: ReturnStep, status: ReturnStepStatus, detail?: string) => void;
}

export interface ReturnToPoolResult {
  // The amount that actually burned/claimed (fresh: the sized balance; resume:
  // the cursor's frozen amount). 0 when the resume found nothing left to claim
  // (already claimed from another device).
  amountReturned: bigint;
  // The proven claim tx that landed the funds back in the pool. EMPTY when the
  // resume found the slot already drained (no tx was sent this run).
  claimTxHash: string;
  // True when this run ran a FRESH burn (vs an attest-only / claim-only resume); the
  // app uses it only for presentation.
  ranFreshBurn: boolean;
  // True when the resume found the CCTP nonce already consumed — the folded claim (mint
  // inside it) landed on a prior run/device, so the return is ALREADY COMPLETE and this
  // run moved no new value (amountReturned 0 / empty tx). Distinct from a partial return:
  // the app must promote the bid to 'claimed' on this signal EVEN IF leftover pUSD/USDC.e
  // dust keeps the wallet's returnable sum > 0 (the drain re-read alone can't tell the two
  // apart). False on a normal fresh/resume completion.
  alreadyClaimed: boolean;
}

// Return a per-account deposit wallet's leftover USDC back INTO the privacy pool
// (Leg A): CCTP burn + attest (returnBurnToPool) → FOLDED proven claim
// (buildAndProveClaim → submitProvenClaim; mint + claim atomic), owning the
// inflight-return cursor's trust. Resumable / fund-safe:
//   - cross-account guard: a cursor for a DIFFERENT account refuses (never claim
//     against another account's burn under this identity);
//   - stale re-validation: if the wallet still holds returnable USDC the burn never
//     landed → drop the stale cursor + take the fresh path;
//   - resume with a consumed CCTP nonce: the folded claim already landed → skip the
//     claim (returnBurnToPool signals alreadyClaimed) and clear the cursor;
//   - fresh: prepareFreshReturn() sizes + burns, then claims.
// The cursor is CLEARED after the claim (the claim stage is its documented owner).
export async function returnToPool(args: ReturnToPoolArgs): Promise<ReturnToPoolResult> {
  const {
    signature,
    accountIndex,
    channel,
    evmAddress,
    prepareFreshReturn,
    readReturnableBalance,
    onStaleCursorCleared,
    destChainId,
    onStep,
  } = args;
  const minFinalityThreshold = args.minFinalityThreshold ?? STANDARD_FINALITY;
  const maxFee = args.maxFee ?? 0n;
  // Enforce the fee-free-return invariant up front (see assertFeeFreeReturn) so a
  // fee-bearing config fails loud here rather than under-minting the claim later.
  assertFeeFreeReturn(maxFee, minFinalityThreshold);
  const emit = (step: ReturnStep, status: ReturnStepStatus, detail?: string): void =>
    onStep?.(step, status, detail);

  // FAIL CLOSED, as early as possible: the default placeholder is the STRING '0x0'
  // (config.ts), not empty — refuse the WHOLE return before touching the wallet if
  // the InboundAnonymizer isn't deployed yet (returnBurnToPool/buildAndProveClaim
  // re-check this at their own call sites too — defense in depth, not redundant: this is
  // the fast, no-side-effect fail before anything is derived or burned).
  if (!config.inboundAnonymizerAddress || config.inboundAnonymizerAddress === '0x0') {
    const err = new Error(
      'returnToPool: inboundAnonymizerAddress not configured — the return leg is not deployed yet.',
    );
    emit('cctp', 'error', err.message);
    throw err;
  }

  // Recover the account keys (in-memory only — never log the viewing key / private
  // key). The nonce depends only on the account index; it is BOTH the `nonce`
  // compute_additional_data arg at claim time AND (via deriveInboundCommitment) the
  // input that derives the commitment carried in the burn's hookData — so both legs
  // reference the SAME commitment (COMMITMENT_MISMATCH otherwise).
  const viewingKey = deriveViewingKey(signature);
  const accountNonce = deriveAccountNonce(viewingKey, accountIndex, channel);
  const snPrivateKey = deriveStarknetPrivateKey(signature);
  const { address: snAddress } = deriveStarknetAccount(snPrivateKey, config.ozClassHash);
  // userPrivateKey MUST be the VIEWING key, not the Starknet account key: the
  // pool's claim-time recompute takes `user_private_key` from the PROVEN pool
  // identity, and the SDK's pool identity key IS the viewing key (SDK
  // compiler.ts createPool(userViewingKey); register stores the viewing pubkey).
  // Binding with any other key derives a commitment no pool identity can ever recompute
  // — COMMITMENT_MISMATCH at claim time, funds unclaimable (live-verified on mainnet,
  // PR #350).
  // The commitment now also binds the CCTP SOURCE domain the burn originates from
  // (resolveEvmCctpDestination(destChainId).domain — the SAME value returnBurnToPool
  // uses at line ~428 and that the folded claim feeds privacy_compute as source_domain
  // via burnResult.sourceDomain). Fresh path only: on resume the burn is skipped and
  // this commitment is inert (the claim recomputes with the cursor's sourceDomain).
  const sourceDomain = resolveEvmCctpDestination(destChainId).domain;
  const commitment = deriveInboundCommitment({
    userAddr: BigInt(snAddress),
    userPrivateKey: viewingKey,
    inboundAddr: BigInt(config.inboundAnonymizerAddress),
    sourceDomain,
    nonce: accountNonce,
  });

  // 0. PENDING-BURN RECOVERY, before the fresh-vs-resume decision is made.
  //
  // This MUST run here and not only inside returnBurnToPool. The fresh branch below calls
  // prepareFreshReturn FIRST, and after the incident this fixes (the burn mined, the wallet
  // is empty, no cursor was ever written) that prep throws "nothing to return" — so the run
  // would die before reaching returnBurnToPool's own recovery, and the retry the user is
  // told to make would strand the funds exactly as before. Promoting here turns a proven
  // burn into a cursor, so the resume branch takes it.
  const promoted = await promoteLandedPendingBurn(evmAddress);
  if (promoted && !promoted.persisted) {
    emit(
      'cctp',
      'running',
      'WARNING: recovered your in-flight return but could not save the resume point — ' +
        'do NOT reload this tab until it completes.',
    );
  }

  // 1. CCTP stage (reverse-CCTP burn → attest). The cursor (migrate-on-read +
  // corrupt-drop via readInflightReturn) is the source of truth — falling back to the
  // just-promoted record when its write missed, so a storage failure can't discard a burn
  // we have already PROVEN on-chain and push the run onto the fresh path's guard.
  let cursor = readInflightReturn(evmAddress) ?? promoted?.record ?? null;

  // CROSS-ACCOUNT GUARD (fund-safety): the cursor is keyed by EVM address only. If a
  // return for a DIFFERENT account is already in flight, refuse — resuming it under this
  // identity would attest another account's burn and then prove THIS commitment against
  // it (COMMITMENT_MISMATCH / cross-account claim / stranding). The account identity is
  // (channel, accountIndex): a DIFFERENT channel at the same index is a different wallet +
  // commitment, so it must refuse too (both undefined = the default channel). Runs BEFORE
  // the stale re-validation so the balance probe (which reads THIS account's wallet) never
  // decides another account's cursor is stale.
  if (cursor && (cursor.accountIndex !== accountIndex || cursor.channel !== channel)) {
    const cursorLabel = cursor.channel
      ? `${cursor.channel} #${cursor.accountIndex}`
      : `#${cursor.accountIndex}`;
    const requestedLabel = channel ? `${channel} #${accountIndex}` : `#${accountIndex}`;
    const err = new Error(
      `A return for account ${cursorLabel} is already in progress — ` +
        `finish or resume it before returning account ${requestedLabel}.`,
    );
    emit('cctp', 'error', err.message);
    throw err;
  }

  // STALE-CURSOR RE-VALIDATION (fund-safety): reset the cursor ONLY when the burn
  // genuinely never moved the funds — i.e. the FULL frozen `amount` is still returnable.
  // A cursor is ALWAYS written POST-BURN (returnBurnToPool persists it only after the burn
  // tx lands, and isValidInflightReturn requires a burnTx), so a persisted cursor ⟺ the
  // CCTP burn committed. The return burns only NATIVE USDC, so after a real burn native
  // ≈ 0 while leftover pUSD/USDC.e dust can keep the injected returnable SUM positive — a
  // `> 0` absolute check would WRONGLY drop a valid post-burn cursor (losing its burnTx →
  // the in-flight CCTP return is hard to resume/recover). Gate on a DELTA vs the frozen
  // amount, not an absolute read: dust (remaining < frozen) means the burn landed → trust
  // the cursor and resume; only "funds still fully present" (remaining ≈ the frozen amount,
  // within a small dust tolerance) proves a never-committed burn worth resetting.
  //
  // SKIPPED for a cursor promoted THIS run: that one carries an on-chain DepositForBurn we
  // just matched on our own commitment, which is direct proof the burn committed. This check
  // is a balance HEURISTIC, and its input is exactly the read most likely to lag moments
  // after a burn mines — so letting it overrule the proof would drop a cursor we know is
  // good and send the run to the fresh path against a stale balance.
  //
  // SKIPPED for a `proven` cursor — recovery wrote it off the same on-chain proof. Otherwise
  // the balance verdict is not final on its own (a second sale's proceeds can land at ≈ the
  // frozen amount), so a would-be clear first chain-verifies the cursor's own burn. An
  // unverifiable read keeps the cursor and fails transient, never the re-burning path.
  if (cursor && readReturnableBalance && !promoted && cursor.proven !== true) {
    const remaining = await readReturnableBalance();
    const frozen = BigInt(cursor.amount);
    if (remaining + STALE_RETURN_DUST_TOLERANCE >= frozen) {
      const verdict = await verifyCursorBurnOnChain(cursor);
      if (verdict === 'unsupported-chain') {
        const err = markNonRetryable(
          new Error(
            `Cannot verify the in-flight return burn: EVM chain ${cursor.evmChainId} is not supported by this build. ` +
              'Your resume point is kept, but retrying will not help — contact support.',
          ),
        );
        emit('cctp', 'error', err.message);
        throw err;
      }
      if (verdict === 'unknown') {
        // Worded to satisfy isTransientError: the consumer branches on it to show the
        // resumable "your funds are safe" card instead of a hard failure.
        const err = new Error(
          'Could not verify the in-flight return burn on chain — verification is temporarily unavailable. ' +
            'Your resume point is kept; try again in a moment.',
        );
        emit('cctp', 'error', err.message);
        throw err;
      }
      if (verdict === 'not-found') {
        clearInflightReturn(evmAddress);
        cursor = null;
        try {
          onStaleCursorCleared?.();
        } catch {
          // A consumer's bookkeeping must not strand the fresh path behind an already-done clear.
        }
      }
    }
  }

  let amount: bigint;
  let ranFreshBurn = false;
  let burnResult: ReturnBurnResult;

  if (cursor) {
    // RESUME PATH: this account's cursor is authoritative for the amount. returnBurnToPool
    // resumes from attest off the cursor (no depositWallet/submitter — re-burning would
    // double-spend the wallet's USDC) and detects an already-consumed CCTP nonce.
    amount = BigInt(cursor.amount);
    emit('cctp', 'running', 'Resuming an in-flight return…');
    try {
      burnResult = await returnBurnToPool({
        accountIndex,
        channel,
        amount,
        evmAddress,
        commitment,
        minFinalityThreshold,
        maxFee,
        onStatus: (m) => emit('cctp', 'running', m),
      });
    } catch (err) {
      emit('cctp', 'error', err instanceof Error ? err.message : String(err));
      throw err;
    }
    emit('cctp', 'done', 'USDC returned to the pool.');
  } else {
    // A submission that step 0 could NOT resolve means we still don't know whether the
    // wallet's USDC is already in CCTP. Refuse before the prep runs: it converts balances
    // and marks the account as returning, which is misleading work to do for a burn we may
    // be about to refuse anyway (returnBurnToPool guards again, but only after all of it).
    const unresolved = readPendingReturnBurn(evmAddress);
    if (unresolved && isPendingBurnExecutable(unresolved)) {
      const err = unresolvedSubmissionError(unresolved);
      emit('cctp', 'error', err.message);
      throw err;
    }

    // FRESH PATH: the app-injected prep converts proceeds → native USDC, sizes the
    // burn to the actual balance, and builds the gasless submitter. It may throw
    // (e.g. "nothing to return") to abort before any burn.
    emit('cctp', 'running');
    let plan: FreshReturnPlan;
    try {
      plan = await prepareFreshReturn();
    } catch (err) {
      emit('cctp', 'error', err instanceof Error ? err.message : String(err));
      throw err;
    }
    amount = plan.amount;
    if (amount <= 0n) {
      const err = new Error(
        "No returnable USDC on this account's deposit wallet — nothing to return.",
      );
      emit('cctp', 'error', err.message);
      throw err;
    }
    ranFreshBurn = true;
    emit('cctp', 'running', 'Returning USDC via CCTP…');
    try {
      burnResult = await returnBurnToPool({
        accountIndex,
        channel,
        amount,
        evmAddress,
        commitment,
        depositWallet: plan.depositWallet,
        submitGaslessBatch: plan.submitGaslessBatch,
        destChainId,
        minFinalityThreshold,
        maxFee,
        onStatus: (m) => emit('cctp', 'running', m),
      });
    } catch (err) {
      emit('cctp', 'error', err instanceof Error ? err.message : String(err));
      throw err;
    }
    emit('cctp', 'done', 'USDC returned to the pool.');
  }

  // ALREADY-CLAIMED short-circuit: the resume found the CCTP nonce consumed, so the
  // folded claim (mint inside it) landed on a prior run/device. Nothing left to do —
  // clear the cursor and finish without a claim (amount 0 / empty tx signals "no new
  // value moved this run" to ReturnContext, which gates its History write on > 0).
  if (burnResult.alreadyClaimed) {
    clearReturnRecords(evmAddress);
    emit('claim', 'done', 'Already claimed into the pool (from another run/device).');
    return { amountReturned: 0n, claimTxHash: '', ranFreshBurn, alreadyClaimed: true };
  }

  // 2. CLAIM — the FOLDED proven pool tx (ComputeAndInvoke): it MINTS (receive_message)
  //    + hands the minted USDC into a fresh open note, atomically. Build the proof NOW
  //    (it commits the CCTP message from returnBurnToPool — no build-before-attestation
  //    overlap) then submit. A transient here is resumable: a reverted claim consumes NO
  //    CCTP nonce (mint folded in reverts too), so the cursor stays and a resume replays.
  emit('claim', 'running', 'Claiming back into the pool…');
  // Target the BURN-TIME InboundAnonymizer: on a RESUME the cursor pins the address the
  // burn was built against (mintRecipient/destinationCaller/hookData commitment), so a
  // mid-return config redeploy still claims against the contract that holds the CCTP funds
  // (and whose on-chain recompute reproduces the burn's commitment). On the FRESH path the
  // cursor is null ⇒ current config (the same address the just-run burn used). An old
  // cursor without the field falls back to config (correct unless the address has changed).
  const claimInbound = cursor?.inboundAnonymizer ?? config.inboundAnonymizerAddress;
  let claimTxHash: string;
  try {
    const proven = await buildAndProveClaim({
      signature,
      accountIndex,
      accountNonce,
      message: burnResult.message,
      attestation: burnResult.attestation,
      sourceDomain: burnResult.sourceDomain,
      inbound: claimInbound,
      onStatus: (m) => emit('claim', 'running', m),
    });
    claimTxHash = await submitProvenClaim(proven);
  } catch (err) {
    emit('claim', 'error', err instanceof Error ? err.message : String(err));
    throw err;
  }
  emit('claim', 'done', 'Claimed back into the pool.');

  // Success: the claim landed. Retire both records (the claim stage owns their lifetime).
  clearReturnRecords(evmAddress);
  return { amountReturned: amount, claimTxHash, ranFreshBurn, alreadyClaimed: false };
}

// ---------------------------------------------------------------------------
// recoverBridgeIn — rescue a return that BURNED but whose FOLDED claim never landed
// (tab close / error / interrupted). Fold-only recovery is CURSOR-DRIVEN: the folded
// claim needs the CCTP message/attestation, obtainable ONLY from the persisted burn tx
// via Iris — there is no on-chain per-commitment ledger to scan cross-device anymore. So
// this recovers on the device that holds the burn cursor. Idempotent + fund-safe:
//   - match THIS identity's cursor by commitment (re-derived from signature + accountIndex +
//     the cursor's OWN channel — self-routing, so a channel-blind caller like
//     resumeBridgeTransfer recovers a channel's return without knowing its channel);
//   - re-fetch the attestation (idempotent on burnTx);
//   - CCTP nonce consumed ⟺ the folded claim already landed → clear + no-op;
//   - else run the SAME folded claim as returnToPool. A reverted claim consumes no nonce,
//     so a retry replays safely.
// ---------------------------------------------------------------------------
export interface RecoverBridgeInArgs {
  // EVM wallet signature of the app's identity sign-message (in-memory only, never logged).
  signature: string;
  // Non-secret per-account index → the deterministic per-return nonce/commitment. The
  // CHANNEL is NOT an arg: it is read from each cursor (record.channel) and folded into
  // the re-derived commitment per-cursor (self-routing), so this recovers a channel's
  // return without the caller supplying the channel.
  accountIndex: number;
  onStatus?: (s: string) => void;
}

export interface RecoverBridgeInResult {
  // The burned amount recovered this run (the cursor's frozen amount), or 0 when nothing
  // was recoverable (no cursor for this identity on this device) / already claimed.
  stuck: bigint;
  // Set when stuck > 0 and the recovery claim was submitted.
  claimTxHash?: string;
}

export async function recoverBridgeIn(args: RecoverBridgeInArgs): Promise<RecoverBridgeInResult> {
  const { signature, accountIndex, onStatus } = args;

  const inbound = config.inboundAnonymizerAddress;
  if (!inbound || inbound === '0x0') {
    throw new Error(
      'recoverBridgeIn: inboundAnonymizerAddress not configured — nothing to recover.',
    );
  }

  // Recover the identity keys (in-memory only; never log them). userPrivateKey MUST be the
  // VIEWING key — the pool's proven identity key (see returnToPool's bind-time comment).
  onStatus?.('Recovering keys…');
  const viewingKey = deriveViewingKey(signature);
  const snPrivateKey = deriveStarknetPrivateKey(signature);
  const { address: snAddress } = deriveStarknetAccount(snPrivateKey, config.ozClassHash);

  // Find this identity's post-burn cursor by re-deriving the commitment the burn carried in
  // its hookData and matching it (proves ownership without the EVM address). The commitment
  // binds the burn-time InboundAnonymizer address, so re-derive with EACH cursor's OWN
  // stored `inboundAnonymizer` (fallback config for pre-redeploy cursors) — matching against
  // a single current-config derivation would MISS a cursor whose burn predates a config
  // redeploy (its funds sit on the OLD contract and would be reported "nothing to recover").
  // No match → nothing to recover on this device (fold-only recovery cannot reconstruct the
  // CCTP message cross-device).
  onStatus?.('Checking for a recoverable return…');
  const found =
    listInflightReturns().find(({ record: rec }) => {
      const recInbound = rec.inboundAnonymizer ?? inbound;
      let expected: bigint;
      try {
        // Re-derive the nonce with the cursor's OWN channel (self-routing — a channel-blind
        // caller need not know it), exactly as the burn bound it. undefined = default. A
        // corrupt channel throws in deriveAccountNonce and skips this cursor (no match).
        const nonce = deriveAccountNonce(viewingKey, accountIndex, rec.channel);
        expected = deriveInboundCommitment({
          userAddr: BigInt(snAddress),
          userPrivateKey: viewingKey,
          inboundAddr: BigInt(recInbound),
          // The commitment binds the burn-time source domain, so match against the
          // cursor's OWN persisted sourceDomain (authoritative once the burn landed).
          sourceDomain: rec.sourceDomain,
          nonce,
        });
      } catch {
        return false;
      }
      return rec.commitment === expected.toString();
    }) ?? null;
  if (!found) {
    onStatus?.('Nothing to recover — no in-flight return for this account on this device.');
    return { stuck: 0n };
  }
  const { evmAddress, record } = found;
  // The claim's compute_additional_data nonce MUST reproduce the cursor's bound commitment,
  // so derive it with the found cursor's OWN channel (the same one the match above used).
  const accountNonce = deriveAccountNonce(viewingKey, accountIndex, record.channel);

  // Re-fetch the attestation (idempotent on burnTx). A demonstrably-terminal attestation
  // failure clears the cursor (the message will never mint to us); anything else PRESERVES
  // it (the burn is replayable forever by its tx hash).
  let message: `0x${string}`;
  let attestation: `0x${string}`;
  try {
    ({ message, attestation } = await waitForAttestation(record.burnTx, {
      sourceDomain: record.sourceDomain,
      match: returnMessageMatch(record.sourceDomain, record.inboundAnonymizer, record.commitment),
      onStatus,
    }));
  } catch (err) {
    if (isTerminalAttestFailure(err)) clearReturnRecords(evmAddress);
    throw err;
  }

  // Already claimed? A consumed CCTP nonce PROVES the folded claim (mint inside it)
  // landed — clear the stale cursor and no-op (a read FAILURE throws above and preserves
  // the cursor, so it is never mistaken for already-claimed).
  if (await isCctpMessageNonceUsed(message)) {
    clearReturnRecords(evmAddress);
    onStatus?.('Nothing stuck — already claimed.');
    return { stuck: 0n };
  }

  // Burned but unclaimed → run the (idempotent) folded claim, then clear the cursor.
  const amount = BigInt(record.amount);
  onStatus?.(`Recovering ${amount} — claiming into the pool…`);
  const { claimTxHash } = await claimToPool({
    signature,
    accountIndex,
    accountNonce,
    message,
    attestation,
    sourceDomain: record.sourceDomain,
    // Target the BURN-TIME InboundAnonymizer (cursor-pinned) so a config redeploy since the
    // burn doesn't send the claim to the wrong contract; fallback config for old cursors.
    inbound: record.inboundAnonymizer ?? inbound,
    onStatus,
  });
  clearReturnRecords(evmAddress);
  return { stuck: amount, claimTxHash };
}
