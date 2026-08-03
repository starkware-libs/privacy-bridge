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
import { type PublicClient, type Abi } from 'viem';

import { config, getEvmCctpSource } from './config';
import { encodeCommitmentHookData } from '../derivation/index';
import { getPolygonPublicClient } from './polygonClient';

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

// Polygon's ~2s block time, used only to turn "submitted N ms ago" into a getLogs lower
// bound. Deliberately UNDER-estimated (real blocks are ≥2s), so the derived span errs
// LONG — scanning extra blocks costs a little RPC, scanning too few would miss the burn
// and report a landed burn as missing, which is the one wrong answer that matters.
const POLYGON_BLOCK_TIME_MS = 2_000;

// Extra blocks below the derived lower bound, absorbing clock skew and a slow first block.
const SCAN_MARGIN_BLOCKS = 600n;

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
  // When the relayer accepted the submit (unix ms). The scan window is derived FROM this
  // at resolve time rather than snapshotting a block height at submit time: the burn is on
  // the hot path and must not wait on an extra RPC round-trip, and a height read then would
  // go stale anyway if recovery happens a day later. Elapsed time converts to a block span
  // (see resolvePendingReturnBurn), so a resolve seconds later scans a handful of blocks
  // and one next week scans back far enough to still find the burn.
  submittedAtMs: number;
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
  const client = opts?.client ?? getPolygonPublicClient();
  const wantHookData = encodeCommitmentHookData(BigInt(record.commitment)).toLowerCase();
  const wantAmount = BigInt(record.amount);

  try {
    // Derive the scan window from how long ago the batch was submitted. `head` is read
    // here (recovery path only — never on the burn's hot path); a span floor of 0 keeps a
    // clock that jumped backwards from producing a negative, and the max() keeps the bound
    // at genesis rather than underflowing bigint.
    const head = await client.getBlockNumber();
    const elapsedMs = Math.max(0, (opts?.now ?? Date.now()) - record.submittedAtMs);
    const spanBlocks = BigInt(Math.ceil(elapsedMs / POLYGON_BLOCK_TIME_MS)) + SCAN_MARGIN_BLOCKS;
    const fromBlock = head > spanBlocks ? head - spanBlocks : 0n;
    const logs = await client.getLogs({
      address: source.tokenMessenger as `0x${string}`,
      event: TOKEN_MESSENGER_EVENT_ABI[0],
      args: { depositor: record.depositWallet as `0x${string}` },
      fromBlock,
      toBlock: 'latest',
    });
    const match = logs.find(
      (log) =>
        log.args.hookData?.toLowerCase() === wantHookData &&
        log.args.amount === wantAmount &&
        Number(log.args.destinationDomain) === config.cctp.starknetDomain &&
        log.transactionHash !== null,
    );
    if (match?.transactionHash) return { kind: 'landed', burnTx: match.transactionHash };
  } catch (error) {
    return { kind: 'unknown', error };
  }

  // A clean scan with no match. Only the DEADLINE can turn that into a verdict: before it,
  // the batch is still mineable and absence is not evidence.
  if (now > record.deadlineMs + PENDING_BURN_DEADLINE_GRACE_MS) return { kind: 'never-landed' };
  return { kind: 'pending' };
}
