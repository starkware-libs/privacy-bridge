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

import { config, getEvmCctpSource, type EvmCctpSource } from './config';
import { encodeCommitmentHookData } from '../derivation/index';

// TokenMessengerV2 DepositForBurn — the on-chain proof that a submitted batch executed.
// Mirrors depositIn.ts's copy (same event, same indexing: burnToken, depositor,
// minFinalityThreshold); kept local so this module has no depositIn import cycle.
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

// Grace added to the batch deadline before a no-match scan is called 'never-landed'.
// Covers clock skew between the browser (which stamped the deadline) and the chain, plus
// the lag between a block being mined and a public RPC serving its logs. Erring long is
// free — the only cost of waiting is a later retry — while erring short would tell a user
// "safe to retry" while their burn is still mineable, which is the double-burn we are
// here to prevent.
export const PENDING_BURN_DEADLINE_GRACE_MS = 120_000;

// The burn can only execute between the submit and the batch deadline, so the scan window
// is that span — NOT "everything since the submit". This is what keeps a single getLogs
// call bounded no matter how old the record is: a week-old record scans the same ~10-minute
// window, just further back. An elapsed-time span would grow past every provider's
// eth_getLogs range cap and fail as 'unknown' forever.
//
// Sized against the FASTEST plausible EVM block time rather than a per-chain table: over-
// estimating the block count only widens a window that is already bounded, whereas
// under-estimating would cut the window short and miss the burn — the one wrong answer that
// actually loses money. 0.25s covers Arbitrum; Polygon/Base (~2s) land well inside it.
const FASTEST_BLOCK_TIME_MS = 250;

// Extra blocks on each side, absorbing clock skew and block-time variance.
const SCAN_MARGIN_BLOCKS = 600n;

// Lookback for the fallback window used when no exact block anchor was captured. Bounded so
// the call still succeeds; a no-match under this window is never conclusive (see below).
const FALLBACK_LOOKBACK_BLOCKS = 10_000n;

// Ceiling on the submit→deadline span the window is sized from. That span comes off a
// PERSISTED record, and the whole point of the window is that it stays inside a provider's
// eth_getLogs range cap — so a record carrying an implausible deadline (corrupted, or
// written by a future version with a different batch lifetime) must not be able to widen it
// into a call that always fails. Comfortably above any real relayer batch deadline.
const MAX_DEADLINE_SPAN_MS = 30 * 60_000;

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

  try {
    const head = await client.getBlockNumber();
    const window = scanWindow(record, head, now);
    const logs = await client.getLogs({
      address: source.tokenMessenger as `0x${string}`,
      event: TOKEN_MESSENGER_EVENT_ABI[0],
      args: { depositor: record.depositWallet as `0x${string}` },
      fromBlock: window.fromBlock,
      toBlock: window.toBlock,
    });
    const match = logs.find(
      (log) =>
        log.args.hookData?.toLowerCase() === wantHookData &&
        log.args.amount === wantAmount &&
        Number(log.args.destinationDomain) === config.cctp.starknetDomain &&
        log.transactionHash !== null,
    );
    if (match?.transactionHash) return { kind: 'landed', burnTx: match.transactionHash };
    // A clean scan with no match. Two things must BOTH hold before that becomes a verdict:
    //   - the deadline has passed, so the batch can no longer execute; and
    //   - the window was EXACT, so we know we looked in the right place. An estimated
    //     window that happened to be positioned wrong would otherwise read as proof the
    //     funds never moved and release the guard — on a guess.
    if (window.exact && now > record.deadlineMs + PENDING_BURN_DEADLINE_GRACE_MS) {
      return { kind: 'never-landed' };
    }
    if (window.exact) return { kind: 'pending' };
    return {
      kind: 'unknown',
      error: new Error('no block anchor for this submission — the scan window is an estimate'),
    };
  } catch (error) {
    return { kind: 'unknown', error };
  }
}

// A read-only client for the chain a burn executes on. Exported so the burn path anchors
// its block read to the SAME chain the recovery scan will query — a Polygon-pinned client
// on either side reintroduces the cross-chain mismatch this exists to avoid.
export function evmClientForSource(source: EvmCctpSource): PublicClient {
  return createPublicClient({ transport: http(source.rpcUrl) }) as PublicClient;
}

// The block range to search, and whether it is trustworthy enough for a NEGATIVE result.
//
// EXACT: the record captured the chain head just before submitting, so the burn — which can
// only execute between the submit and the deadline — must lie in
// [fromBlock, fromBlock + deadline-span]. That span is a constant ~10 minutes of blocks
// however old the record is, which is what keeps one getLogs call inside every provider's
// range cap. Clamped to the head so we never ask for unmined blocks.
//
// ESTIMATED: no anchor (the pre-submit read failed), so fall back to a bounded lookback from
// the head. A match here is still proof (the commitment identifies it), but a no-match is
// not — the window may simply be in the wrong place.
function scanWindow(
  record: PendingReturnBurn,
  head: bigint,
  now: number,
): { fromBlock: bigint; toBlock: bigint; exact: boolean } {
  const deadlineSpanMs = Math.min(
    MAX_DEADLINE_SPAN_MS,
    Math.max(0, record.deadlineMs + PENDING_BURN_DEADLINE_GRACE_MS - record.submittedAtMs),
  );
  const deadlineSpanBlocks = BigInt(Math.ceil(deadlineSpanMs / FASTEST_BLOCK_TIME_MS));

  if (record.fromBlock !== undefined) {
    const anchor = BigInt(record.fromBlock);
    if (anchor > head) {
      // The anchor sits ABOVE the head — a reorg, a node serving a stale height, or a record
      // from a different chain. Clamping keeps the range from inverting, but the resulting
      // scan covers only the tip and NOT the submit window it was supposed to, so it is not
      // exact: a clean no-match here proves nothing and must never release the guard.
      return { fromBlock: head, toBlock: head, exact: false };
    }
    // Margin on BOTH sides. The lower one matters most: the anchor read races the submit, so
    // a slow response can report a height already PAST the burn's block. Starting exactly at
    // the anchor would then scan above the burn, find nothing, and — past the deadline —
    // call it never-landed. Backing off keeps the window over the burn.
    const lower = anchor > SCAN_MARGIN_BLOCKS ? anchor - SCAN_MARGIN_BLOCKS : 0n;
    const upper = anchor + deadlineSpanBlocks + SCAN_MARGIN_BLOCKS;
    return { fromBlock: lower, toBlock: upper > head ? head : upper, exact: true };
  }

  // Estimated: walk back far enough to plausibly cover the submit, bounded by the lookback.
  const elapsedMs = Math.max(0, now - record.submittedAtMs);
  const back = BigInt(Math.ceil(elapsedMs / FASTEST_BLOCK_TIME_MS)) + SCAN_MARGIN_BLOCKS;
  const capped = back > FALLBACK_LOOKBACK_BLOCKS ? FALLBACK_LOOKBACK_BLOCKS : back;
  return { fromBlock: head > capped ? head - capped : 0n, toBlock: head, exact: false };
}
