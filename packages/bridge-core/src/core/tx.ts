import type { RpcProvider } from 'starknet';

export type TxFinality =
  | 'RECEIVED'
  | 'PRE_CONFIRMED'
  | 'ACCEPTED_ON_L2'
  | 'ACCEPTED_ON_L1';

// Block tag we read state at — pre_confirmed is the fastest stable view.
export const READ_BLOCK = 'pre_confirmed' as const;

// Finality ordering. A status is "reached" once we hit one with rank >= target.
const FINALITY_RANK: Record<TxFinality, number> = {
  RECEIVED: 0,
  PRE_CONFIRMED: 1,
  ACCEPTED_ON_L2: 2,
  ACCEPTED_ON_L1: 3,
};

type StatusCallback = (s: { finality: string; execution?: string }) => void;

// starknet@10 getTransactionStatus returns the raw RPC shape:
//   { finality_status, execution_status?, failure_reason? }.
// finality_status may also be 'REJECTED' (spec-level) even though the TS
// enum narrows it out, so we read defensively.
type RawTxStatus = {
  finality_status: string;
  execution_status?: string;
  failure_reason?: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Defense-in-depth before surfacing an SDK/RPC error in the UI. We never build
// these strings from secret material, but the SDK is a trust boundary: if it
// ever embedded a viewing key / proof witness in an exception message, echoing
// the raw text verbatim would leak it. So strip long hex blobs (>16 hex digits,
// the shape of felts/keys/witnesses) down to a short prefix, then cap the
// overall length. Use this anywhere a raw `err.message` is interpolated into
// onStatus/progress/UI text.
const LONG_HEX_RE = /0x[0-9a-fA-F]{17,}/g;
// Generous cap: nested Starknet execution errors (TRANSACTION_EXECUTION_ERROR) carry
// the actual revert reason deep inside a chain of InnerContractExecutionError frames,
// so a tight cap hides exactly the diagnostic we need. Long hex (keys/witnesses/felts)
// is still stripped above, so this stays safe to surface.
const MAX_ERROR_LENGTH = 2000;

// starknet.js RpcError builds its `.message` as
//   `RPC: <method> with params <big JSON>\n  <code>: <message>: <data>`
// so the ACTUAL failure reason sits AFTER a huge params dump — front-truncating the
// message (below) would drop exactly the part we need (this is why the paymaster
// error was invisible in the UI). RpcError also exposes the reason structurally on
// `.baseError = { code, message, data }`; extract that and the method name so the UI
// shows e.g. `paymaster_buildTransaction (163): … : x-paymaster-api-key is invalid`.
//
// starknet.js does NOT validate that the server's error payload actually matches
// {code,message,data} before building that template — a proxy/gateway failure (e.g.
// our dev-proxy's 502 "network not configured" stub, or any non-JSON-RPC upstream)
// can hand it a bare string or an HTTP-response-shaped object instead. The library
// still renders the template against whatever it got, so the literal string
// "undefined: undefined: undefined" was reaching the UI. Handle those shapes too,
// and never let the literal word "undefined" stand in for a missing field.
const UNDEFINED_TRIPLET_RE = /undefined:\s*undefined:\s*undefined\s*$/;

function rpcErrorReason(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const base = (err as { baseError?: unknown }).baseError;
  const method =
    err instanceof Error ? err.message.match(/^RPC:\s*(\S+)\s+with params/)?.[1] : undefined;

  // 1) baseError is a bare string — e.g. a proxy stub that replies
  //    `{ error: "<string>" }` instead of `{ error: { code, message, data } }`.
  //    It's already human text; use it as-is.
  if (typeof base === 'string' && base.trim()) {
    const text = base.trim();
    return method ? `${method}: ${text}` : text;
  }

  if (base && typeof base === 'object') {
    const b = base as { code?: unknown; message?: unknown; data?: unknown } & Record<
      string,
      unknown
    >;
    const parts: string[] = [];
    if (b.code !== undefined && b.code !== null) parts.push(`(${String(b.code)})`);
    if (b.message) parts.push(String(b.message));
    if (b.data !== undefined && b.data !== null && b.data !== '') {
      let data: string;
      try {
        data = typeof b.data === 'string' ? b.data : JSON.stringify(b.data);
      } catch {
        data = String(b.data);
      }
      if (data && data !== '""') parts.push(data);
    }
    if (parts.length) return method ? `${method} ${parts.join(': ')}` : parts.join(': ');

    // 2) No {code,message,data} at all — try an HTTP-response-shaped baseError
    //    instead (status/statusText/body), e.g. a raw 502 that never had a
    //    JSON-RPC envelope in the first place.
    if (b.status !== undefined || b.statusText || b.body) {
      const status = b.status !== undefined ? ` ${String(b.status)}` : '';
      const statusText = b.statusText ? ` ${String(b.statusText)}` : '';
      const bodyText = typeof b.body === 'string' ? b.body.trim() : '';
      const preview = bodyText ? `: ${bodyText.slice(0, 200)}` : '';
      return `Starknet RPC error (HTTP${status}${statusText})${preview}`;
    }
  }

  // 3) No usable baseError (missing entirely, or an empty {code,message,data}
  //    triplet) but the raw message still carries the broken
  //    "undefined: undefined: undefined" render — e.g. starknet.js's own
  //    `errorHandler` re-wraps an unrecognized error as `new Error(other.message)`,
  //    losing `.baseError` but keeping the garbled text. Never surface that verbatim.
  const rawMessage = err instanceof Error ? err.message : undefined;
  if (rawMessage && UNDEFINED_TRIPLET_RE.test(rawMessage)) {
    return method
      ? `Starknet RPC error calling ${method}: the node returned no usable error details.`
      : 'Starknet RPC error: the node returned no usable error details.';
  }

  return undefined;
}

// Thrown by submitAndTrack when a SUBMITTED tx (hash known) is TRACKED to a TERMINAL
// on-chain FAILURE — execution REVERTED or finality REJECTED. This is DEFINITIVE and
// distinct from an AMBIGUOUS submit failure (submit() threw with no hash, or tracking
// timed out with the status unknown): a tracked-terminal outcome means the tx landed
// and its effects were fully rolled back atomically — value did NOT move — so a
// rebuild+retry of a proven leg is safe here (AVNU relayed-submit lesson, case (c),
// code-style.md), whereas an ambiguous outcome must fail closed. `.message` keeps the
// exact `submitAndTrack: <hash> REVERTED|REJECTED[: reason]` shape it always had, so
// callers that classify by message text (isAlreadyRegisteredError → NON_ZERO_VALUE;
// isRevertedOrRejected → /REVERTED|REJECTED/) are unaffected.
export class TxTerminalStatusError extends Error {
  readonly transactionHash: string;
  readonly kind: 'REVERTED' | 'REJECTED';
  readonly failureReason?: string;
  constructor(kind: 'REVERTED' | 'REJECTED', hash: string, failureReason?: string) {
    super(`submitAndTrack: ${hash} ${kind}${failureReason ? `: ${failureReason}` : ''}`);
    this.name = 'TxTerminalStatusError';
    this.kind = kind;
    this.transactionHash = hash;
    this.failureReason = failureReason;
  }
}

// True only when `err` is a submitAndTrack TRACKED-TERMINAL outcome: the tx was
// submitted (hash observed) AND reached a terminal on-chain failure (REVERTED/
// REJECTED). Precise by construction — a pre-hash submit throw (e.g. an AVNU relay
// JSON-RPC error, which may have broadcast anyway) or a tracking timeout is NOT this
// type, so it correctly reads as AMBIGUOUS (fail closed). Prefer this over matching
// the message text when the retry decision must be certain the value did not move.
export function isTrackedTerminalStatus(err: unknown): err is TxTerminalStatusError {
  return err instanceof TxTerminalStatusError;
}

// A post-send throw whose message carries the literal words REVERTED/REJECTED —
// the shape submitAndTrack's TxTerminalStatusError always produces (see its
// `.message` above). Shared predicate for the several proveAndSubmit* retry
// guards (bridgeOut.ts, bridgeBack.ts, deposit.ts) that need to distinguish a
// DEFINITIVE atomic no-op (safe to rebuild + retry) from an in-flight/ambiguous
// submit failure. Byte-identical across all three call sites before this dedupe.
export function isRevertedOrRejected(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\bREVERTED\b|\bREJECTED\b/.test(message);
}

export function sanitizeErrorMessage(err: unknown): string {
  // Prefer the structured RPC reason (the tail of a verbose RpcError) over its raw
  // message, which leads with a multi-KB params dump that buries / truncates the cause.
  const raw = rpcErrorReason(err) ?? (err instanceof Error ? err.message : String(err));
  // Last-resort guard: never show a bare "undefined"/"null"/empty string (e.g. a
  // `throw undefined` or similarly degenerate thrown value).
  const safeRaw = raw.trim() === '' || raw === 'undefined' || raw === 'null' ? 'Unknown error.' : raw;
  const stripped = safeRaw.replace(LONG_HEX_RE, (m) => `${m.slice(0, 10)}…[${m.length - 2} hex]`);
  return stripped.length > MAX_ERROR_LENGTH
    ? `${stripped.slice(0, MAX_ERROR_LENGTH)}…`
    : stripped;
}

// Result of a tracked submission. `blockNumber` is the tx's block when the node
// exposes it (read from the receipt once finality is reached); undefined if the
// receipt is unavailable or carries no block (e.g. still pre-confirmed). Callers
// feed it to waitForProvingBlock so the prover proves against a settled block.
export type SubmitResult = { transaction_hash: string; blockNumber?: number };

// Reads `block_number` off the receipt without fighting the helper union.
// The RPC receipt carries block_number once the tx is in a block; pre-confirmed
// receipts omit it. Any failure to read leaves blockNumber undefined.
async function readBlockNumber(
  provider: RpcProvider,
  hash: string,
): Promise<number | undefined> {
  try {
    const receipt = (await provider.getTransactionReceipt(hash)) as {
      block_number?: number;
    };
    return typeof receipt.block_number === 'number' ? receipt.block_number : undefined;
  } catch {
    return undefined;
  }
}

// #105: polls getTransactionReceipt for a real block_number, for callers that need a
// DEFINITE block (not the best-effort undefined submitAndTrack's blockNumber can
// return) — e.g. seeding waitForProvingBlock's aging wait, where an undefined reading
// as "no dependency" would wrongly skip aging for a tx that IS a dependency. Bounded
// so a persistently-missing block_number surfaces a clear error instead of hanging.
export async function waitForBlockNumber(
  provider: RpcProvider,
  hash: string,
  opts?: { intervalMs?: number; timeoutMs?: number },
): Promise<number> {
  const intervalMs = opts?.intervalMs ?? 500;
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const blockNumber = await readBlockNumber(provider, hash);
    if (blockNumber !== undefined) return blockNumber;
    if (Date.now() > deadline) {
      throw new Error(`waitForBlockNumber: ${hash} never surfaced a block_number after ${timeoutMs}ms`);
    }
    await sleep(intervalMs);
  }
}

export async function submitAndTrack(
  provider: RpcProvider,
  submit: () => Promise<{ transaction_hash: string }>,
  opts?: {
    onStatus?: StatusCallback;
    until?: TxFinality;
    intervalMs?: number;
    maxIntervalMs?: number;
    timeoutMs?: number;
  },
): Promise<SubmitResult> {
  const until = opts?.until ?? 'PRE_CONFIRMED';
  // Exponential backoff (×1.5, capped) between polls: early polls stay snappy for the
  // PRE_CONFIRMED UX while long L2/attestation-scale waits back off. timeoutMs stays
  // the hard cap.
  const baseIntervalMs = opts?.intervalMs ?? 1000;
  const maxIntervalMs = opts?.maxIntervalMs ?? 8000;
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const targetRank = FINALITY_RANK[until];

  let interval = baseIntervalMs;
  const backoff = (): void => {
    interval = Math.min(Math.round(interval * 1.5), maxIntervalMs);
  };

  const result = await submit();
  const hash = result.transaction_hash;

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`submitAndTrack: timed out after ${timeoutMs}ms for ${hash}`);
    }

    let status: RawTxStatus | undefined;
    try {
      status = (await provider.getTransactionStatus(hash)) as RawTxStatus;
    } catch {
      // Node may not yet know the tx (just submitted) — retry until timeout.
      await sleep(interval);
      backoff();
      continue;
    }

    const finality = status.finality_status;
    const execution = status.execution_status;
    opts?.onStatus?.({ finality, execution });

    // Only an EXPLICIT revert is a failure. execution_status is optional in the
    // RPC shape (e.g. some nodes omit it pre-confirmation), so treat an absent
    // status as "not yet reverted" rather than blocking on === 'SUCCEEDED' —
    // but ONLY at RECEIVED (rank 0). Per the Starknet RPC TXN_STATUS spec,
    // execution_status must be present from PRE_CONFIRMED onward, so once we're
    // at/above that rank a missing execution_status is a wire/node bug, not a
    // pending state — never treat it as success.
    if (execution === 'REVERTED') {
      throw new TxTerminalStatusError('REVERTED', hash, status.failure_reason);
    }
    if (finality === 'REJECTED') {
      throw new TxTerminalStatusError('REJECTED', hash, status.failure_reason);
    }

    const rank = FINALITY_RANK[finality as TxFinality];
    const succeeded =
      rank !== undefined && rank >= FINALITY_RANK.PRE_CONFIRMED
        ? execution === 'SUCCEEDED'
        : execution === undefined || execution === 'SUCCEEDED';
    if (rank !== undefined && rank >= targetRank && succeeded) {
      // Best-effort block number for proving-window math; never fatal.
      const blockNumber = await readBlockNumber(provider, hash);
      return { transaction_hash: hash, blockNumber };
    }

    await sleep(interval);
    backoff();
  }
}
