// Cross-run resume cursor for the pool-DEPOSIT leg of moveIntoPool (the deploy-fee-OFF
// funding path — frozen Row 1 / metamask).
//
// FUND-SAFETY (double-burn on cross-run resume): once moveIntoPool funds the derived
// account (fundFromMetaMask burns the user's own USDC → mints to the SN account) and
// then depositToPool moves it into the pool, the SN balance is DRAINED and
// fundFromMetaMask's own resume cursor (pmp.inflightDeposit) has already been cleared.
// A tab reload / retry that re-invokes moveIntoPool then sees an already-deployed,
// already-registered account with a ZERO balance and no inflight-deposit cursor — the
// in-memory `funded` flag is gone — so the deposit step would re-enter the FRESH burn
// path and DOUBLE-BURN the user's USDC. (The user-paid-deploy-fee path is already
// guarded by depositFromChainBalance; this is its deploy-fee-OFF analog.)
//
// So we persist a durable, NON-SECRET marker keyed per DERIVED SN ACCOUNT the instant
// the funds land on the account (BEFORE depositToPool), and clear it once the deposit
// completes. On resume:
//   - cursor present + funds still on the account  → deposit the LIVE balance, no re-fund;
//   - cursor present + balance drained             → the deposit already landed → done.
// The cursor is OPERATION-scoped (cleared on completion), so a genuinely new deposit
// into the same account later starts fresh and is never blocked.
//
// Key naming (`pmp.inflight*`) is deliberate: the funder-agnostic network-switch guard
// (hasAnyInflightTransfer) scans every `pmp.inflight*` key, so a pending pool deposit
// blocks a network switch that would otherwise wipe this cursor mid-flight (which would
// re-open the double-burn). The key STRING is a frozen wire value (never rename it).

const POOL_DEPOSIT_CURSOR_KEY = 'pmp.inflightPoolDeposit';

interface PendingPoolDeposit {
  // The NET the funder landed on the SN account (deposit-token base units, decimal
  // string). Reported as depositedNetWei when a resume finds the deposit already done.
  netWei: string;
  timestamp: number;
}

type PendingPoolDepositMap = Record<string, PendingPoolDeposit>;

function readMap(): PendingPoolDepositMap {
  try {
    const raw = localStorage.getItem(POOL_DEPOSIT_CURSOR_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as PendingPoolDepositMap;
    return {};
  } catch {
    return {};
  }
}

// A record is valid only if netWei is a positive-integer string — a corrupt/partial
// entry can't be safely resumed off (its reported net would be garbage); drop it and
// treat the deposit as fresh (funds, if any, are recoverable from the derived account).
function isValid(value: unknown): value is PendingPoolDeposit {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return typeof r.netWei === 'string' && /^[0-9]+$/.test(r.netWei) && BigInt(r.netWei) > 0n;
}

// Reads (and drops, if corrupt) the pending-pool-deposit cursor for a derived account.
// Returns the recorded net (bigint) or null when there is no resumable cursor.
export function readPendingPoolDeposit(snAddress: string): { netWei: bigint } | null {
  const record = readMap()[snAddress.toLowerCase()] ?? null;
  if (record === null) return null;
  if (!isValid(record)) {
    clearPendingPoolDeposit(snAddress);
    return null;
  }
  return { netWei: BigInt(record.netWei) };
}

// Sibling of readPendingPoolDeposit for callers that only need presence (e.g. the
// unified getBridgeTransferStatus reader): true iff a resumable pool-deposit cursor
// exists for the derived account. Best-effort + corrupt-safe (delegates to the
// validated reader, which drops a garbage record and returns null).
export function hasInflightPoolDeposit(snAddress: string): boolean {
  return readPendingPoolDeposit(snAddress) !== null;
}

// Persist that `netWei` has landed on the SN account and a pool deposit is pending.
// Written BEFORE depositToPool so the drained-balance resume window is covered.
// Best-effort: a storage failure must not break the deposit — fundFromMetaMask's own
// balance no-op still guards the pre-deposit (funds-on-account) window; the marker only
// hardens the post-deposit (drained-balance) window.
export function recordPendingPoolDeposit(snAddress: string, netWei: bigint): void {
  try {
    const map = readMap();
    map[snAddress.toLowerCase()] = { netWei: netWei.toString(), timestamp: Date.now() };
    localStorage.setItem(POOL_DEPOSIT_CURSOR_KEY, JSON.stringify(map));
  } catch {
    // ignore (persistence is best-effort).
  }
}

// Clear the cursor once the deposit completes (or a resume confirms it already did),
// so a genuinely new deposit into the same account later starts fresh.
export function clearPendingPoolDeposit(snAddress: string): void {
  try {
    const map = readMap();
    delete map[snAddress.toLowerCase()];
    localStorage.setItem(POOL_DEPOSIT_CURSOR_KEY, JSON.stringify(map));
  } catch {
    // ignore.
  }
}
