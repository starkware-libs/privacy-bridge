// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// Unified, direction-agnostic status + resume surface for BOTH bridge directions
// (Phase 1 shared engine). ONE reader across all five
// persisted in-flight cursors that tells the app whether an interrupted transfer is
// waiting for this identity, and ONE thin router that drives the EXISTING
// resume-capable orchestrator for that phase to completion. Phase 2 (the apps) wires
// its Continue / auto-continue UI onto these — this module starts NO new transfer and
// re-parses NO localStorage inline (it reuses each owning module's validated reader).
//
// Secret hygiene: no keys here. The raw signature is passed straight through to the
// orchestrators (in-memory only, never logged/persisted).

import type { EthereumProvider } from '../lib/ethereum';
import { readPendingPoolDeposit } from './poolDepositCursor';
import { peekInflightDeposit } from './depositIn';
import { peekInflightReturn, recoverBridgeIn } from './returnIn';
import { peekInflightBurn, peekInflightCashOut } from './bridgeOut';
import { moveIntoPool } from './moveIntoPool';
// recoverBridgeIn now lives in returnIn.ts (folded return) — imported above.
import { readUndepositedResidual, RESIDUAL_DUST_THRESHOLD_WEI } from './residual';

export type BridgeDirection = 'into-pool' | 'from-pool';
export type BridgePhase =
  | 'cctp-mint-in'
  | 'pool-deposit'
  | 'return-to-pool'
  | 'cctp-mint-out'
  | 'cash-out';

export interface BridgeTransferStatus {
  direction: BridgeDirection;
  phase: BridgePhase;
  // true ⇒ a NEW wallet tx/approval (e.g. a burn) is required to finish; false ⇒ safe
  // to auto-continue (only the already-available identity signature is needed).
  needsSignature: boolean;
  // The amount already committed to this transfer (deposit-token base units).
  amountWei: bigint;
  account: { snAddress?: string; evmAddress?: string };
  // The per-account index the IN-FLIGHT cursor was written under, when the cursor
  // carries it (currently return-to-pool). AUTHORITATIVE for resume: the commitment
  // is re-derived from (signature, accountIndex), so a resume MUST use THIS index —
  // not whatever account the UI has since selected — or it re-derives a different
  // commitment and acts on the wrong account (silent no-op / wrong claim).
  accountIndex?: number;
}

// needsSignature determination — per phase, from the resume path each orchestrator
// takes (see the modules cited). ALL FIVE current cursors persist a POST-burn /
// POST-withdraw state: the one irreversible, wallet-signed value-moving step (the CCTP
// burn, or the pool withdraw+burn) has ALREADY committed before the cursor is written.
// What remains is attest+mint or a proven pool tx — driven by the derived SN key
// (re-derivable from the already-available identity signature), a paymaster/manager, or
// Circle's Forwarding Service — none of which requests a NEW wallet signature/approval.
// So needsSignature is FALSE for every phase today; the field stays for a FUTURE cursor
// that would persist a PRE-burn state (which would need a new user-signed tx to finish):
//   - cctp-mint-in  : a continue that passes resumeOnly (depositIn.ts) finishes attest +
//                     mint off the persisted burn tx and THROWS rather than reaching the
//                     fresh path — approve/burn/switchChain are unreachable by construction.
//   - pool-deposit  : moveIntoPool resume short-circuit / deposit-live-balance
//                     (moveIntoPool.ts) — funds already minted; depositToPool is a proven
//                     pool tx (paymaster/manager), no wallet approval.
//   - return-to-pool: recoverBridgeIn (returnIn.ts) re-derives the commitment + claims
//                     via a proven pool tx — the EVM return burn is already done.
//   - cctp-mint-out : fundAccountFromPool resume "RESUME from attest, SKIP the re-sign +
//                     burn" (bridgeOut.ts) — resolveSignature is never called on resume.
//   - cash-out      : cashOut resume path (bridgeOut.ts ~L1051) — resolveSignature never
//                     called; attest+mint only.
const NEEDS_SIGNATURE = false;

// Single reader across ALL cursors for one identity, or null when nothing is in flight.
// Deterministic priority — the MOST-ADVANCED leg wins so a resume never re-does a
// completed sub-leg: pool-deposit > cctp-mint-in (into-pool) and cash-out > cctp-mint-out
// (from-pool). WIRED phases outrank DEFERRED ones, so the independent return-to-pool flow
// ranks ABOVE the from-pool pair (both deferred): when a wired and a deferred cursor
// coexist, surface the one the unified resume can actually complete (F-D). Concurrent
// cursors from DIFFERENT directions are not expected in practice (a device runs one
// transfer at a time); the fixed order below makes even that case deterministic.
// Best-effort + fail-closed: never throws (each underlying reader is corrupt-/disabled-
// localStorage-safe, and the whole body is wrapped defensively).
export function getBridgeTransferStatus(p: {
  snAddress?: string;
  evmAddress?: string;
}): BridgeTransferStatus | null {
  const { snAddress, evmAddress } = p;
  try {
    // 1. pool-deposit (into-pool, most advanced) — keyed by the derived SN account.
    const poolDep = snAddress ? readPendingPoolDeposit(snAddress) : null;
    if (poolDep) {
      return {
        direction: 'into-pool',
        phase: 'pool-deposit',
        needsSignature: NEEDS_SIGNATURE,
        amountWei: poolDep.netWei,
        account: { snAddress, evmAddress },
      };
    }

    // 2. cctp-mint-in (into-pool) — keyed by the EVM funder.
    const dep = peekInflightDeposit(evmAddress);
    if (dep) {
      return {
        direction: 'into-pool',
        phase: 'cctp-mint-in',
        needsSignature: NEEDS_SIGNATURE,
        amountWei: dep.netWei,
        account: { snAddress: snAddress ?? dep.snRecipient, evmAddress },
      };
    }

    // 3. return-to-pool (into-pool, independent flow) — keyed by the EVM account.
    // Ranked ABOVE the from-pool cursors below because it is WIRED (resumeBridgeTransfer
    // drives it via recoverBridgeIn), whereas cash-out / cctp-mint-out are DEFERRED
    // (throw NOT_YET_RESUMABLE). When a wired and a deferred cursor coexist, surface the
    // one the unified path can actually complete (F-D). Carries accountIndex —
    // authoritative for the commitment re-derivation on resume (F-A/F-B).
    const ret = peekInflightReturn(evmAddress);
    if (ret) {
      return {
        direction: 'into-pool',
        phase: 'return-to-pool',
        needsSignature: NEEDS_SIGNATURE,
        amountWei: ret.amountWei,
        account: { snAddress, evmAddress },
        accountIndex: ret.accountIndex,
      };
    }

    // 4. cash-out (from-pool, most advanced of the from-pool pair) — keyed by the EVM
    // account. DEFERRED phase (resume driven by the app, not the router).
    const cash = peekInflightCashOut(evmAddress);
    if (cash) {
      return {
        direction: 'from-pool',
        phase: 'cash-out',
        needsSignature: NEEDS_SIGNATURE,
        amountWei: cash.amountWei,
        account: { snAddress, evmAddress },
      };
    }

    // 5. cctp-mint-out (from-pool, account funding) — keyed by the EVM account. DEFERRED.
    const burn = peekInflightBurn(evmAddress);
    if (burn) {
      return {
        direction: 'from-pool',
        phase: 'cctp-mint-out',
        needsSignature: NEEDS_SIGNATURE,
        amountWei: burn.amountWei,
        account: { snAddress, evmAddress: evmAddress ?? burn.eoaAddress },
      };
    }

    return null;
  } catch {
    // Fail-closed: a disabled/corrupt localStorage reads as "nothing in flight".
    return null;
  }
}

// Chain-aware detector: the cursor reader above only sees THIS browser's localStorage,
// so a fresh browser / cleared storage / different device would miss an interrupted
// pool deposit whose CCTP mint already landed (undeposited residual on the derived SN
// account). This async variant falls back to a public on-chain balance read when no
// cursor is present, surfacing a synthesized pool-deposit status so the app offers
// Continue. The cursor always wins (no chain read on the hot path). moveIntoPool keeps
// its OWN fail-closed on the same residual (residual.ts), so a missed UI hint here can
// never cause a double-burn — hence the fail-SAFE catch (a chain-read error → null).
export async function getBridgeTransferStatusAsync(p: {
  snAddress?: string;
  evmAddress?: string;
}): Promise<BridgeTransferStatus | null> {
  const cursor = getBridgeTransferStatus(p); // sync, corrupt-/disabled-storage-safe
  if (cursor) return cursor; // cursor wins; NO chain read on the hot path
  if (!p.snAddress) return null;
  try {
    const residual = await readUndepositedResidual(p.snAddress);
    if (residual > RESIDUAL_DUST_THRESHOLD_WEI) {
      return {
        direction: 'into-pool',
        phase: 'pool-deposit',
        needsSignature: NEEDS_SIGNATURE,
        amountWei: residual,
        account: { snAddress: p.snAddress, evmAddress: p.evmAddress },
      };
    }
    return null;
  } catch {
    // FAIL-SAFE: a chain-read error must never crash the modal. moveIntoPool keeps its own
    // fail-closed (residual.ts), so a missed UI hint never causes a double-burn.
    return null;
  }
}

// Thin ROUTER — NEVER starts a new transfer. Routes by status.phase to the EXISTING
// resume-capable orchestrator and drives it to completion. Fail-closed: a phase we
// cannot confidently wire from the current code throws NOT_YET_RESUMABLE rather than
// guess a value-moving call.
//
// WIRED:
//   - pool-deposit / cctp-mint-in → moveIntoPool({ ..., resume: true }). The pending
//     pool-deposit cursor is auto-consumed (deposit the live balance, no re-fund); a
//     cctp-mint-in cursor is resumed inside fundFromMetaMask (attest+mint, never
//     re-burns) and then deposited. NB: this into-pool composite structurally requires
//     the EVM `provider` (moveIntoPool.fundDepositToken resolves the funder through it)
//     even though NO new wallet signature is requested — pass it through.
//   - return-to-pool → recoverBridgeIn({ signature, accountIndex }). Deterministic +
//     idempotent: re-derives the commitment from the signature and claims a
//     bound-but-unclaimed balance. Requires accountIndex (fail-closed if absent).
//
// DEFERRED (throw NOT_YET_RESUMABLE):
//   - cctp-mint-out → fundAccountFromPool needs an APP-INJECTED resolveDepositWallet
//     (Polymarket CREATE2 lookup) that bridge-core deliberately does not own.
//   - cash-out → cashOut's resume branch matches on the cursor's exact destination and
//     needs amount/resolveSignature the router's minimal args don't carry.
// Both stay driveable by the app (Phase 2) with their full context; wiring them here
// off partial inputs would risk a mis-sized or mis-routed value move.
export async function resumeBridgeTransfer(p: {
  status: BridgeTransferStatus;
  signature: `0x${string}`;
  accountIndex?: number;
  provider?: unknown;
  onStep?: (step: string, status: string, detail?: string) => void;
}): Promise<{ completed: boolean; amountWei: bigint }> {
  const { status, signature, accountIndex, provider, onStep } = p;

  switch (status.phase) {
    case 'pool-deposit':
    case 'cctp-mint-in': {
      const { depositedNetWei } = await moveIntoPool({
        signature,
        funding: 'metamask',
        // The deposited amount is re-derived from the cursor/live balance on resume; the
        // committed net just has to clear moveIntoPool's > 0 guard.
        amountWei: status.amountWei > 0n ? status.amountWei : 1n,
        provider: provider as EthereumProvider | undefined,
        resume: true,
        onStep,
      });
      return { completed: true, amountWei: depositedNetWei };
    }

    case 'return-to-pool': {
      // AUTHORITATIVE index is the one the cursor was written under (status.accountIndex),
      // NOT whatever account the UI has since selected — the commitment is re-derived from
      // (signature, accountIndex), so using the caller's current index would target the
      // wrong account (F-A/F-B). Fall back to the caller's only if the status lacks it.
      const idx = status.accountIndex ?? accountIndex;
      if (idx === undefined) {
        throw new Error(
          'resumeBridgeTransfer: return-to-pool resume requires accountIndex (the ' +
            'commitment is re-derived from signature + accountIndex).',
        );
      }
      const { stuck, claimTxHash } = await recoverBridgeIn({
        signature,
        accountIndex: idx,
        onStatus: (m) => onStep?.('return-to-pool', 'running', m),
      });
      return { completed: claimTxHash !== undefined, amountWei: stuck };
    }

    case 'cctp-mint-out':
    case 'cash-out': {
      const err = new Error(
        `resumeBridgeTransfer: '${status.phase}' resume is not yet wired in bridge-core ` +
          '— it needs app-injected context (deposit-wallet resolver / destination) the ' +
          'router does not carry. Resume it from the app orchestrator.',
      ) as Error & { code: 'NOT_YET_RESUMABLE'; phase: BridgePhase };
      err.code = 'NOT_YET_RESUMABLE';
      err.phase = status.phase;
      throw err;
    }

    default: {
      // Exhaustiveness guard — a new phase must be routed explicitly, never silently
      // dropped (fail-closed).
      const exhaustive: never = status.phase;
      throw new Error(`resumeBridgeTransfer: unhandled phase ${String(exhaustive)}`);
    }
  }
}
