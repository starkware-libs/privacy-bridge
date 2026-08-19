// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Pending return-burn record — the SUBMITTED-but-unconfirmed half of the return leg.
//
// WHY THIS EXISTS. The return burn is a gasless relayer batch (returnIn.ts's injected
// submitGaslessBatch). The relayer accepts the submit and only LATER reports the mined tx
// hash. If the client stops observing before that hash arrives — the relayer's status poll
// times out, its status GET throws, the tab closes — the submitter throws and returnIn's
// post-burn cursor (written only once a hash exists) is NEVER WRITTEN. The batch then mines
// anyway: the USDC leaves the deposit wallet into CCTP, and because the fold-only recovery
// model is entirely CURSOR-DRIVEN (unclaimedReturns.ts), there is nothing left on the device
// that knows a burn happened. A retry reads an empty wallet ("nothing to return"), a reload
// finds no cursor ("nothing to recover"), and the funds sit burned-but-unclaimed forever.
//
// So: on a throw, record what we already know and resolve it from chain. A landed burn is
// discoverable — it emits DepositForBurn on the source TokenMessengerV2, and its hookData
// carries our own commitment, which binds the event to THIS identity + account index
// unambiguously. Everything that lookup needs is in returnBurnToPool's own arguments, so
// this needs no cooperation from the transport.
//
// WHY A SEPARATE STORE (not a widened InflightReturn). The cursor's invariant — it exists
// ⟺ the burn LANDED, so resume from attest and never re-burn — is load-bearing for the
// double-burn doctrine. A record that means "maybe burned" cannot share that key without
// making every existing reader (resume, recoverBridgeIn, scanUnclaimedReturns, the app's
// in-flight checks) re-decide what the cursor means. This store is purely ADDITIVE: nothing
// that exists today reads it, so it cannot regress the burn/resume state machine. The
// resolver PROMOTES a pending record into a real cursor only once the burn is PROVEN
// on-chain, at which point the existing resume path takes over unchanged.
//
// BOTH FAILURE DIRECTIONS ARE BOUNDED (the bar this repo sets for persisting a fact):
//   - LOSS of a pending record ⇒ exactly today's behavior (a stranded burn). Never worse.
//   - STALENESS (a record whose batch never ran) ⇒ the scan finds no match and, past the
//     deadline, resolves 'never-landed' and clears it. Until then the record DOES hold up a
//     fresh return — deliberately, since that is the double-burn window — so staleness costs
//     a bounded wait, never a wrong value. A record never redirects funds: it can only be
//     promoted to a cursor by a burn PROVEN on-chain.
//
// THE DEADLINE IS WHAT MAKES 'never-landed' DEFINITIVE. The relayer batch is an EIP-712
// struct whose `deadline` field the deposit wallet enforces on-chain, so past that
// timestamp the batch can never execute. That converts the permanently-unsafe "do NOT
// retry, we can't tell" into a bounded question with a real answer.
import { createPublicClient, http, type PublicClient, type Abi } from 'viem';

import { config, getEvmCctpSource, type EvmCctpSource } from './config.js';
import { encodeCommitmentHookData } from '../derivation/index.js';

// TokenMessengerV2 DepositForBurn — the on-chain proof that a submitted batch executed.
// Mirrors depositIn.ts's copy (same event, same indexing: burnToken, depositor,
// minFinalityThreshold). Also the ABI returnIn's burn-receipt verification decodes with.
export const TOKEN_MESSENGER_EVENT_ABI = [
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

// Grace added to the batch deadline before a no-match scan is called 'never-landed'.
// Covers clock skew between the browser (which stamped the deadline) and the chain, plus
// the lag between a block being mined and a public RPC serving its logs. Erring long is
// free — the only cost of waiting is a later retry — while erring short would tell a user
// "safe to retry" while their burn is still mineable, which is the double-burn we are
// here to prevent.
export const PENDING_BURN_DEADLINE_GRACE_MS = 120_000;

// The burn can only execute between the submit and the batch deadline, so the scan window
// is that span — NOT "everything since the submit". That is what keeps the window a constant
// ~10 minutes of blocks no matter how old the record is: a week-old record scans the same
// span, just further back. The provider's range cap is handled separately, by chunking the
// window; this bound is what keeps the CHUNK COUNT constant instead of growing with age.
//
// Sized against the FASTEST plausible EVM block time rather than a per-chain table: over-
// estimating the block count only widens a window that is already bounded, whereas
// under-estimating would cut the window short and miss the burn — the one wrong answer that
// actually loses money. 0.25s covers Arbitrum; Polygon/Base (~2s) land well inside it.
const FASTEST_BLOCK_TIME_MS = 250;

// Extra blocks on each side, absorbing clock skew and block-time variance.
const SCAN_MARGIN_BLOCKS = 600n;

// Floor on the walk's call budget, which the reach requirement raises when the cap is narrow.
// Running out of budget before reaching back past the submit means absence is NOT established
// and the result must be 'unknown' — the walk's whole purpose is that a negative answer is
// earned, never assumed.
export const FALLBACK_MAX_CHUNKS = 12;

// Ceiling on the submit→deadline span the window is sized from. That span comes off a
// PERSISTED record, and it is the only thing bounding how many chunks the anchored window
// costs — so a record carrying an implausible deadline (corrupted, or written by a future
// version with a different batch lifetime) must not be able to widen it into a scan that never
// finishes. Comfortably above any real relayer batch deadline.
const MAX_DEADLINE_SPAN_MS = 30 * 60_000;

// Blocks a time span can cover, floored at the FASTEST plausible block time. Over-counting
// only widens an already-bounded window; under-counting cuts it short and misses the burn.
export function blocksForSpanMs(spanMs: number): bigint {
  return BigInt(Math.ceil(spanMs / FASTEST_BLOCK_TIME_MS));
}

// The widest block span in which a return burn for a given intent can still execute, counted
// FORWARD from the intent's own block.
//
// Sized off MAX_DEADLINE_SPAN_MS rather than the default batch deadline. That constant exists
// above as a ceiling on a span read from a persisted record, so using it as the nominal window
// is a repurposing — licensed by the very property its comment claims: "comfortably above any
// real relayer batch deadline". A window narrower than some future relayer's deadline would
// hide a burn that DID land, and a hidden burn plus fresh proceeds on the wallet reads as
// "never burned" — the one wrong answer that burns twice. Margins on both sides absorb clock
// skew and block-time variance, exactly as searchExactWindow applies them.
export const DEADLINE_WINDOW_BLOCKS =
  blocksForSpanMs(MAX_DEADLINE_SPAN_MS) + SCAN_MARGIN_BLOCKS * 2n;

// SELF-CONTAINED like INFLIGHT_RETURN_KEY: device-store (T5) references only the KEY.
export const PENDING_RETURN_BURN_KEY = 'pmp.pendingReturnBurn';

export interface PendingReturnBurn {
  accountIndex: number;
  // The account CHANNEL, carried for the same reason InflightReturn carries it: the
  // commitment binds it, so a promotion must write it through to the cursor verbatim.
  channel?: string;
  // The burner (DepositForBurn.depositor) — the RPC-side filter for the scan. Per-bid, so
  // it narrows the log query to this one return's wallet.
  depositWallet: string;
  amount: string; // bigint serialized as a decimal string
  // The commitment carried in the burn's hookData (decimal-encoded felt). This is the
  // match key: hookData == encodeCommitmentHookData(commitment) proves the event is OUR
  // burn for THIS account index, not merely a burn from the same wallet.
  commitment: string;
  sourceDomain: number;
  evmChainId: number;
  // The InboundAnonymizer the burn was BUILT AGAINST — promoted verbatim into the cursor
  // so a claim after a config redeploy still targets the burn-time contract.
  inboundAnonymizer: string;
  // When the batch was submitted (unix ms). Bounds the scan window together with
  // deadlineMs, and drives the fallback window when fromBlock is absent.
  submittedAtMs: number;
  // Chain head just before the submit — the EXACT lower bound for the scan, read off the
  // hot path (kicked off un-awaited before submitting, collected only if the submit throws).
  // Decimal-encoded bigint.
  //
  // OPTIONAL because that read can fail. Its presence is what makes a no-match CONCLUSIVE:
  // with an exact anchor we know we looked in the right place, so past the deadline a clean
  // scan proves the funds never moved. Without one the window is estimated, so a match still
  // proves a burn but a NO-match proves nothing and must resolve 'unknown' — never
  // 'never-landed', which would release the double-burn guard on a guess.
  fromBlock?: string;
  // Unix ms after which the batch can no longer execute (its EIP-712 deadline). Past this
  // (plus grace) a no-match scan is DEFINITIVE, not merely inconclusive.
  //
  // The submitter owns the real deadline, so callers assume a conservative default. That
  // erring-long is deliberate: too long only delays a safe retry, too short would call a
  // still-mineable batch dead and invite the double-burn. It is also what bounds how long a
  // submit that never reached the relayer at all can hold up a retry — see the
  // unresolved-submission guard in returnIn.ts.
  deadlineMs: number;
}

type PendingReturnBurnMap = Record<string, PendingReturnBurn>;

function readMap(): PendingReturnBurnMap {
  try {
    const raw = localStorage.getItem(PENDING_RETURN_BURN_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as PendingReturnBurnMap;
    return {};
  } catch {
    return {};
  }
}

// Validate before trusting (mirrors isValidInflightReturn): a corrupt record would make
// the resolver scan a bad range or match a garbage commitment. Every field is shape-checked
// rather than truthiness-checked — `fromBlock` of "0" and an accountIndex of 0 are both
// ordinary values, so a truthiness test would silently drop real records.
export function isValidPendingReturnBurn(value: unknown): value is PendingReturnBurn {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.accountIndex === 'number' &&
    Number.isFinite(r.accountIndex) &&
    (r.channel === undefined || typeof r.channel === 'string') &&
    typeof r.depositWallet === 'string' &&
    /^0x[0-9a-fA-F]{40}$/.test(r.depositWallet) &&
    typeof r.amount === 'string' &&
    r.amount.length <= 80 &&
    /^[0-9]+$/.test(r.amount) &&
    typeof r.commitment === 'string' &&
    r.commitment.length <= 80 &&
    /^[0-9]+$/.test(r.commitment) &&
    typeof r.sourceDomain === 'number' &&
    Number.isFinite(r.sourceDomain) &&
    typeof r.evmChainId === 'number' &&
    Number.isFinite(r.evmChainId) &&
    typeof r.inboundAnonymizer === 'string' &&
    /^0x[0-9a-fA-F]+$/.test(r.inboundAnonymizer) &&
    typeof r.submittedAtMs === 'number' &&
    Number.isFinite(r.submittedAtMs) &&
    // OPTIONAL: absent when the pre-submit head read failed. "0" is a real anchor.
    (r.fromBlock === undefined ||
      (typeof r.fromBlock === 'string' && r.fromBlock.length <= 80 && /^[0-9]+$/.test(r.fromBlock))) &&
    typeof r.deadlineMs === 'number' &&
    Number.isFinite(r.deadlineMs)
  );
}

// Best-effort write that REPORTS whether it landed (mirrors writeInflightReturnVerified).
// The caller is about to submit an irreversible burn, so a silently-dropped write is worth
// surfacing — but never worth ABORTING for: refusing to burn because the *insurance* record
// couldn't be saved would be strictly worse than today, where it is never written at all.
export function writePendingReturnBurn(evmAddress: string, record: PendingReturnBurn): boolean {
  try {
    const map = readMap();
    map[evmAddress.toLowerCase()] = record;
    localStorage.setItem(PENDING_RETURN_BURN_KEY, JSON.stringify(map));
  } catch {
    return false;
  }
  const persisted = readPendingReturnBurn(evmAddress);
  return persisted?.commitment === record.commitment && persisted.submittedAtMs === record.submittedAtMs;
}

// Read the pending record for an EVM address, dropping a corrupt one.
export function readPendingReturnBurn(evmAddress: string): PendingReturnBurn | null {
  const raw = readMap()[evmAddress.toLowerCase()] ?? null;
  if (raw === null) return null;
  if (!isValidPendingReturnBurn(raw)) {
    clearPendingReturnBurn(evmAddress);
    return null;
  }
  return raw;
}

export function clearPendingReturnBurn(evmAddress: string): void {
  try {
    const map = readMap();
    delete map[evmAddress.toLowerCase()];
    localStorage.setItem(PENDING_RETURN_BURN_KEY, JSON.stringify(map));
  } catch {
    // ignore.
  }
}

// Can this submission still execute on-chain?
//
// This — not our ability to prove where the burn went — is what the double-burn guard
// actually depends on. The batch is an EIP-712 struct whose deadline the deposit wallet
// enforces, so past it the batch is rejected on-chain and CANNOT spend the wallet again.
// A fresh return after that point is safe whatever the scan concluded: if the earlier burn
// landed the wallet is empty and sizing fails harmlessly, and if it never ran the wallet is
// still funded and the fresh burn is exactly right.
//
// Keeping the guard tied to the SCAN instead was a permanent brick: a record with no block
// anchor can only ever resolve 'unknown' on a clean no-match (an estimated window cannot
// prove absence), so it never cleared, and a submit the relayer refused could block every
// future return for that wallet — the opposite of the bounded wait this is documented as.
//
// The RECORD still outlives this: it is what recovers a burn that did land. Only the
// blocking role expires here.
//
// Note the deadline is the assumed default when the transport doesn't report its own, so
// this releases at that assumption plus the grace. A transport whose real batch lifetime is
// LONGER would need to report it (GaslessBatchSubmission-style) rather than be guessed at.
export function isPendingBurnExecutable(record: PendingReturnBurn, now = Date.now()): boolean {
  return now <= record.deadlineMs + PENDING_BURN_DEADLINE_GRACE_MS;
}

// Does ANY address on this device hold an unresolved submission?
//
// FUND-SAFETY: this store sits OUTSIDE the `pmp.inflight*` naming the switch guard's generic
// scan walks, and it is deliberately not a cursor — so nothing else can infer it. A network
// switch disconnects and wipes pmp.* state, which for an unresolved submission means losing
// the only handle on a burn that may be mining; the guard has to see this store to refuse
// that switch. Cheap synchronous read; safe to call from render or a guard.
export function hasAnyPendingReturnBurn(): boolean {
  return listPendingReturnBurns().length > 0;
}

// All VALID pending records on this device, paired with the EVM address that keys each
// (needed to clear/promote it) — the sweep entry point, mirroring listInflightReturns.
export function listPendingReturnBurns(): Array<{
  evmAddress: string;
  record: PendingReturnBurn;
}> {
  const map = readMap();
  const out: Array<{ evmAddress: string; record: PendingReturnBurn }> = [];
  for (const [evmAddress, record] of Object.entries(map)) {
    if (isValidPendingReturnBurn(record)) out.push({ evmAddress, record });
  }
  return out;
}

// What the chain says about a submitted-but-unobserved burn. FOUR outcomes, deliberately
// not three: 'unknown' exists because an RPC failure proves NOTHING, and collapsing it into
// 'never-landed' would tell a user it is safe to re-burn on the strength of a 429. Same
// unreadable-≠-empty rule the return path's balance reads follow.
export type PendingBurnResolution =
  // The burn is on chain. `burnTx` is the hash attest/claim needs — promote and resume.
  | { kind: 'landed'; burnTx: `0x${string}` }
  // Not on chain yet, and the batch's deadline has not passed: it may still execute.
  // Do NOT re-burn; wait and re-resolve.
  | { kind: 'pending' }
  // Not on chain, and the deadline (plus grace) has passed — the batch can never execute
  // now, so the funds never moved and a fresh return is safe.
  | { kind: 'never-landed' }
  // The scan itself failed. We know nothing; treat exactly like 'pending' for safety.
  | { kind: 'unknown'; error: unknown };

// Scan the source chain for THIS pending record's DepositForBurn.
//
// Identification is exact, not heuristic: the RPC filter narrows to our TokenMessengerV2 +
// the per-bid deposit wallet as `depositor`, and the code-side match then requires the
// event's hookData to equal our own commitment — a value only this account index's return
// could have written. Amount and destination domain are checked too, so a wallet that
// somehow burned twice can't cross-match.
export async function resolvePendingReturnBurn(
  record: PendingReturnBurn,
  opts?: { client?: PublicClient; now?: number },
): Promise<PendingBurnResolution> {
  const now = opts?.now ?? Date.now();
  const source = getEvmCctpSource(record.evmChainId);
  if (!source) {
    // Misconfiguration, not evidence about the burn — never report 'never-landed' from it.
    return { kind: 'unknown', error: new Error(`no EVM CCTP source for chain ${record.evmChainId}`) };
  }
  // The burn executes on the chain the record names, so the scan MUST run against that
  // chain's RPC — resolving the TokenMessenger for one chain and querying another returns
  // an empty log set, which past the deadline would read as "the burn never happened" and
  // release the double-burn guard. Built from the source registry's own rpcUrl, exactly as
  // depositIn.ts builds its per-source client.
  const client = opts?.client ?? evmClientForSource(source);
  const wantHookData = encodeCommitmentHookData(BigInt(record.commitment)).toLowerCase();
  const wantAmount = BigInt(record.amount);

  const findIn = async (fromBlock: bigint, toBlock: bigint): Promise<`0x${string}` | null> => {
    const logs = await client.getLogs({
      address: source.tokenMessenger as `0x${string}`,
      event: TOKEN_MESSENGER_EVENT_ABI[0],
      args: { depositor: record.depositWallet as `0x${string}` },
      fromBlock,
      toBlock,
    });
    const match = logs.find(
      (log) =>
        log.args.hookData?.toLowerCase() === wantHookData &&
        log.args.amount === wantAmount &&
        Number(log.args.destinationDomain) === config.cctp.starknetDomain &&
        log.transactionHash !== null,
    );
    return match?.transactionHash ?? null;
  };

  try {
    // The widest INCLUSIVE range this provider accepts — a property of the RPC plan (as low as
    // 10 blocks), so it belongs to config, not to constants here. Every getLogs below obeys it.
    // Its ratio against the walk's reach is the request cost of an anchorless resolution.
    const chunkBlocks = BigInt(config.polygonGetLogsChunkBlocks);
    const reachBlocks = BigInt(config.polygonWalkReachBlocks);
    if (chunkBlocks <= 0n || reachBlocks <= 0n) {
      throw new Error(
        `getLogs chunk size and walk reach must be positive block counts (got ${chunkBlocks}, ${reachBlocks})`,
      );
    }
    const head = await client.getBlockNumber();

    // A no-match only becomes a verdict once BOTH hold: the search demonstrably covered where
    // the burn could be, and the deadline has passed so nothing more can land. Otherwise it is
    // 'pending' (still mineable) or 'unknown' (we did not establish absence) — never a guess
    // that releases the double-burn guard.
    const searched =
      record.fromBlock === undefined
        ? await walkBackToSubmit(
            record,
            head,
            findIn,
            async (block) => {
              const { timestamp } = await client.getBlock({ blockNumber: block });
              return Number(timestamp) * 1000;
            },
            chunkBlocks,
            reachBlocks,
          )
        : await searchExactWindow(record, head, findIn, chunkBlocks);

    if (searched.burnTx) return { kind: 'landed', burnTx: searched.burnTx };
    if (!searched.coveredSubmit) {
      return {
        kind: 'unknown',
        error: new Error('could not search back far enough to establish the burn never happened'),
      };
    }
    if (now > record.deadlineMs + PENDING_BURN_DEADLINE_GRACE_MS) return { kind: 'never-landed' };
    return { kind: 'pending' };
  } catch (error) {
    return { kind: 'unknown', error };
  }
}

// What a search established: the burn's tx hash, and whether the range it covered actually
// reached back over the submit (which is what licenses a NEGATIVE conclusion).
interface BurnSearch {
  burnTx: `0x${string}` | null;
  coveredSubmit: boolean;
}

// Walk [from, to] INCLUSIVE in ranges no wider than `chunkBlocks`, oldest chunk first, and
// stop at the first match — which is the same burn a single wide getLogs would have matched,
// since both take the lowest-block hit. A chunk that throws PROPAGATES: the caller's verdict
// depends on the whole range having answered, so a swallowed chunk would turn an unproven
// absence into 'never-landed'. No call-count ceiling here, deliberately — the anchored window
// only licenses a negative once it is fully covered, so capping the calls would put this path
// back where it started, permanently 'unknown'.
async function findInChunks(
  findIn: (from: bigint, to: bigint) => Promise<`0x${string}` | null>,
  from: bigint,
  to: bigint,
  chunkBlocks: bigint,
): Promise<`0x${string}` | null> {
  for (let lo = from; lo <= to; lo += chunkBlocks) {
    const chunkEnd = lo + chunkBlocks - 1n;
    const burnTx = await findIn(lo, chunkEnd > to ? to : chunkEnd);
    if (burnTx) return burnTx;
  }
  return null;
}

// ANCHORED search: the record captured the chain head just before submitting, so the burn —
// which can only execute between the submit and the deadline — must lie in
// [anchor, anchor + deadline-span]: a constant ~10 minutes of blocks however old the record
// is, walked in config-sized chunks so the window stays inside the provider's range cap.
async function searchExactWindow(
  record: PendingReturnBurn,
  head: bigint,
  findIn: (from: bigint, to: bigint) => Promise<`0x${string}` | null>,
  chunkBlocks: bigint,
): Promise<BurnSearch> {
  const anchor = BigInt(record.fromBlock as string);
  if (anchor > head) {
    // The anchor sits ABOVE the head — a reorg, a node serving a stale height, or a record
    // from a different chain. Search the tip so a burn can still be FOUND, but the submit
    // window was never covered, so absence here proves nothing.
    return { burnTx: await findIn(head, head), coveredSubmit: false };
  }
  const deadlineSpanMs = Math.min(
    MAX_DEADLINE_SPAN_MS,
    Math.max(0, record.deadlineMs + PENDING_BURN_DEADLINE_GRACE_MS - record.submittedAtMs),
  );
  const deadlineSpanBlocks = blocksForSpanMs(deadlineSpanMs);
  // Margin on BOTH sides. The lower one matters most: the anchor read races the submit, so a
  // slow response can report a height already PAST the burn's block, and starting exactly at
  // the anchor would scan above it.
  const lower = anchor > SCAN_MARGIN_BLOCKS ? anchor - SCAN_MARGIN_BLOCKS : 0n;
  const upper = anchor + deadlineSpanBlocks + SCAN_MARGIN_BLOCKS;
  return {
    burnTx: await findInChunks(findIn, lower, upper > head ? head : upper, chunkBlocks),
    coveredSubmit: true,
  };
}

// Hard ceiling on the calls one walk may spend: reach ÷ chunk, which IS the request cost of a
// walk and the reason the two knobs are set as a pair. The reach floor below normally ends the
// walk first, so this is a guard rather than the operative bound.
function walkChunkBudget(chunkBlocks: bigint, reachBlocks: bigint): number {
  const needed = (reachBlocks + chunkBlocks - 1n) / chunkBlocks;
  return needed > BigInt(FALLBACK_MAX_CHUNKS) ? Number(needed) : FALLBACK_MAX_CHUNKS;
}

// ANCHORLESS search: no height to key off, and timestamps cannot be mapped to heights without
// knowing the chain's block time (0.25s–15s across chains — a day is 6k or 350k blocks). So
// walk back from the head in bounded chunks and stop on a FACT: the first chunk whose lowest
// block predates the submit. At that point the walk has covered every block the burn could be
// in, so a no-match is real; running out of budget first leaves it unestablished. Each chunk
// costs one getLogs plus one getBlock, and is sized from the same provider cap as every other
// range here — an over-wide chunk would be REJECTED, which is 'unknown' forever.
async function walkBackToSubmit(
  record: PendingReturnBurn,
  head: bigint,
  findIn: (from: bigint, to: bigint) => Promise<`0x${string}` | null>,
  blockTimestampMs: (block: bigint) => Promise<number>,
  chunkBlocks: bigint,
  reachBlocks: bigint,
): Promise<BurnSearch> {
  const maxChunks = walkChunkBudget(chunkBlocks, reachBlocks);
  // The oldest block the configured reach allows. Reach is a DISTANCE, so it bounds the walk
  // itself rather than only its call count — the last chunk is clamped to it instead of
  // overshooting, and stopping here means absence was never established.
  const reachFloor = head >= reachBlocks ? head - reachBlocks + 1n : 0n;
  let hi = head;
  for (let chunk = 0; chunk < maxChunks; chunk++) {
    const stride = hi >= chunkBlocks ? hi - chunkBlocks + 1n : 0n;
    const lo = stride > reachFloor ? stride : reachFloor;
    const burnTx = await findIn(lo, hi);
    if (burnTx) return { burnTx, coveredSubmit: true };
    // Genesis: there is nothing older left to search, so absence is as established as it gets.
    if (lo === 0n) return { burnTx: null, coveredSubmit: true };
    if ((await blockTimestampMs(lo)) <= record.submittedAtMs) {
      return { burnTx: null, coveredSubmit: true };
    }
    if (lo === reachFloor) return { burnTx: null, coveredSubmit: false };
    hi = lo - 1n;
  }
  return { burnTx: null, coveredSubmit: false };
}

// A read-only client for the chain a burn executes on. Exported so the burn path anchors
// its block read to the SAME chain the recovery scan will query — a Polygon-pinned client
// on either side reintroduces the cross-chain mismatch this exists to avoid.
export function evmClientForSource(source: EvmCctpSource): PublicClient {
  return createPublicClient({ transport: http(source.rpcUrl) }) as PublicClient;
}

