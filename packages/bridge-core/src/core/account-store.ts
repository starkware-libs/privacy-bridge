// Per-user derived-account HISTORY store (NON-SECRET), keyed by connected EVM
// address. This is the client-side "account DB" the dashboard reads: a list of
// the derived accounts an EVM identity has funded from the pool, each with its
// public/recomputable metadata + a coarse lifecycle. There is NO backend — a
// server keyed by EVM address would join the EVM identity to the Starknet
// identity + every per-account EOA, the exact linkage the threat model forbids
// (docs/threat-model.md). So the list lives only on this
// device, namespaced by EVM address, and is fully reconstructable from chain
// via accountScan.scanDerivedAccounts.
//
// Persistence policy: only
// public-or-recomputable fields live here — addresses, tx hashes, the commitment
// H, the fixed amount, a coarse timestamp, a lifecycle tag. NEVER private keys,
// the raw wallet signature, or claim secrets (those stay in-memory, recomputed
// on demand). The accountIndex + viewing key recompute every secret, so storing
// the index is safe (the same bar the legacy per-account index counter /
// pmp.inflightBurn clear).

// Coarse lifecycle of a derived account's funds. M2 terminal is `minted` (USDC
// funded on the per-account Polygon EOA). The later tags are reserved for the
// unbuilt wrap/CLOB (M9) and return/claim (M10) legs so the UI's information
// architecture stays stable as those land. `recovered` marks an account rebuilt
// from the signature whose on-chain status hasn't been re-confirmed (it
// definitely burned — an index is only consumed after a successful bridge —
// but mint may still be pending).
export type AccountLifecycle =
  | 'burned'
  | 'attesting'
  | 'minted'
  | 'failed'
  | 'recovered'
  | 'wrapped'
  | 'ordered'
  | 'returning'
  | 'claimed';

export interface DerivedAccountRecord {
  // Primary key: the non-secret per-account index. With the viewing key it
  // recomputes the EOA / account_nonce / claim_secret / H, so it is safe to
  // persist on its own.
  accountIndex: number;
  // Fixed denomination (human units), e.g. "1".
  amountHuman: string;
  // The per-account Polygon EOA that OWNS the deposit wallet + signs its orders
  // (POLY_1271). Public; the signer identity for the account. The USDC mints to
  // the deposit wallet (`funder`), not this address.
  eoaAddress: string;
  // Starknet withdraw+burn tx (public). Present once the bridge lands.
  burnTxHash?: string;
  // Polygon receiveMessage tx (public). Present once the mint lands.
  polygonTxHash?: string;
  // Per-account commitment H (public; recomputable). Reserved for the return leg.
  commitmentH?: string;
  // Polymarket market id this account targets. Reserved until the CLOB leg (M9).
  marketId?: string;
  // The CLOB tokenId (== ERC-1155 positionId) of the outcome bought. Public;
  // recorded for the account HISTORY once an order posts. (Live holdings are
  // discovered storage-free via the Data API, polymarket/positions-discovery.ts
  // — not required for that.)
  tokenId?: string;
  // The CREATE2 deposit wallet (order maker) — the CCTP mint recipient that holds
  // the funds + the resulting outcome shares. Set at funding time (the mint
  // target) and confirmed at trade time (same derived address). Public.
  funder?: string;
  lifecycle: AccountLifecycle;
  // Epoch millis the record was first written. 0 for a recovered record (the
  // original time is unknown).
  timestamp: number;
}

const ACCOUNTS_KEY = 'pmp.bids';
// Read directly (not via the app's identity layer) to keep this module
// dependency-free; the legacy in-flight burn cursor seeds a record on first migration.
const INFLIGHT_BURN_KEY = 'pmp.inflightBurn';

// An account CHANNEL groups a counter + its record store under one id. OMITTING
// channel (the default) keeps the legacy `pmp.bids` / `pmp.bidIndex` keys, so
// existing data and every current caller behave identically. Passing a channel
// namespaces a SEPARATE counter + record store (`pmp.bids:<id>` / `pmp.bidIndex:<id>`),
// letting one EVM identity hold several INDEPENDENT channels — e.g. a reused-wallet
// "fast session" whose index allocation + records never advance or poison the
// default. The default is ABSENCE (undefined), NOT a magic string: so every string
// is a valid, distinct channel id (no reserved word), matching this store's other
// optional fields. This store handles the STORAGE namespacing (counter + records);
// the SAME channel id ALSO scopes DERIVATION downstream — it is folded into the
// Polygon EOA, the deposit wallet, and the account nonce → commitment H (see
// derivation/*.ts + ResolveDepositWalletFn), so a channel's wallets + on-chain
// commitments never collide with the default keyspace. undefined = the default
// channel, whose derivations stay byte-identical to the pre-channel code. channel is
// CALLER-TRUSTED (a compile-time constant, not external input).

// A channel's record-store key: the legacy key when no channel is given, a per-id
// suffix otherwise. The default (undefined) MUST stay `pmp.bids` (back-compat).
function accountsKeyFor(channel?: string): string {
  return channel === undefined ? ACCOUNTS_KEY : `${ACCOUNTS_KEY}:${channel}`;
}

type AccountsMap = Record<string, DerivedAccountRecord[]>;

// EVM address (40 hex) shape used to validate the persisted EOA recipient before
// trusting it — mirrors the app's own isValidInflightBurn validator.
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_RE = /^0x[0-9a-fA-F]+$/;
// CLOB tokenId / ERC-1155 positionId: a non-empty decimal string (often > 2^53,
// so kept as a string and validated by shape, not parsed to a number).
const DECIMAL_RE = /^[0-9]+$/;

const LIFECYCLES: ReadonlySet<string> = new Set([
  'burned',
  'attesting',
  'minted',
  'failed',
  'recovered',
  'wrapped',
  'ordered',
  'returning',
  'claimed',
]);

// Migrate-on-read: a record persisted before the Slice R rename used the legacy
// pre-Slice-R index field name instead of `accountIndex` (the localStorage key
// STRING is unchanged; only this in-record field name moved; see the property
// read below). Accept the old key here so existing
// history isn't dropped by the rename.
function migrateAccountIndexKey(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (record.accountIndex === undefined && typeof record.bidIndex === 'number') {
    const { bidIndex, ...rest } = record;
    return { ...rest, accountIndex: bidIndex };
  }
  return value;
}

// Validate a persisted account record before trusting it. A half-written or
// corrupt entry must be dropped rather than rendered (or fed to an explorer
// link / a future fund-moving action). Only the required fields are checked
// strictly; optional hashes are validated only when present.
export function isValidAccountRecord(value: unknown): value is DerivedAccountRecord {
  const migrated = migrateAccountIndexKey(value);
  if (!migrated || typeof migrated !== 'object') return false;
  const record = migrated as Record<string, unknown>;
  if (
    typeof record.accountIndex !== 'number' ||
    !Number.isInteger(record.accountIndex) ||
    record.accountIndex < 0
  ) {
    return false;
  }
  if (typeof record.amountHuman !== 'string' || record.amountHuman.length === 0) return false;
  if (typeof record.eoaAddress !== 'string' || !EVM_ADDRESS_RE.test(record.eoaAddress)) return false;
  if (typeof record.lifecycle !== 'string' || !LIFECYCLES.has(record.lifecycle)) return false;
  if (typeof record.timestamp !== 'number' || !Number.isFinite(record.timestamp)) return false;
  if (record.burnTxHash !== undefined && (typeof record.burnTxHash !== 'string' || !HEX_RE.test(record.burnTxHash))) {
    return false;
  }
  if (record.polygonTxHash !== undefined && (typeof record.polygonTxHash !== 'string' || !HEX_RE.test(record.polygonTxHash))) {
    return false;
  }
  if (record.tokenId !== undefined && (typeof record.tokenId !== 'string' || !DECIMAL_RE.test(record.tokenId))) {
    return false;
  }
  if (record.funder !== undefined && (typeof record.funder !== 'string' || !EVM_ADDRESS_RE.test(record.funder))) {
    return false;
  }
  return true;
}

function readAccountsMap(channel?: string): AccountsMap {
  try {
    const raw = localStorage.getItem(accountsKeyFor(channel));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as AccountsMap;
    return {};
  } catch {
    return {};
  }
}

function writeAccountsMap(map: AccountsMap, channel?: string): void {
  try {
    localStorage.setItem(accountsKeyFor(channel), JSON.stringify(map));
  } catch {
    // Best-effort: the history list is a convenience; a storage failure must not
    // break the funding flow (the flow's own resume cursor is written separately).
  }
}

// Read the account history for an EVM address, newest first, dropping any
// corrupt record.
export function readDerivedAccounts(
  evmAddress: string,
  channel?: string,
): DerivedAccountRecord[] {
  if (!evmAddress) return [];
  const rawList = readAccountsMap(channel)[evmAddress.toLowerCase()];
  const list: unknown[] = Array.isArray(rawList) ? rawList : [];
  return list
    .map(migrateAccountIndexKey)
    .filter(isValidAccountRecord)
    .slice()
    .sort((a, b) => b.accountIndex - a.accountIndex);
}

// Insert or update (by accountIndex) a record, merging onto any existing one so
// a later lifecycle update (burned -> minted) keeps earlier fields. Never
// DEMOTES a terminal lifecycle: a `minted`/`claimed` record won't be pushed
// back to `recovered`/`burned` by a stale write.
const LIFECYCLE_RANK: Record<AccountLifecycle, number> = {
  recovered: 0,
  burned: 1,
  attesting: 2,
  failed: 2,
  minted: 3,
  wrapped: 4,
  ordered: 5,
  returning: 6,
  claimed: 7,
};

export function upsertDerivedAccount(
  evmAddress: string,
  patch: Partial<DerivedAccountRecord> & { accountIndex: number },
  channel?: string,
): void {
  if (!evmAddress) return;
  const key = evmAddress.toLowerCase();
  const map = readAccountsMap(channel);
  const rawEntry = map[key];
  const list: DerivedAccountRecord[] = (
    Array.isArray(rawEntry) ? rawEntry.map(migrateAccountIndexKey) : []
  ).filter(isValidAccountRecord);
  const existing = list.find((record) => record.accountIndex === patch.accountIndex);

  const merged: DerivedAccountRecord = {
    accountIndex: patch.accountIndex,
    amountHuman: patch.amountHuman || existing?.amountHuman || '',
    eoaAddress: patch.eoaAddress || existing?.eoaAddress || '',
    burnTxHash: patch.burnTxHash ?? existing?.burnTxHash,
    polygonTxHash: patch.polygonTxHash ?? existing?.polygonTxHash,
    commitmentH: patch.commitmentH ?? existing?.commitmentH,
    marketId: patch.marketId ?? existing?.marketId,
    tokenId: patch.tokenId ?? existing?.tokenId,
    funder: patch.funder ?? existing?.funder,
    lifecycle: pickLifecycle(existing?.lifecycle, patch.lifecycle),
    timestamp: existing?.timestamp ?? patch.timestamp ?? Date.now(),
  };
  // A merged record can be invalid only if the caller passed garbage for a NEW
  // account (e.g. a bad EOA); drop silently rather than persist an unrenderable row.
  if (!isValidAccountRecord(merged)) return;

  const next = list.filter((record) => record.accountIndex !== patch.accountIndex);
  next.push(merged);
  map[key] = next;
  writeAccountsMap(map, channel);
}

// Keep the higher-ranked lifecycle so updates never regress a settled account.
// `failed` is terminal below `minted`: it blocks demotion to lower states (e.g.
// a stale `attesting` re-write must not revive a failed account) but is still
// overridable by `minted` or higher (a late successful mint takes precedence).
function pickLifecycle(
  existing: AccountLifecycle | undefined,
  next: AccountLifecycle | undefined,
): AccountLifecycle {
  if (!next) return existing ?? 'recovered';
  if (!existing) return next;
  if (next === 'failed') return LIFECYCLE_RANK[existing] >= LIFECYCLE_RANK.minted ? existing : 'failed';
  if (existing === 'failed') return LIFECYCLE_RANK[next] >= LIFECYCLE_RANK.minted ? next : 'failed';
  return LIFECYCLE_RANK[next] >= LIFECYCLE_RANK[existing] ? next : existing;
}

// One-time migration: seed the history from the legacy in-flight burn cursor so
// an account mid-flight before this store existed still shows up. Idempotent —
// upsert by accountIndex won't duplicate. The already-completed accounts of the
// past aren't in any store (they only ever lived in transient result state);
// use accountScan.scanDerivedAccounts to rebuild them from chain.
export function migrateLegacyAccounts(evmAddress: string): void {
  if (!evmAddress) return;
  try {
    const raw = localStorage.getItem(INFLIGHT_BURN_KEY);
    if (!raw) return;
    const map = JSON.parse(raw) as Record<string, unknown>;
    const inflight = map[evmAddress.toLowerCase()] as Record<string, unknown> | undefined;
    if (!inflight) return;
    if (
      typeof inflight.bidIndex === 'number' &&
      typeof inflight.eoaAddress === 'string' &&
      EVM_ADDRESS_RE.test(inflight.eoaAddress) &&
      typeof inflight.amountHuman === 'string'
    ) {
      // Route the migrated record into the CHANNEL the burn belonged to — the cursor
      // records it for non-default channels. Without this, a session-channel burn
      // would seed its reserved-band index into the DEFAULT `pmp.bids`, skewing the
      // default peekNextAccountIndex up into the band (Bugbot). Absent → default.
      const channel = typeof inflight.channel === 'string' ? inflight.channel : undefined;
      upsertDerivedAccount(
        evmAddress,
        {
          accountIndex: inflight.bidIndex,
          amountHuman: inflight.amountHuman,
          eoaAddress: inflight.eoaAddress,
          // The deposit wallet (mint recipient / order maker), when the cursor
          // carries it; pre-redirect cursors lack it (minted to the bare EOA).
          funder:
            typeof inflight.depositWallet === 'string' && EVM_ADDRESS_RE.test(inflight.depositWallet)
              ? inflight.depositWallet
              : undefined,
          burnTxHash: typeof inflight.burnTxHash === 'string' && HEX_RE.test(inflight.burnTxHash)
            ? inflight.burnTxHash
            : undefined,
          lifecycle: 'attesting',
          timestamp: Date.now(),
        },
        channel,
      );
    }
  } catch {
    // Migration is best-effort; ignore a corrupt legacy blob.
  }
}

// A persisted in-flight BURN cursor (pmp.inflightBurn) is a funding op whose
// CCTP burn committed but whose mint hasn't landed — resumable only from this
// device's storage. Validate its required fields (mirrors the app's own
// isValidInflightBurn): a non-negative integer index, eoaAddress a 40-hex EVM
// address, burnTxHash a 0x-hex string, amountHuman a non-empty string. A
// corrupt/partial record is NOT counted (it can't be safely resumed off garbage).
//
// This cursor is still owned/written by the app's identity layer (migrating it
// into core is a later slice), so it still uses the legacy field name on disk —
// unchanged here.
function isValidInflightBurnRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.bidIndex === 'number' &&
    Number.isInteger(r.bidIndex) &&
    r.bidIndex >= 0 &&
    typeof r.eoaAddress === 'string' &&
    EVM_ADDRESS_RE.test(r.eoaAddress) &&
    typeof r.burnTxHash === 'string' &&
    HEX_RE.test(r.burnTxHash) &&
    typeof r.amountHuman === 'string' &&
    r.amountHuman.length > 0
  );
}

// Per-account index counter (NON-SECRET), keyed by EVM address (bridge-sdk-
// Slice D). The index is a plain integer; knowing it computes
// nothing without the viewing key, so it is NOT a key and the no-persist-keys
// rule holds. The viewing key folds it into account_nonce/the per-account EOA,
// so every account is unlinkable and recomputable from the signature + this
// saved index (Decision 3). Same `pmp.bidIndex` key STRING
// the app used pre-migration (Decision 6, §1.1) — renaming the wire key would
// orphan an in-flight counter, the same fund-safety class as ACCOUNTS_KEY.
const ACCOUNT_INDEX_KEY = 'pmp.bidIndex';

// A channel's counter key: the legacy key when no channel is given, a per-id
// suffix otherwise (mirrors accountsKeyFor). The default MUST stay `pmp.bidIndex`.
function accountIndexKeyFor(channel?: string): string {
  return channel === undefined ? ACCOUNT_INDEX_KEY : `${ACCOUNT_INDEX_KEY}:${channel}`;
}

type AccountIndexMap = Record<string, number>;

// Validate + drop any entry that isn't a non-negative integer (#137): a corrupt
// or float counter (e.g. `1.5`, reachable via devtools tampering or a bad
// migration) would compound forever through consumeAccountIndex (index+1) and
// derive the WRONG per-account EOA. Dropping bad entries falls back to the
// default-0 first-account behavior for that address, which is safe
// (nextAccountIndex still reconciles against existing accounts).
function readAccountIndexMap(channel?: string): AccountIndexMap {
  try {
    const raw = localStorage.getItem(accountIndexKeyFor(channel));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const validated: AccountIndexMap = {};
    for (const [addr, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
        validated[addr] = value;
      }
    }
    return validated;
  } catch {
    return {};
  }
}

// Reconcile the stored counter against the accounts actually present so the
// picked index can NEVER collide with an existing one. `scanDerivedAccounts`
// upserts recovered accounts into `pmp.bids` WITHOUT bumping the counter, so
// the counter can lag the real accounts (e.g. counter=4 while accounts run up
// to 11); re-picking a used index would re-derive an already-used deposit
// wallet and overwrite that account (often inheriting its `claimed`
// lifecycle). Taking max(counter, highestExisting+1) closes that gap; empty
// accounts (highestExisting = -1) leave the counter untouched, so the
// default-0 first-account behavior is preserved. Pure for unit testing.
export function nextAccountIndex(counter: number, accounts: DerivedAccountRecord[]): number {
  const highestExisting = accounts.reduce((max, account) => Math.max(max, account.accountIndex), -1);
  return Math.max(counter, highestExisting + 1);
}

// The next unused per-account index for an EVM address (0 on first account).
export function peekNextAccountIndex(
  evmAddress: string,
  channel?: string,
): number {
  const map = readAccountIndexMap(channel);
  const counter = map[evmAddress.toLowerCase()] ?? 0;
  // Reconcile against THIS channel's records only, so a channel's records never
  // advance another channel's next index.
  return nextAccountIndex(counter, readDerivedAccounts(evmAddress, channel));
}

// Persist `index` as consumed so the NEXT account uses `index + 1`.
// Best-effort — a storage failure must not break the funding flow (the EOA
// still recovers from the signature + the index actually used this run).
export function consumeAccountIndex(
  evmAddress: string,
  index: number,
  channel?: string,
): void {
  try {
    const map = readAccountIndexMap(channel);
    map[evmAddress.toLowerCase()] = index + 1;
    localStorage.setItem(accountIndexKeyFor(channel), JSON.stringify(map));
  } catch {
    // ignore (persistence is a convenience).
  }
}

// Raise the persisted counter to at least `minNextIndex` (monotonic — never
// lowers it). Used to SEED the counter from an on-chain used-wallet scan so a
// fresh browser / cleared storage / different device can't re-pick an index
// already used elsewhere (the cross-device reuse gap `nextAccountIndex`'s
// local-only reconciliation can't close on its own). `minNextIndex` is
// `highestChainUsedIndex + 1`. Belt-and-suspenders alongside the `pmp.bids`
// reconciliation: it survives a later `pmp.bids` prune. Best-effort, same as
// consumeAccountIndex — a storage failure must not break bidding.
export function seedAccountIndex(
  evmAddress: string,
  minNextIndex: number,
  channel?: string,
): void {
  if (!Number.isInteger(minNextIndex) || minNextIndex <= 0) return;
  try {
    const map = readAccountIndexMap(channel);
    const key = evmAddress.toLowerCase();
    map[key] = Math.max(map[key] ?? 0, minNextIndex);
    localStorage.setItem(accountIndexKeyFor(channel), JSON.stringify(map));
  } catch {
    // ignore (persistence is a convenience).
  }
}

// FUND-SAFETY (Bugbot HIGH — "Switch guard skips burn cursors"): the funder-
// AGNOSTIC reader for the account BURN cursor, the sibling of hasAnyInflightDeposit /
// hasAnyInflightReturn. A network switch disconnect()s and wipes ALL pmp.* cursors
// (incl. pmp.inflightBurn), so a burn-but-not-minted account in flight would be
// stranded. Scans the whole per-address cursor map and returns true iff ANY
// address has a VALID (resumable, non-corrupt) burn cursor. Cheap synchronous
// localStorage read; safe to call from render.
export function hasAnyInflightBurn(): boolean {
  try {
    const raw = localStorage.getItem(INFLIGHT_BURN_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return false;
    return Object.values(parsed as Record<string, unknown>).some(isValidInflightBurnRecord);
  } catch {
    return false;
  }
}
