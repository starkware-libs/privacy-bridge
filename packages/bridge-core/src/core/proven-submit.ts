import type { Account, AllowArray, Call, RpcProvider } from 'starknet';
import { stark } from 'starknet';
import { config } from './config';
import { makeAccount } from './provider';
import {
  buildTransaction,
  executeTransaction,
  toAvnuCall,
  type AvnuCall,
  type AvnuFeeMode,
  type AvnuTxType,
  type AvnuExecutableApplyAction,
  type AvnuExecutionParameters,
} from './avnuPaymaster';

// --- Manager-paid (proven) transaction submission --------------------------------
//
// apply_actions calls (register / deposit / withdraw) are PROVEN client-side by the
// SDK and then submitted to ACTUAL Starknet, where they cost REAL gas (the proving
// phase — with its own zero-fee virtual-exec bounds — is handled INTERNALLY by the
// SDK; what we submit here is the on-chain invoke, which pays a real fee).
//
// To keep the derived user account STRK-free (unlinkability), a MANAGER account
// (config.admin, the dev treasury) is the SENDER / fee-payer of the on-chain invoke.
// This is sound because the proven leg is sender-agnostic — verified against the
// pool Cairo + SDK (starknet-privacy 0.14.2-rc.x):
//   - The user's identity rides in the PROVEN CALLDATA, not in get_caller_address:
//     the SDK's ProofInvocationFactory proves compile_actions(userAddress, viewingKey,
//     actions); the on-chain Call is apply_actions(Span<ServerAction>), whose fund
//     moves use addresses embedded in the actions (TransferFromInput.from_addr), NOT
//     the caller (privacy.cairo _apply_transfer_from).
//   - The proof binds NO sender: validate_proof → compute_message_hash(actions,
//     contract_address) hashes only the POOL address, its class hash, and the actions
//     — never a sender/account address (utils.cairo). apply_actions has no caller
//     assertion. So a different sender (the manager) does not break verification.
//   - The ONE place the sender matters is collect_fee(): it pulls the pool's STRK
//     protocol fee from get_caller_address() — i.e. from the MANAGER (the sender).
//     The pre-approve of that fee must therefore come from the manager too (see
//     approveFromManager / the call sites).
//
// TODO(monday-item): replace manager-paid submit with AVNU paymaster (SNIP-29).
//
// Why EXPLICIT resourceBounds are still required: starknet@10's Account.execute runs
// an implicit estimateInvokeFee when `resourceBounds` is ABSENT, and that estimate
// path DROPS proof/proofFacts → the pool re-runs apply_actions WITHOUT its proof
// during estimation and reverts before the real invoke is ever sent. So we always
// pass explicit v3 bounds and the proof rides on the one and only invoke.
//
// The bounds are sized off the golden on-chain register apply_actions (l2_gas≈151.5M
// consumed @ ~12e9 fri; l1_data≈7K; l1≈0) plus the LIVE block prices with modest
// headroom. The bound's IMPLIED max fee (Σ max_amount * max_price_per_unit) is what
// __validate__ checks against the SENDER's balance up front (code 55, "Resources
// bounds … exceed balance"); it stays a few STRK, which the manager treasury covers
// comfortably. The user account is never the sender, so it is never weighed here.

// ResourceBoundsBN (the bigint form Account.execute accepts as `resourceBounds`).
export interface ProofResourceBounds {
  l1_gas: { max_amount: bigint; max_price_per_unit: bigint };
  l2_gas: { max_amount: bigint; max_price_per_unit: bigint };
  l1_data_gas: { max_amount: bigint; max_price_per_unit: bigint };
}

// Worst-case resource AMOUNTS for a single proof-bearing apply_actions, sized with
// generous headroom over the observed golden register apply_actions (l2_gas≈151.5M,
// l1_data≈7K consumed; l1_gas 0). A bare register is cheaper, so these comfortably
// cover register, deposit and withdraw+invoke alike. Exported so the regression test
// can assert the implied fee stays bounded.
//
// SHARED KNOB (all proven legs): the RETURN claim (bridgeBack.ts) now FOLDS the CCTP
// `receive_message` (Circle attestation verify → secp256 signature checks) INTO its
// `apply_actions`, so the folded trace costs materially more l2_gas than a bare
// apply_actions (mock ≈110M for the fold on top of the ≈151.5M apply_actions; the REAL
// on-chain attestation verify is HIGHER). This amount is raised to cover it, kept as
// large as the coarse manager-path fee guard allows. The implied fee SCALES with the
// live l2 price (max_amount × max_price_per_unit): ≈9.72 STRK at the floor price, ≈9.94
// STRK at the current test fixture (live l2 8e9, so l2 stays at the 16e9 floor while
// l1/l1_data take the ×1.5 headroom), and ≈11.1 STRK at the golden live l2 price (12e9 →
// ×1.5 headroom = 18e9 > floor). So it is NOT a hard ≤10-STRK cap — MAX_FEE_CEILING_WEI
// (below) is a coarse regression guard set ABOVE that realistic worst-case. NOTE:
// production submits the claim via the AVNU paymaster, which sizes its OWN bounds — this
// amount only gates the MANAGER-paid (testnet/dev) path. LIVE-VERIFY
// (.claude/rules/verification.md): the exact folded-claim l2_gas MUST be confirmed
// against a live folded claim on testnet; if it exceeds this bound, RAISE this AND
// MAX_FEE_CEILING_WEI (+ the regression test) together.
export const MAX_L2_GAS = 580_000_000n;
export const MAX_L1_DATA_GAS = 20_000n;
export const MAX_L1_GAS = 2_000n;

// Per-unit price FLOORS (fri), grounded in the golden/live block prices with a
// modest margin. Also the fallback when the live price read fails:
//   l2  16e9  (golden 12e9 → 1.33x; typical 8e9 → 2x);
//   l1_data 2e12 (golden ~6.2e11 → ~3x);
//   l1  2e14 (live l1 ≈ 1.03e14 → ~2x; l1_gas amount is tiny so its cap is cheap).
export const FLOOR_L2_GAS_PRICE = 16_000_000_000n;
export const FLOOR_L1_DATA_GAS_PRICE = 2_000_000_000_000n;
export const FLOOR_L1_GAS_PRICE = 200_000_000_000_000n;

// Multiplier (×3/2) applied to the live per-unit price so a mild price rise between
// read and inclusion can't push the actual price above our ceiling, while keeping
// the implied bound total small. Applied as `* PRICE_HEADROOM_NUM / PRICE_HEADROOM_DEN`.
const PRICE_HEADROOM_NUM = 3n;
const PRICE_HEADROOM_DEN = 2n;

// COARSE regression guard on the implied MAX fee of any bounds
// buildProofResourceBounds can produce — the manager treasury is funded well above it.
// Its job is to catch a PRICE/AMOUNT regression that BALLOONS the bound (the reverted
// ~1e16-price / ~1812-STRK ceiling bug — see the MUTATION test), NOT to be a tight
// per-tx cap: the legitimate implied fee scales with the live l2 price (≈9.72 STRK at
// floor, ≈9.94 STRK at the 8e9 fixture, ≈11.1 STRK at the golden 12e9 l2 price with
// ×1.5 headroom, higher on a price spike). 15 STRK sits above that realistic worst-case
// yet is orders of magnitude below the absurd-regression it guards. If a live folded
// claim needs a bigger l2_gas bound, raise this AND MAX_L2_GAS together.
export const MAX_FEE_CEILING_WEI = 15n * 10n ** 18n;

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function withHeadroom(price: bigint): bigint {
  return (price * PRICE_HEADROOM_NUM) / PRICE_HEADROOM_DEN;
}

function priceFromHeader(value: unknown): bigint | undefined {
  if (value && typeof value === 'object' && 'price_in_fri' in value) {
    const fri = (value as { price_in_fri?: unknown }).price_in_fri;
    if (typeof fri === 'string' || typeof fri === 'number' || typeof fri === 'bigint') {
      try {
        return BigInt(fri);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

// Builds explicit v3 resource bounds for a proof-bearing on-chain submit. Reads the
// latest block's per-unit gas prices and quotes max(headroom*livePrice, priceFloor)
// so the bound is comfortably above the chain price WITHOUT inflating the implied
// fee. Any failure to read a price falls back to the floor — never throws, never
// blocks the submit. The implied MAX fee (Σ max_amount * max_price_per_unit) stays a
// few STRK (see MAX_FEE_CEILING_WEI / the regression test), well within the manager
// treasury — the code-55 failure mode never fires for the manager.
export async function buildProofResourceBounds(
  provider: RpcProvider,
): Promise<ProofResourceBounds> {
  let l2Price = FLOOR_L2_GAS_PRICE;
  let l1DataPrice = FLOOR_L1_DATA_GAS_PRICE;
  let l1Price = FLOOR_L1_GAS_PRICE;
  try {
    // The RPC block header carries l1_gas_price / l2_gas_price / l1_data_gas_price,
    // each { price_in_fri, price_in_wei }. Not strongly typed on this helper, so
    // read defensively.
    const header = (await provider.getBlockWithTxHashes('latest')) as Record<string, unknown>;
    const livedL2 = priceFromHeader(header.l2_gas_price);
    const livedL1Data = priceFromHeader(header.l1_data_gas_price);
    const livedL1 = priceFromHeader(header.l1_gas_price);
    if (livedL2 !== undefined) l2Price = max(l2Price, withHeadroom(livedL2));
    if (livedL1Data !== undefined) l1DataPrice = max(l1DataPrice, withHeadroom(livedL1Data));
    if (livedL1 !== undefined) l1Price = max(l1Price, withHeadroom(livedL1));
  } catch {
    // Keep the static floors.
  }
  return {
    l1_gas: { max_amount: MAX_L1_GAS, max_price_per_unit: l1Price },
    l2_gas: { max_amount: MAX_L2_GAS, max_price_per_unit: l2Price },
    l1_data_gas: { max_amount: MAX_L1_DATA_GAS, max_price_per_unit: l1DataPrice },
  };
}

// Implied MAX fee (fri/wei) for a set of bounds: Σ max_amount * max_price_per_unit.
// This is the exact quantity __validate__ compares against the sender's balance, so
// the regression test pins to it (and asserts it stays ≤ MAX_FEE_CEILING_WEI).
export function maxFeeFromBounds(bounds: ProofResourceBounds): bigint {
  return (
    bounds.l1_gas.max_amount * bounds.l1_gas.max_price_per_unit +
    bounds.l2_gas.max_amount * bounds.l2_gas.max_price_per_unit +
    bounds.l1_data_gas.max_amount * bounds.l1_data_gas.max_price_per_unit
  );
}

// Builds the MANAGER (gas-funder) Account from config.admin. The manager is the
// sender / fee-payer of every proven on-chain submit, so the derived user account
// stays STRK-free (unlinkability). Throws if no admin is configured (production
// build, or missing ADMIN_* in dev) — the proven legs cannot be paid without it
// until the AVNU paymaster replaces this (TODO(monday-item)).
//
// Prefer managerExecute() for SUBMITTING manager txs — it serializes them and
// assigns sequential nonces (see below). This builder is for callers that only
// need the manager's address/identity, and for managerExecute's own shared instance.
export function getManagerAccount(provider?: RpcProvider): Account {
  const admin = config.admin;
  if (!admin?.privateKey) {
    throw new Error(
      'No manager (admin) account configured — proven pool submits are manager-paid ' +
        'on testnet (set ADMIN_* in dev). Production must use the AVNU paymaster ' +
        '(TODO(monday-item): SNIP-29).',
    );
  }
  return makeAccount(admin.address, admin.privateKey, provider);
}

// --- Serialized manager-nonce manager --------------------------------------------
//
// THE BUG THIS FIXES: a single make-private/fund-account flow has the MANAGER submit SEVERAL
// txs back-to-back (register → fee-approve → deposit → … → withdraw). starknet's
// Account.execute re-reads the sender's nonce per call, but a just-submitted tx that
// is only PRE-CONFIRMED is NOT reflected in the RPC nonce yet, so the next submit
// re-reads the stale nonce and the node rejects it (code 52, "Invalid transaction
// nonce. Expected: N+1, got: N"). Observed live: register at nonce 430 → pre-
// confirmed, deposit re-read 430 → REJECTED.
//
// THE FIX — the LOCAL counter is AUTHORITATIVE once seeded (maintainer constraint):
//   - SEED ONCE: on the first manager submit of a session (localNonce undefined),
//     read the manager's nonce from chain exactly once.
//   - REUSE, NEVER RE-READ: every subsequent submit uses the stored localNonce as the
//     EXPLICIT nonce, then bumps it by 1n on success. There is NO per-submit RPC read
//     and NO max(rpcNonce, local) — a stale-but-lower RPC nonce (the pre-confirmed
//     lag) must never influence the next nonce.
//   - SERIALIZE: submits run one-at-a-time via a promise-chain mutex, so two submits
//     (e.g. a deposit's approve + its proven invoke) can't read+use the same counter
//     concurrently.
//   - CODE-52 RECOVERY IS IN-CALL, NO SETTLEMENT WAIT: a code-52 ("Invalid transaction
//     nonce") means the submit was REJECTED — the rejected tx never advances the chain
//     nonce, so the nonce we used is immediately reusable. We re-read the manager nonce
//     at `pre_confirmed` (the cheap fast path; mirrors private-kyc's getNonce path) and
//     retry IN THE SAME queued call, bounded by MAX_NONCE_RETRIES. We do NOT enter the
//     settlement-guarded re-seed here: a poll for the chain to "catch up" past the
//     rejected nonce would always time out (it never advances).
//   - SETTLEMENT-GUARDED RE-SEED IS THE FALLBACK ONLY: reserved for the unknown /
//     persistent-failure path (code-52 still failing after MAX_NONCE_RETRIES, or a
//     non-nonce error that left an in-flight pre-confirmed tx). There we invalidate the
//     local counter so the NEXT submit re-seeds — and seedManagerNonce polls getNonce
//     until it catches up past the last nonce we used before trusting it.
//
// TODO(monday-item): this serializes WITHIN one browser session only. CONCURRENT
// sessions sharing the same admin/manager account can still collide on the nonce — a
// real manager service needs a SERVER-SIDE nonce queue (alongside the AVNU paymaster
// TODO above, which removes the shared manager entirely).

// Shared manager Account — built ONCE (lazily) and reused so its nonce sequence is
// single-sourced. NOT rebuilt when a different provider instance is passed: within a
// flow the approve and the proven submit may carry distinct getRpcProvider() objects,
// and rebuilding (resetting the counter) between them would re-introduce the lagging-
// nonce collision. The manager Account binds its own provider at construction.
let sharedManager: Account | undefined;
// Local nonce counter; undefined means "re-seed from chain on next submit".
let localNonce: bigint | undefined;
// The last nonce actually handed to a submit. Used by the settlement-guarded re-seed
// after a failure so we wait for the chain to catch up past it before trusting a read.
let lastUsedNonce: bigint | undefined;
// Whether the last submit MIGHT be in-flight (pre-confirmed but lagging the RPC
// nonce) — true only after a persistent code-52, where an EARLIER tx is settling and
// the chain nonce will advance PAST lastUsedNonce on its own. A non-nonce reject
// (balance/signature/RPC) throws pre-acceptance, so its nonce is UNCONSUMED and the
// chain never advances past it — that path stays false. Gates the re-seed settlement
// comparison below (`<=` / wait-for-strictly-greater when maybe-in-flight; `<` /
// seed-immediately otherwise) — see seedManagerNonce.
let lastSubmitMaybeInFlight = false;
// Promise-chain tail that serializes manager submits (the async mutex).
let submitChain: Promise<unknown> = Promise.resolve();

// Poll budget for the settlement-guarded re-seed: wait for the RPC nonce to advance
// past the last-used nonce before trusting it (a pre-confirmed tx lags the RPC nonce).
const RESEED_POLL_INTERVAL_MS = 1500;
const RESEED_POLL_TIMEOUT_MS = 120_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// code 52 = "Invalid transaction nonce. Expected: N+1, got: N" — the submit was
// REJECTED (not pre-confirmed), so the nonce we used is reusable. Matches the
// private-kyc invalid_nonce recovery (no settlement wait on a rejected nonce):
// re-read at pre_confirmed and retry in-call.
const NONCE_ERROR_RE = /invalid transaction nonce|\bcode:?\s*52\b|nonce too (old|low|big)/i;
function isNonceError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return NONCE_ERROR_RE.test(m);
}
// Bounded in-call retries on a stale nonce before giving up (then the next submit
// re-seeds, settlement-guarded).
const MAX_NONCE_RETRIES = 3;

function getSharedManager(provider: RpcProvider): Account {
  if (!sharedManager) {
    sharedManager = getManagerAccount(provider);
  }
  return sharedManager;
}

// COLD-resets the manager-nonce state so the next managerExecute re-seeds directly
// from chain WITHOUT the settlement-guard wait. Use this only when the caller knows
// NOTHING of ours is in flight (an out-of-band manager tx landed, or a fresh test).
// NOT used on the in-flight failure path — that keeps lastUsedNonce so the re-seed
// can wait for the chain to settle past it.
export function invalidateManagerNonce(): void {
  localNonce = undefined;
  lastUsedNonce = undefined;
  lastSubmitMaybeInFlight = false;
}

// Reads the manager's on-chain nonce, preferring `pre_confirmed` (reflects in-flight
// txs the node has accepted but not yet committed) and falling back to `latest` if
// the node doesn't serve that tag. Returns a bigint. NOTE: even `pre_confirmed` can
// lag a just-pre-confirmed tx, which is exactly why this is only ever called to SEED
// (once, when nothing is in flight) — never on the back-to-back increment path.
async function fetchManagerNonce(account: Account): Promise<bigint> {
  try {
    return BigInt(await account.getNonce('pre_confirmed'));
  } catch {
    return BigInt(await account.getNonce('latest'));
  }
}

// Seeds localNonce for the FIRST submit of a (re-)sequence.
//   - First submit ever (lastUsedNonce undefined → nothing in flight): trust the
//     chain read directly.
//   - Re-seed after a failure (lastUsedNonce set): the failed/in-flight tx may still
//     be pre-confirmed and lagging the RPC nonce, so DON'T trust an immediate read —
//     poll getNonce until it reflects at least lastUsedNonce (i.e. the prior tx has
//     settled enough to advance the chain nonce), then seed from that settled value.
//     On poll timeout, fall back to the last read rather than block forever.
async function seedManagerNonce(account: Account): Promise<bigint> {
  if (lastUsedNonce === undefined) {
    // Cold start: nothing of ours is in flight — the chain read is authoritative.
    return fetchManagerNonce(account);
  }
  // Settlement-guarded re-seed. The account nonce only advances to N+1 AFTER the tx
  // that USED nonce N is accepted. The correct boundary depends on the prior submit's
  // state:
  //   - MAYBE-IN-FLIGHT (persistent code-52: an earlier tx is pre-confirmed and
  //     lagging the RPC nonce): chainNonce === lastUsedNonce still means it has NOT
  //     settled, so seeding there would re-hand the in-flight nonce to the next submit
  //     (a spurious code-52). Wait for a STRICTLY-GREATER read (`> lastUsedNonce`).
  //   - DEFINITELY-UNCONSUMED (non-nonce reject — balance/signature/RPC threw
  //     pre-acceptance, or a cold reset): the chain will NEVER advance past
  //     lastUsedNonce on its own, so seed at chainNonce === lastUsedNonce immediately
  //     (`>= lastUsedNonce`) — waiting would stall the whole RESEED_POLL_TIMEOUT_MS.
  // (The off-by-one bug, #65, was a blanket `chainNonce < lastUsedNonce`, which
  // exited at chainNonce === lastUsedNonce even for the maybe-in-flight case, reusing
  // the still-pending nonce.)
  const last = lastUsedNonce;
  const settled = (n: bigint): boolean => (lastSubmitMaybeInFlight ? n > last : n >= last);
  const deadline = Date.now() + RESEED_POLL_TIMEOUT_MS;
  let chainNonce = await fetchManagerNonce(account);
  while (!settled(chainNonce) && Date.now() < deadline) {
    await sleep(RESEED_POLL_INTERVAL_MS);
    chainNonce = await fetchManagerNonce(account);
  }
  return chainNonce;
}

// Serialized manager submit. Runs the given call(s) from the SHARED manager Account
// with an EXPLICIT, locally-sequenced nonce so back-to-back manager txs in one flow
// don't collide on a lagging RPC nonce. `details` carries the per-leg extras
// (tip, resourceBounds, proof/proofFacts) — managerExecute injects only the nonce.
//
// Concurrency: each call is appended to a promise chain, so a second managerExecute
// awaits the first's nonce assignment + increment before reading the counter.
// On a code-52 the call recovers IN-PLACE (re-read at pre_confirmed + retry, bounded by
// MAX_NONCE_RETRIES) without releasing the mutex, so the queued submit still gets the
// next sequential nonce. Only a persistent code-52 or a non-nonce failure rethrows; the
// counter is invalidated for a settlement-guarded re-seed only on a persistent code-52.
export function managerExecute(
  provider: RpcProvider,
  callOrCalls: AllowArray<Call>,
  details: Record<string, unknown> = {},
): Promise<{ transaction_hash: string }> {
  const run = async (): Promise<{ transaction_hash: string }> => {
    const account = getSharedManager(provider);
    // Seed ONCE (or after an invalidation). On the reuse path the local counter is
    // authoritative — NO RPC read, NO max(rpcNonce, local).
    if (localNonce === undefined) {
      localNonce = await seedManagerNonce(account);
    }
    let nonce = localNonce;
    for (let i = 0; ; i++) {
      lastUsedNonce = nonce;
      try {
        const res = await account.execute(callOrCalls, { ...details, nonce });
        // Advance the local counter by 1 — authoritative, no RPC re-read.
        localNonce = nonce + 1n;
        return res;
      } catch (err) {
        if (isNonceError(err) && i < MAX_NONCE_RETRIES) {
          // FAST path: a rejected nonce is reusable. Re-read at pre_confirmed and
          // retry IN-CALL — do NOT enter the settlement-guarded re-seed (the rejected
          // tx never advances the chain nonce, so that poll would always time out).
          // #91: fetchManagerNonce's pre_confirmed read can itself LAG a just-accepted
          // tx (its own header comment says so) — never let it REGRESS the local
          // counter below a value we already know is correct (nonce, the just-rejected
          // value we're retrying at). max() keeps the higher of the two so a stale RPC
          // read can't undo a locally-known-good advance.
          const rpcNonce = await fetchManagerNonce(account);
          nonce = rpcNonce > nonce ? rpcNonce : nonce;
          localNonce = nonce;
          continue;
        }
        if (isNonceError(err)) {
          // Persistent code-52 after MAX_NONCE_RETRIES: an earlier tx is in-flight /
          // settling, so the chain nonce will advance PAST lastUsedNonce on its own —
          // mark maybe-in-flight so the re-seed WAITS for a strictly-greater read.
          // Drop the counter so the NEXT submit re-seeds from settlement.
          lastSubmitMaybeInFlight = true;
          localNonce = undefined;
          throw err;
        }
        // Non-nonce failure (code-55 balance, signature, RPC/network error).
        // account.execute returns at SUBMIT time (before acceptance), so any throw
        // here is a PRE-ACCEPTANCE rejection — the nonce was NOT consumed. (A true
        // on-chain REVERT never reaches this catch; it surfaces later via
        // submitAndTrack, after this returned a hash.) So DON'T advance the counter:
        // skipping a nonce would fire N+1 against a chain expecting N → a spurious
        // code-52 on the next flow. Invalidate so the next submit re-seeds
        // settlement-guarded. The nonce was NOT consumed, so the chain will not
        // advance past lastUsedNonce on its own — mark NOT-in-flight so the re-seed
        // seeds at chainNonce === lastUsedNonce immediately (a `>` wait would stall
        // the full poll timeout). (The rare ambiguous network-timeout-where-it-landed
        // sub-case stays on this immediate path — preserving prior shipped behavior;
        // a subsequent code-52 there self-heals via the in-call recovery.)
        lastSubmitMaybeInFlight = false;
        localNonce = undefined;
        throw err;
      }
    }
  };

  // Chain onto the tail so submits run one-at-a-time; keep the tail unbroken even if
  // this submit rejects (chain on a settled promise, not the rejected `next`).
  const next = submitChain.then(run, run);
  submitChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

// proofDetails carries { proof, proofFacts } (or an empty object when the prover
// returned no facts) — starknet@10 forwards these VERBATIM onto the invoke. The
// proof is the prover's data blob and proofFacts the felt-array facts (string[]),
// both already in the shape Account.execute / invokeFunction expect. The empty
// branch matches the call sites' `… ? {…} : {}` (inferred all-optional, NOT
// Record<string, never>), so it stays assignable to UniversalDetails.
type ProofDetails =
  | { proof: string; proofFacts: string[] }
  | { proof?: undefined; proofFacts?: undefined };

// Describes the proven leg for the AVNU private-paymaster path. Most legs are a
// bare `apply_action` (register / withdraw=bridgeOut / claim=bridgeBack — the
// Anonymizer invoke rides INSIDE apply_actions as a ServerAction). The deposit is
// `invoke_and_apply_action`: it carries a user call (the USDC `approve`) the user
// signs via SNIP-9 outside-execution so AVNU's relayer can submit it.
export interface ProvenLeg {
  type?: AvnuTxType;
  userCalls?: Call[];
  // #237: forwarded to paymasterExecuteLeg so a caller of submitProvenCall's
  // paymaster fallback (register / any zero-fee leg routed through
  // submitProvenViaPaymaster) can still observe the AMBIGUOUS-RELAY boundary —
  // pre-fix this signal had no field to ride on and was silently dropped.
  onRelayStart?: () => void;
}

// Builds the AVNU fee mode from config. 'sponsored_private' pays the pool fee in
// poolFeeToken (falling back to the deposit token — the single source of truth).
function avnuFeeMode(): AvnuFeeMode {
  const pm = config.paymaster;
  if (pm && pm.feeMode === 'sponsored') return { mode: 'sponsored' };
  const poolFeeToken = pm?.poolFeeToken || config.depositToken.address;
  return { mode: 'sponsored_private', pool_fee_token: poolFeeToken };
}

// The AVNU pool fee, as returned by buildTransaction — a Withdraw the wallet MUST
// include in the proof (the forwarder collects it from that TransferTo). recipient =
// the forwarder; token/amount = the fee in the chosen pool_fee_token.
export interface PaymasterFeeAction {
  recipient: string;
  token: string;
  amount: string;
}

// Context returned by paymasterBuildLeg, carrying everything the caller needs to
// (1) inject the fee withdraw into the SDK proof and (2) execute once proven.
export interface PaymasterBuildCtx {
  type: AvnuTxType;
  parameters: AvnuExecutionParameters;
  opts: { endpoint: string; apiKey: string };
  // The pool fee to bake into the proof. Undefined / zero amount → no fee withdraw.
  feeAction?: PaymasterFeeAction;
  // SNIP-9 outside-execution typed data to sign (invoke_and_apply_action only).
  typedData?: unknown;
  // The caller's ACTUAL intended calls, in AVNU-wire shape — the source of truth
  // paymasterExecuteLeg compares ctx.typedData's embedded calls against before
  // signing (#77 calls-substitution guard). Empty for a bare apply_action leg.
  userCalls: AvnuCall[];
}

// STEP 1 of the private-paymaster flow: call buildTransaction to obtain the pool
// `fee_action` (+ the SNIP-9 `typed_data` for invoke_and_apply_action) BEFORE proving.
// The caller bakes `feeAction` into the SDK proof as a withdraw to `feeAction.recipient`
// (AVNU error 165 MISSING_FEE_TRANSFER_TO if omitted), then proves, then calls
// paymasterExecuteLeg. Does NOT submit.
export async function paymasterBuildLeg(
  account: Account,
  leg: ProvenLeg = {},
): Promise<PaymasterBuildCtx> {
  const pm = config.paymaster;
  if (!pm) {
    throw new Error('paymasterBuildLeg called without config.paymaster configured.');
  }
  const opts = { endpoint: pm.endpoint, apiKey: pm.apiKey };
  const type: AvnuTxType = leg.type ?? 'apply_action';
  const parameters: AvnuExecutionParameters = { version: '0x1', fee_mode: avnuFeeMode() };
  const userCalls = (leg.userCalls ?? []).map(toAvnuCall);

  const built = await buildTransaction(
    {
      transaction: {
        type,
        apply_action: { pool_address: config.poolAddress },
        ...(type === 'invoke_and_apply_action'
          ? { invoke: { user_address: account.address, calls: userCalls } }
          : {}),
      },
      parameters,
    },
    opts,
  );
  return {
    type,
    parameters,
    opts,
    feeAction: built.fee_action,
    typedData: built.typed_data,
    userCalls,
  };
}

// Normalize a Starknet felt252 value (hex string, decimal string, or BigInt) to a
// canonical decimal string for comparison. Non-numeric values (e.g. short test
// addresses like '0xpool') fall back to their string form — they can only match
// themselves, which is the correct security behaviour. Ported from PR #75's
// paymaster-submit.ts (deleted in the #73 rewrite) — see #77.
function normalizeFelt(value: unknown): string {
  try {
    return BigInt(String(value)).toString();
  } catch {
    return String(value);
  }
}

// Stable, order-preserving comparison of two AVNU-shape call lists ({ to, selector,
// calldata }). Normalizes felt252 values to canonical decimal before comparing so
// hex ('0x123') and decimal ('291') representations of the same field element are
// treated as equal — the paymaster service may re-encode calldata in a different
// base than the caller submitted. Ported from PR #75's callsAreStrictlyEqual — #77.
function avnuCallsAreStrictlyEqual(a: AvnuCall[], b: AvnuCall[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y) return false;
    if (normalizeFelt(x.to) !== normalizeFelt(y.to)) return false;
    if (normalizeFelt(x.selector) !== normalizeFelt(y.selector)) return false;
    const xc = x.calldata ?? [];
    const yc = y.calldata ?? [];
    if (xc.length !== yc.length) return false;
    for (let j = 0; j < xc.length; j++) {
      if (normalizeFelt(xc[j]) !== normalizeFelt(yc[j])) return false;
    }
  }
  return true;
}

// Best-effort extraction of the calls embedded in the paymaster's SNIP-9/SNIP-12
// typed_data (the OutsideExecution calls). Two casings occur in the wild:
//   - CAPITALIZED SNIP-12 rev-1 — `message.Calls` with `{ To, Selector, Calldata }`.
//     This is what the LIVE AVNU server emits (validated on sepolia.paymaster.avnu.fi
//     2026-07-03, probe-result.json → sponsored-invoke-STRK). The shipped lowercase-only
//     reader missed it, so the #77 guard failed CLOSED on every real invoke_and_apply_action.
//   - lowercase — `message.calls` with `{ to, selector, calldata }` (older/mock shapes).
// Accept BOTH and normalize to the lowercase AvnuCall shape; the #77 comparison
// (avnuCallsAreStrictlyEqual) is unchanged — only the field-name casing is tolerated.
// The SNIP-12 signature is unaffected: signMessage hashes the type-declared fields, not
// our reading of them. Returns undefined when the shape carries no recognizable calls
// array, or any element lacks to/selector/calldata, so the caller can fail closed (never
// signing an unverifiable payload) rather than silently skipping the check.
function extractTypedDataCalls(typedData: unknown): AvnuCall[] | undefined {
  if (!typedData || typeof typedData !== 'object') return undefined;
  const message = (typedData as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return undefined;
  const raw = (message as { Calls?: unknown; calls?: unknown }).Calls ?? (message as { calls?: unknown }).calls;
  if (!Array.isArray(raw)) return undefined;
  const calls: AvnuCall[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') return undefined; // fail closed
    const entry = c as {
      To?: unknown;
      to?: unknown;
      Selector?: unknown;
      selector?: unknown;
      Calldata?: unknown;
      calldata?: unknown;
    };
    const to = entry.To ?? entry.to;
    const selector = entry.Selector ?? entry.selector;
    const calldata = entry.Calldata ?? entry.calldata ?? [];
    if (to === undefined || selector === undefined || !Array.isArray(calldata)) return undefined; // fail closed
    calls.push({ to: to as string, selector: selector as string, calldata: calldata as string[] });
  }
  return calls;
}

// STEP 2: execute the proven call via the AVNU relayer (carrying proof + proof_facts).
// For invoke_and_apply_action, signs the SNIP-9 typed_data from STEP 1. Returns
// { transaction_hash } like the manager path so submitAndTrack is unchanged.
export async function paymasterExecuteLeg(
  account: Account,
  call: Call,
  proofDetails: ProofDetails,
  ctx: PaymasterBuildCtx,
  opts?: { onRelayStart?: () => void },
): Promise<{ transaction_hash: string }> {
  // The executable apply_action repeats pool_address (required at execute time too).
  const applyAction: AvnuExecutableApplyAction = {
    pool_address: config.poolAddress,
    apply_actions_call: toAvnuCall(call),
    proof: proofDetails.proof ?? '',
    proof_facts: proofDetails.proofFacts ?? [],
  };

  if (ctx.type === 'invoke_and_apply_action') {
    if (!ctx.typedData) {
      throw new Error('AVNU buildTransaction returned no typed_data for invoke_and_apply_action.');
    }
    // SECURITY CHECK (#77 — re-introduces PR #75's callsAreStrictlyEqual, dropped in
    // the #73 rewrite): the calls embedded in the paymaster-controlled typed_data MUST
    // equal the calls we actually intended (ctx.userCalls, set by paymasterBuildLeg).
    // A malicious/buggy paymaster that swaps in different calls (e.g. drain-to-attacker)
    // must be rejected BEFORE we sign — signMessage on an unchecked payload would sign
    // whatever the server put there. Fail closed: an unrecognized/absent calls shape is
    // treated as a mismatch, not skipped.
    const typedDataCalls = extractTypedDataCalls(ctx.typedData);
    const expectedCalls = ctx.userCalls ?? [];
    if (!typedDataCalls || !avnuCallsAreStrictlyEqual(expectedCalls, typedDataCalls)) {
      throw new Error(
        'AVNU paymaster typed_data calls do not match the submitted userCalls — refusing to ' +
          'sign a tampered outside-execution payload (#77 calls-substitution guard).',
      );
    }
    // account.signMessage signs SNIP-12 typed data; formatSignature → felt string[].
    const sig = await account.signMessage(ctx.typedData as Parameters<Account['signMessage']>[0]);
    const signature = stark.formatSignature(sig);
    // Flag-flip boundary: signal RELAY start, NOT sign. Everything above (signMessage)
    // is a local wallet op that relays nothing — a rejection there is safely retryable.
    // Once executeTransaction is in flight the relayer may have queued the proven invoke,
    // so the caller treats this point on as ambiguous (non-retryable). Must be sync,
    // before the await.
    opts?.onRelayStart?.();
    const res = await executeTransaction(
      {
        transaction: {
          type: ctx.type,
          invoke: { user_address: account.address, typed_data: ctx.typedData, signature },
          apply_action: applyAction,
        },
        parameters: ctx.parameters,
      },
      ctx.opts,
    );
    return { transaction_hash: res.transaction_hash };
  }
  // Symmetry with the invoke branch: signal relay start (harmless — no signMessage here).
  opts?.onRelayStart?.();
  const res = await executeTransaction(
    { transaction: { type: ctx.type, apply_action: applyAction }, parameters: ctx.parameters },
    ctx.opts,
  );
  return { transaction_hash: res.transaction_hash };
}

// Submits a proof-bearing pool call via the AVNU PRIVATE paymaster: AVNU's relayer
// is the on-chain sender (carrying proof + proof_facts), so neither the derived
// account nor a shared manager appears as the submitter — closing the Starknet-side
// linkage (docs/threat-model.md).
//
// This all-in-one variant builds → (guards) → executes with a proof that was already
// generated. It CANNOT inject the pool fee into that pre-built proof, so it GUARDS on a
// non-zero fee_action and fails clearly. It is a defensive fallback only: the live legs
// (deposit / bridgeOut / bridgeBack) DO bake the fee — each calls paymasterBuildLeg →
// injects the fee withdraw into its USDC `.with()` block → proves → paymasterExecuteLeg
// directly, so they never route here (register defers to the deposit's autoRegister).
// Zero-fee legs proceed.
export async function submitProvenViaPaymaster(
  account: Account,
  call: Call,
  proofDetails: ProofDetails,
  leg: ProvenLeg = {},
): Promise<{ transaction_hash: string }> {
  const ctx = await paymasterBuildLeg(account, leg);

  // GUARD: in EVERY fee mode the `fee_action` is a Withdraw the user MUST include in
  // the proof — the forwarder collects the pool fee from that `TransferTo` action, and
  // submitting without it fails with AVNU error 165 (MISSING_FEE_TRANSFER_TO). The
  // proof here is already built, so we can't inject it; fail clearly. (`sponsored`
  // only fixes the fee token to STRK — it does NOT waive the fee.) See
  // open-questions.md #13 / AVNU's private-transactions doc. A zero fee_action proceeds.
  if (ctx.feeAction && BigInt(ctx.feeAction.amount || '0') !== 0n) {
    throw new Error(
      `AVNU paymaster fee_action is non-zero (${ctx.feeAction.amount} of ${ctx.feeAction.token}). ` +
        'The pool fee must be baked into the privacy proof as a withdraw to the forwarder (AVNU collects ' +
        'it from that TransferTo action) — not yet wired for this leg. See open-questions.md #13.',
    );
  }
  return paymasterExecuteLeg(account, call, proofDetails, ctx, { onRelayStart: leg.onRelayStart });
}

// Submits a proof-bearing pool call (apply_actions). When the AVNU paymaster is
// configured, routes through the PRIVATE paymaster (submitProvenViaPaymaster) so
// AVNU's relayer is the unlinkable submitter. Otherwise falls back to the
// MANAGER-paid path: the MANAGER account (config.admin) is the SENDER/fee-payer —
// NOT `userAccount`, which is kept STRK-free — forwarding proof/proofFacts AND
// explicit real-fee v3 resourceBounds + tip 0 so (a) starknet's proof-less fee
// estimate is skipped (the proof rides on the one invoke) and (b) the bounds are
// sized for a real on-chain apply_actions.
//
// `userAccount` is the derived account: the SIGNER on the paymaster path, and a
// no-op sender on the manager path (its identity rides in the proven `call`'s
// calldata, which is why a different sender is sound — see the header). `leg`
// describes the AVNU tx type + any user calls; ignored on the manager path.
export async function submitProvenCall(
  provider: RpcProvider,
  userAccount: Account,
  call: Call,
  proofDetails: ProofDetails,
  leg: ProvenLeg = {},
): Promise<{ transaction_hash: string }> {
  if (config.paymaster) {
    return submitProvenViaPaymaster(userAccount, call, proofDetails, leg);
  }
  const resourceBounds = await buildProofResourceBounds(provider);
  // Route through managerExecute so this proven invoke shares the manager's
  // serialized, locally-sequenced nonce with the flow's other manager txs (the
  // fee-approves) — preventing the back-to-back nonce collision (code 52).
  return managerExecute(provider, call, { tip: 0n, resourceBounds, ...proofDetails });
}
